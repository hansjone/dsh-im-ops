import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWhatsappGroupSubject } from '../../../src/channels/whatsapp/whatsapp-identity.mjs';

test('resolveWhatsappGroupSubject reads Baileys groupMetadata.subject', async () => {
  const subject = await resolveWhatsappGroupSubject({
    groupMetadata: async (jid) => {
      assert.equal(jid, '120363429229984366@g.us');
      return { subject: '  运维值班群  ' };
    },
  }, '120363429229984366@g.us');
  assert.equal(subject, '运维值班群');
});

test('resolveWhatsappGroupSubject fails soft without socket metadata', async () => {
  assert.equal(await resolveWhatsappGroupSubject(null, '120363429229984366@g.us'), '');
  assert.equal(await resolveWhatsappGroupSubject({
    groupMetadata: async () => { throw new Error('offline'); },
  }, '120363429229984366@g.us'), '');
});
