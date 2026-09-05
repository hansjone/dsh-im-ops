import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  enrichWhatsappInboundIdentities,
  isWhatsappLidJid,
  rememberWhatsappLidPnPairs,
} from '../../../src/channels/whatsapp/whatsapp-identity.mjs';

describe('whatsapp-identity', () => {
  it('recognizes lid jids', () => {
    assert.equal(isWhatsappLidJid('91010910658657@lid'), true);
    assert.equal(isWhatsappLidJid('8618142387786@s.whatsapp.net'), false);
  });

  it('remembers lid/pn pairs from message keys', () => {
    const cache = new Map();
    rememberWhatsappLidPnPairs(cache, {
      participant: '91010910658657@lid',
      participantAlt: '8618142387786@s.whatsapp.net',
    });
    assert.equal(cache.get('91010910658657'), '8618142387786@s.whatsapp.net');
  });

  it('enriches group sender aliases and mentions from lid mapping', async () => {
    const cache = new Map();
    const socket = {
      signalRepository: {
        lidMapping: {
          async getPNForLID(lid) {
            if (lid === '91010910658657@lid') return '8618142387786@s.whatsapp.net';
            if (lid === '111222333444555@lid') return '8615601877957@s.whatsapp.net';
            return null;
          },
          async getLIDForPN(pn) {
            if (pn === '8615601877957@s.whatsapp.net') return '111222333444555@lid';
            return null;
          },
        },
      },
    };
    const raw = {
      key: {
        remoteJid: '120363429229984366@g.us',
        participant: '91010910658657@lid',
        id: 'msg-1',
        fromMe: false,
      },
      message: {
        extendedTextMessage: {
          text: '@bot hello',
          contextInfo: { mentionedJid: ['111222333444555@lid'] },
        },
      },
    };
    const normalized = {
      messageId: 'g:msg-1',
      providerMessageId: 'msg-1',
      senderId: '91010910658657@lid',
      senderAlternateId: '',
      kind: 'group',
      conversationId: '120363429229984366@g.us',
      content: '@bot hello',
      addressed: false,
    };
    const enriched = await enrichWhatsappInboundIdentities(normalized, raw, {
      accountJid: '8615601877957@s.whatsapp.net',
      socket,
      lidPnCache: cache,
    });
    assert.equal(enriched.addressed, true);
    assert.ok(enriched.senderAliasIds.includes('8618142387786@s.whatsapp.net'));
  });
});
