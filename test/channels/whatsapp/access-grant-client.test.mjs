import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSnapshot } from '../../../plugin-src/client/channels/whatsapp/api.js';

test('WhatsApp normalizeBot keeps accessGrant, groupSessionScope, and contacts', () => {
  const snapshot = normalizeSnapshot({
    revision: 1,
    bots: [{
      botId: 'wa-1',
      connected: true,
      state: 'connected',
      workspace: '/tmp/ws',
      groupSessionScope: 'user_in_chat',
      accessGrant: {
        version: 1,
        globalAdmins: ['8618111111111'],
        directMembers: [{ phone: '8618222222222', canExecuteCommands: true }],
        groups: {
          '120363111111111111@g.us': {
            title: 'Ops',
            admins: [],
            members: [{ phone: '8618333333333', canExecuteCommands: true }],
          },
        },
        pending: [{
          id: 'p_test01',
          kind: 'group',
          groupJid: '120363111111111111@g.us',
          phone: '8618444444444',
          createdAt: '2026-01-01T00:00:00.000Z',
          status: 'pending',
          unresolved: false,
          notifyRefs: [],
        }],
        contacts: [{
          phone: '8618444444444',
          lids: [],
          pushName: 'Alice',
          lastSeenAt: '2026-01-01T00:00:00.000Z',
          scenes: ['group'],
          groupJids: ['120363111111111111@g.us'],
        }],
      },
      bot: { name: 'Bot', idMasked: '+86***' },
      health: { summary: 'ok' },
    }],
  });

  const bot = snapshot.bots[0];
  assert.equal(bot.groupSessionScope, 'user_in_chat');
  assert.deepEqual(bot.accessGrant.globalAdmins, ['8618111111111']);
  assert.equal(bot.accessGrant.directMembers[0].phone, '8618222222222');
  assert.ok(bot.accessGrant.groups['120363111111111111@g.us']);
  assert.equal(bot.accessGrant.contacts[0].phone, '8618444444444');
  assert.equal(bot.accessGrant.pending[0].id, 'p_test01');
});
