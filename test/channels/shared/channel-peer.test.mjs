import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  formatChannelPeerLabel,
  lidFromWhatsappIdentity,
  parseConversationKey,
  resolveChannelPeerFromBinding,
  resolveContactIdentity,
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
    contacts: [{
      phone: '8618222222222',
      lids: ['91010910658657@lid'],
      pushName: 'Alice',
    }],
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

  const lidDirect = resolveChannelPeerFromBinding({
    channel: 'whatsapp',
    botId: 'bot-1',
    conversationKey: 'direct:91010910658657@lid',
    grant,
  });
  assert.equal(lidDirect.label, 'Alice · 8618222222222');
  assert.equal(lidDirect.phone, '8618222222222');
  assert.doesNotMatch(lidDirect.label, /@lid/);

  const groupUser = resolveChannelPeerFromBinding({
    channel: 'whatsapp',
    botId: 'bot-1',
    conversationKey: 'group:120363@g.us:user:91010910658657@lid',
    grant,
  });
  assert.equal(groupUser.label, 'Ops Room · Alice · 8618222222222');
  assert.equal(groupUser.groupTitle, 'Ops Room');
  assert.doesNotMatch(groupUser.label, /@lid/);

  const groupShared = resolveChannelPeerFromBinding({
    channel: 'whatsapp',
    botId: 'bot-1',
    conversationKey: 'group:120363@g.us',
    grant,
  });
  assert.equal(groupShared.label, 'Ops Room');
});

test('resolveChannelPeerFromBinding never falls back to raw LID when contact is incomplete', () => {
  const grant = {
    contacts: [{ lids: ['91010910658657@lid'], pushName: 'Bob' }],
    groups: {
      '120363@g.us': { title: 'test2', admins: [], members: [] },
    },
  };
  const direct = resolveChannelPeerFromBinding({
    channel: 'whatsapp',
    botId: 'bot-1',
    conversationKey: 'direct:91010910658657@lid',
    grant,
  });
  assert.equal(direct.label, 'Bob');
  assert.equal(direct.phone, null);

  const unknown = resolveChannelPeerFromBinding({
    channel: 'whatsapp',
    botId: 'bot-1',
    conversationKey: 'direct:111222333444@lid',
    grant,
  });
  assert.equal(unknown, null);

  const groupOnlyLid = resolveChannelPeerFromBinding({
    channel: 'whatsapp',
    botId: 'bot-1',
    conversationKey: 'group:120363@g.us:user:111222333444@lid',
    grant,
  });
  assert.equal(groupOnlyLid.label, 'test2');
  assert.doesNotMatch(groupOnlyLid.label, /@lid|\d{10,}@/);
});

test('lid and label helpers stay human-facing', () => {
  assert.equal(lidFromWhatsappIdentity('91010910658657@lid'), '91010910658657@lid');
  assert.equal(lidFromWhatsappIdentity('91010910658657:12@lid'), '91010910658657@lid');
  assert.equal(lidFromWhatsappIdentity('8618222222222@s.whatsapp.net'), null);
  assert.equal(formatChannelPeerLabel('Ops', '', '8618', null), 'Ops · 8618');
  assert.deepEqual(
    resolveContactIdentity({
      contacts: [{ phone: '8618', lids: ['9@lid'], pushName: 'N' }],
    }, '9@lid'),
    { phone: '8618', pushName: 'N' },
  );
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
