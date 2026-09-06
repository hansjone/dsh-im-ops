import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conversationKeyMatchesTarget,
  conversationKeysFromDeliveryTarget,
} from '../src/channels/shared/delivery-session-keys.mjs';
import { createImHostPlugin } from '../plugin-src/host/index.mjs';

const CHANNELS = [
  ['feishu', 'applyFeishu'],
  ['weixin', 'applyWeixin'],
  ['dingtalk', 'applyDingtalk'],
  ['wecom', 'applyWecom'],
  ['qq', 'applyQq'],
  ['slack', 'applySlack'],
  ['telegram', 'applyTelegram'],
  ['discord', 'applyDiscord'],
  ['whatsapp', 'applyWhatsapp'],
  ['office', 'applyOffice'],
];

test('conversationKeysFromDeliveryTarget maps WhatsApp DM and group routes', () => {
  assert.deepEqual(
    conversationKeysFromDeliveryTarget({
      kind: 'user',
      route: { jid: '8613800000000@s.whatsapp.net' },
    }),
    ['direct:8613800000000@s.whatsapp.net'],
  );
  assert.deepEqual(
    conversationKeysFromDeliveryTarget({
      kind: 'group',
      route: { jid: '120363@g.us' },
    }),
    ['group:120363@g.us'],
  );
});

test('conversationKeyMatchesTarget accepts shared and per-user group keys', () => {
  const target = { kind: 'group', route: { jid: '120363@g.us' } };
  assert.equal(conversationKeyMatchesTarget('group:120363@g.us', target), true);
  assert.equal(
    conversationKeyMatchesTarget('group:120363@g.us:user:86138@s.whatsapp.net', target),
    true,
  );
  assert.equal(conversationKeyMatchesTarget('direct:86138@s.whatsapp.net', target), false);
});

test('dshIm resolveConversationSession and resolveTargetSession use registered lookups', async () => {
  const targets = [
    { targetId: 'wa-dm', kind: 'user', route: { jid: '86138@s.whatsapp.net' } },
    { targetId: 'ops-group', kind: 'group', route: { jid: '120363@g.us' } },
  ];
  const deliveryService = {
    async send() { return { sent: true }; },
    async listTargets(botId) {
      return { botId, channel: 'whatsapp', targets };
    },
    async listCatalog() { return { bots: [] }; },
    async createTarget() { return {}; },
  };
  const provided = [];
  const internals = Object.fromEntries(CHANNELS.map(([, applyName]) => [
    applyName,
    async () => {},
  ]));
  Object.assign(internals, {
    createDeliveryService: () => deliveryService,
    installUpdateRpc: () => {},
    installDeliveryRpc: () => {},
    installDeliveryHttp: () => {},
  });
  const ctx = {
    connection: { rpc: {} },
    webServer: { register() {} },
    effect() {},
    provide: (...args) => provided.push(args),
  };

  await createImHostPlugin(internals).apply(ctx, { rpcAuthority: 'trusted-host' });
  const dshIm = provided[0][1];

  const resolve = async (botId, conversationKey) => {
    if (botId === 'bot_1' && conversationKey === 'direct:86138@s.whatsapp.net') {
      return 'sess-dm';
    }
    return null;
  };
  resolve.findByTarget = async (botId, target) => {
    if (botId === 'bot_1' && target?.targetId === 'ops-group') {
      return {
        conversationKey: 'group:120363@g.us:user:alice@lid',
        sessionId: 'sess-group-user',
      };
    }
    return null;
  };
  dshIm.registerConversationSessionResolver(resolve);

  assert.deepEqual(
    await dshIm.resolveConversationSession('bot_1', 'direct:86138@s.whatsapp.net'),
    {
      sessionId: 'sess-dm',
      botId: 'bot_1',
      conversationKey: 'direct:86138@s.whatsapp.net',
    },
  );
  assert.deepEqual(
    await dshIm.resolveTargetSession('bot_1', 'wa-dm'),
    {
      sessionId: 'sess-dm',
      botId: 'bot_1',
      conversationKey: 'direct:86138@s.whatsapp.net',
    },
  );
  assert.deepEqual(
    await dshIm.resolveTargetSession('bot_1', 'ops-group'),
    {
      sessionId: 'sess-group-user',
      botId: 'bot_1',
      conversationKey: 'group:120363@g.us:user:alice@lid',
    },
  );
  assert.equal(await dshIm.resolveTargetSession('bot_1', 'missing'), null);
});
