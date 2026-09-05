import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approverPhonesForPending,
  emptyAccessGrant,
  enqueueAccessPending,
  ensureOwnerGlobalAdmin,
  evaluateAccessGrant,
  findPendingByNotifyMessageId,
  formatPendingNotifyBody,
  migrateAccessPolicyToGrant,
  normalizeAccessPhone,
  parseApprovalIntent,
  parsePendingIdFromNotifyText,
  resolveAccessPending,
  upsertAccessContact,
  validateAccessGrant,
} from '../../../src/channels/shared/access-grant.mjs';

const GROUP_A = '120363111111111111@g.us';
const GROUP_B = '120363222222222222@g.us';

function grant(overrides = {}) {
  return validateAccessGrant({
    version: 1,
    globalAdmins: ['8618111111111'],
    directMembers: [],
    groups: {},
    pending: [],
    contacts: [],
    ...overrides,
  });
}

test('normalizeAccessPhone accepts E.164, JIDs, and rejects LID servers', () => {
  assert.equal(normalizeAccessPhone('+86 181-4238-7786'), '8618142387786');
  assert.equal(normalizeAccessPhone('8618142387786@s.whatsapp.net'), '8618142387786');
  assert.equal(normalizeAccessPhone('12345:12@c.us'), '12345');
  assert.equal(normalizeAccessPhone('123456789012345@lid'), null);
  assert.equal(normalizeAccessPhone('12'), null);
});

test('ensureOwnerGlobalAdmin seeds linked account and refuses empty admins on validate', () => {
  const seeded = ensureOwnerGlobalAdmin(null, '8618111111111@s.whatsapp.net');
  assert.deepEqual(seeded.globalAdmins, ['8618111111111']);
  assert.throws(
    () => validateAccessGrant({ ...emptyAccessGrant(), globalAdmins: [] }),
    /全局管理员/,
  );
});

test('migrateAccessPolicyToGrant copies allowlist phones into directMembers only', () => {
  const migrated = migrateAccessPolicyToGrant({
    direct: { allowlist: { users: [{ id: '8618222222222@s.whatsapp.net', canExecuteCommands: true }] } },
    group: { allowlist: { users: [{ id: '+86 183-3333-3333', canExecuteCommands: false }] } },
  }, null, '8618111111111');
  assert.deepEqual(migrated.globalAdmins, ['8618111111111']);
  assert.deepEqual(
    migrated.directMembers.map((m) => m.phone).sort(),
    ['8618222222222', '8618333333333'],
  );
  assert.equal(Object.keys(migrated.groups).length, 0);
});

test('evaluateAccessGrant keeps DM and group scopes isolated', () => {
  const doc = grant({
    directMembers: [{ phone: '8618222222222', canExecuteCommands: true }],
    groups: {
      [GROUP_A]: {
        admins: ['8618333333333'],
        members: [{ phone: '8618444444444', canExecuteCommands: false }],
      },
    },
  });

  assert.equal(evaluateAccessGrant(doc, {
    scene: 'direct', phone: '8618111111111',
  }).reason, 'global-admin');
  assert.equal(evaluateAccessGrant(doc, {
    scene: 'direct', phone: '8618222222222',
  }).allowed, true);
  assert.equal(evaluateAccessGrant(doc, {
    scene: 'direct', phone: '8618333333333',
  }).allowed, false);
  assert.equal(evaluateAccessGrant(doc, {
    scene: 'group', phone: '8618444444444', groupJid: GROUP_A,
  }).reason, 'group-member');
  assert.equal(evaluateAccessGrant(doc, {
    scene: 'group', phone: '8618444444444', groupJid: GROUP_B,
  }).allowed, false);
  assert.equal(evaluateAccessGrant(doc, {
    scene: 'group', phone: '8618222222222', groupJid: GROUP_A,
  }).allowed, false);
  assert.equal(evaluateAccessGrant(doc, {
    scene: 'group',
    phone: '8618444444444',
    groupJid: GROUP_A,
    isCommand: true,
  }).reason, 'command-not-allowed');
});

test('pending notify falls back to global admins when group has no admins', () => {
  const doc = grant({
    groups: {
      [GROUP_A]: { admins: [], members: [] },
    },
  });
  assert.deepEqual(
    approverPhonesForPending(doc, { kind: 'group', groupJid: GROUP_A }),
    ['8618111111111'],
  );
  assert.deepEqual(
    approverPhonesForPending(grant({
      groups: { [GROUP_A]: { admins: ['8618555555555'], members: [] } },
    }), { kind: 'group', groupJid: GROUP_A }),
    ['8618555555555'],
  );
});

test('enqueue + approve places member into the matching grant bucket', () => {
  let doc = grant();
  const { grant: withPending, pending, created } = enqueueAccessPending(doc, {
    kind: 'group',
    groupJid: GROUP_A,
    phone: '8618666666666',
    pushName: 'Alice',
    requestText: 'hello',
  }, { idFactory: () => 'p_test_approve_1' });
  assert.equal(created, true);
  assert.equal(pending.id, 'p_test_approve_1');
  doc = withPending;

  const reused = enqueueAccessPending(doc, {
    kind: 'group',
    groupJid: GROUP_A,
    phone: '8618666666666',
  });
  assert.equal(reused.created, false);

  const { grant: approved } = resolveAccessPending(doc, {
    pendingId: pending.id,
    action: 'approve',
    resolvedByPhone: '8618111111111',
  });
  assert.equal(approved.groups[GROUP_A].members[0].phone, '8618666666666');
  assert.equal(approved.directMembers.length, 0);
  assert.equal(approved.pending[0].status, 'approved');
});

test('contacts upsert merges lid and phone sightings', () => {
  let doc = grant();
  doc = upsertAccessContact(doc, {
    lid: '999@lid',
    pushName: 'Bob',
    scene: 'group',
    groupJid: GROUP_A,
  });
  doc = upsertAccessContact(doc, {
    phone: '8618777777777',
    lid: '999@lid',
    pushName: 'Bobby',
    scene: 'direct',
  });
  assert.equal(doc.contacts.length, 1);
  assert.equal(doc.contacts[0].phone, '8618777777777');
  assert.deepEqual(doc.contacts[0].lids, ['999@lid']);
  assert.deepEqual(doc.contacts[0].scenes.slice().sort(), ['direct', 'group']);
});

test('quote approval helpers parse intent, pending id, and notify refs', () => {
  assert.equal(parseApprovalIntent('同意 顺便说一声'), 'approve');
  assert.equal(parseApprovalIntent('拒绝'), 'deny');
  assert.equal(parseApprovalIntent('maybe later'), null);
  const body = formatPendingNotifyBody({
    id: 'p_abc123',
    kind: 'direct',
    phone: '8618888888888',
    pushName: 'Carol',
    requestText: 'hi',
  });
  assert.equal(parsePendingIdFromNotifyText(body), 'p_abc123');
  const withRef = {
    ...grant(),
    pending: [{
      id: 'p_abc123',
      kind: 'direct',
      phone: '8618888888888',
      createdAt: new Date().toISOString(),
      status: 'pending',
      unresolved: false,
      notifyRefs: [{ adminPhone: '8618111111111', providerMessageId: 'MSG1' }],
    }],
  };
  assert.equal(findPendingByNotifyMessageId(withRef, 'MSG1')?.id, 'p_abc123');
});
