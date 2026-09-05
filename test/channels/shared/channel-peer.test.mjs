import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  parseConversationKey,
  resolveChannelPeerFromBinding,
} from '../../../src/channels/shared/channel-peer.mjs';
import { ConversationStateStore } from '../../../src/channels/shared/conversation-state-store.mjs';

test('parseConversationKey covers direct, shared group, and per-user group', () => {
  assert.deepEqual(parseConversationKey('direct:8618111111111@s.whatsapp.net'), {
    kind: 'direct',
    conversationId: '8618111111111@s.whatsapp.net',
    senderId: null,
  });
  assert.deepEqual(parseConversationKey('group:120363@g.us'), {
    kind: 'group',
    conversationId: '120363@g.us',
    senderId: null,
  });
  assert.deepEqual(parseConversationKey('group:120363@g.us:user:8618222222222@s.whatsapp.net'), {
    kind: 'group',
    conversationId: '120363@g.us',
    senderId: '8618222222222@s.whatsapp.net',
  });
  assert.equal(parseConversationKey(''), null);
  assert.equal(parseConversationKey('other:x'), null);
});

test('resolveChannelPeerFromBinding builds DM and group labels from access grant', () => {
  const grant = {
    contacts: [{ phone: '8618222222222', pushName: 'Alice' }],
    groups: {
      '120363@g.us': { title: 'Ops Room', admins: [], members: [] },
    },
  };
  const direct = resolveChannelPeerFromBinding({
    channel: 'whatsapp',
    botId: 'bot-1',
    conversationKey: 'direct:8618222222222@s.whatsapp.net',
    grant,
  });
  assert.equal(direct.label, 'Alice · 8618222222222');
  assert.equal(direct.kind, 'direct');
  assert.equal(direct.phone, '8618222222222');

  const groupUser = resolveChannelPeerFromBinding({
    channel: 'whatsapp',
    botId: 'bot-1',
    conversationKey: 'group:120363@g.us:user:8618222222222@s.whatsapp.net',
    grant,
  });
  assert.equal(groupUser.label, 'Ops Room · Alice');
  assert.equal(groupUser.groupTitle, 'Ops Room');

  const groupShared = resolveChannelPeerFromBinding({
    channel: 'whatsapp',
    botId: 'bot-1',
    conversationKey: 'group:120363@g.us',
    grant,
  });
  assert.equal(groupShared.label, '群 · Ops Room');
});

test('ConversationStateStore.keyForSession reverses session bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-channel-peer-'));
  try {
    const store = await new ConversationStateStore(join(root, 'state.json')).load();
    await store.setSession('direct:u1', 'session-a');
    await store.setSession('group:g1:user:u2', 'session-b');
    assert.equal(store.keyForSession('session-a'), 'direct:u1');
    assert.equal(store.keyForSession('session-b'), 'group:g1:user:u2');
    assert.equal(store.keyForSession('missing'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
