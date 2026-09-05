import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveWhatsappGroupSubject,
  resolveWhatsappGroupSubjects,
} from '../../../src/channels/whatsapp/whatsapp-identity.mjs';

test('resolveWhatsappGroupSubject reads Baileys groupMetadata.subject', async () => {
  const subject = await resolveWhatsappGroupSubject({
    groupMetadata: async (jid) => {
      assert.equal(jid, '120363429229984366@g.us');
      return { subject: '  运维值班群  ' };
    },
  }, '120363429229984366@g.us');
  assert.equal(subject, '运维值班群');
});

test('resolveWhatsappGroupSubject falls back to groupFetchAllParticipating', async () => {
  const subject = await resolveWhatsappGroupSubject({
    groupMetadata: async () => {
      throw new Error('forbidden');
    },
    groupFetchAllParticipating: async () => ({
      '120363429229984366@g.us': { id: '120363429229984366@g.us', subject: '告警群' },
    }),
  }, '120363429229984366@g.us');
  assert.equal(subject, '告警群');
});

test('resolveWhatsappGroupSubjects batch-fills missing titles', async () => {
  const titles = await resolveWhatsappGroupSubjects({
    groupFetchAllParticipating: async () => ({
      '120363429229984366@g.us': { id: '120363429229984366@g.us', subject: 'A群' },
      '120363111111111111@g.us': { id: '120363111111111111@g.us', subject: 'B群' },
    }),
  }, ['120363429229984366@g.us', '120363111111111111@g.us']);
  assert.deepStrictEqual(titles, {
    '120363429229984366@g.us': 'A群',
    '120363111111111111@g.us': 'B群',
  });
});

test('resolveWhatsappGroupSubject fails soft without socket metadata', async () => {
  assert.equal(await resolveWhatsappGroupSubject(null, '120363429229984366@g.us'), '');
  assert.equal(await resolveWhatsappGroupSubject({
    groupMetadata: async () => { throw new Error('offline'); },
  }, '120363429229984366@g.us'), '');
});
