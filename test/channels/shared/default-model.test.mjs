import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  catalogHasModel,
  defaultModelKey,
  normalizeDefaultModel,
  normalizeModelCatalog,
  validateDefaultModel,
} from '../../../src/channels/shared/default-model.mjs';
import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
} from '../../../src/channels/shared/bot-workspace-store.mjs';

test('normalizeDefaultModel accepts object and provider/model strings', () => {
  assert.deepEqual(normalizeDefaultModel({ provider: 'deepseek', model: 'chat' }), {
    provider: 'deepseek',
    model: 'chat',
  });
  assert.deepEqual(normalizeDefaultModel('openai/gpt-4.1'), {
    provider: 'openai',
    model: 'gpt-4.1',
  });
  assert.equal(normalizeDefaultModel(''), null);
  assert.equal(normalizeDefaultModel({ provider: '', model: 'x' }), null);
  assert.equal(defaultModelKey({ provider: 'a', model: 'b' }), 'a/b');
});

test('validateDefaultModel rejects junk', () => {
  assert.equal(validateDefaultModel(null), null);
  assert.throws(() => validateDefaultModel({ provider: 'x' }), (error) => (
    error.code === 'default-model-invalid'
  ));
});

test('model catalog helpers flatten groups', () => {
  const catalog = normalizeModelCatalog({
    groups: [{
      id: 'deepseek',
      name: 'DeepSeek',
      models: [{ id: 'chat', name: 'Chat' }, { id: 'reasoner', name: 'Reasoner' }],
    }],
    failures: [],
  });
  assert.equal(catalog.items.length, 2);
  assert.equal(catalogHasModel(catalog, 'deepseek/chat'), true);
  assert.equal(catalogHasModel(catalog, 'deepseek/missing'), false);
});

test('BotWorkspaceStore persists and applies default model on createSession', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-default-model-'));
  try {
    const store = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
      defaultWorkspace: root,
    }).load();
    await store.ensure('bot-a');
    await store.setDefaultModel('bot-a', { provider: 'deepseek', model: 'chat' });
    assert.deepEqual(store.defaultModelFor('bot-a'), {
      provider: 'deepseek',
      model: 'chat',
    });

    const selected = [];
    const harness = {
      async createSession() { return 'session-1'; },
      async selectSessionModel(sessionId, selection) {
        selected.push({ sessionId, selection });
        return { selected: selection };
      },
    };
    const state = {
      async clearSessions() {},
      sessionFor() { return null; },
      async setSession() { return true; },
    };
    const scoped = createBotWorkspaceScope(harness, {
      botId: 'bot-a',
      workspaces: store,
      state,
    });
    const sessionId = await scoped.harness.createSession();
    assert.equal(sessionId, 'session-1');
    assert.deepEqual(selected, [{
      sessionId: 'session-1',
      selection: { provider: 'deepseek', model: 'chat' },
    }]);

    await store.setDefaultModel('bot-a', null);
    assert.equal(store.defaultModelFor('bot-a'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
