/**
 * WhatsApp ops access grants: phone-canonical identity, global vs group scopes.
 * Browser-compatible (shared with settings UI).
 */

export const ACCESS_GRANT_VERSION = 1;
export const ACCESS_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCESS_GRANT_PHONE_MAX_LENGTH = 32;
export const ACCESS_GRANT_GROUP_JID_PATTERN = /^\d{5,32}@g\.us$/;
const AGENT_PRESET_ID = /^[a-z0-9][a-z0-9-]*$/;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/** @typedef {'direct' | 'group'} AccessGrantScene */
/** @typedef {'approve' | 'deny'} AccessPendingAction */

function normalizeOptionalAgentPresetId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return AGENT_PRESET_ID.test(id) ? id : null;
}

function invalidGrant(message) {
  const error = new TypeError(message);
  error.code = 'access-grant-invalid';
  throw error;
}

/**
 * Normalize a phone to digits only (strip +, spaces, dashes).
 * Accepts bare numbers, +E.164, or PN JIDs like `86138…@s.whatsapp.net`.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeAccessPhone(value) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value === 'bigint') value = String(value);
  if (typeof value !== 'string') return null;
  let raw = value.trim();
  if (!raw || CONTROL_CHARACTERS.test(raw)) return null;
  const at = raw.indexOf('@');
  if (at > 0) {
    const user = raw.slice(0, at).split(':')[0];
    const server = raw.slice(at + 1).toLowerCase();
    if (!['s.whatsapp.net', 'c.us', 'hosted'].includes(server)) return null;
    raw = user;
  }
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 5 || digits.length > ACCESS_GRANT_PHONE_MAX_LENGTH) return null;
  return digits;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function validateAccessPhone(value) {
  const phone = normalizeAccessPhone(value);
  if (!phone) invalidGrant('电话号码无效。');
  return phone;
}

/**
 * Extract phone digits from a WhatsApp JID when it is a PN (not LID).
 * @param {unknown} jid
 * @returns {string|null}
 */
export function phoneFromWhatsappJid(jid) {
  return normalizeAccessPhone(jid);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function validateGroupJid(value) {
  if (typeof value !== 'string' || !ACCESS_GRANT_GROUP_JID_PATTERN.test(value.trim())) {
    invalidGrant('群 JID 无效。');
  }
  return value.trim();
}

/**
 * @param {unknown} input
 * @returns {{ phone: string, canExecuteCommands: boolean, agentPreset?: string }}
 */
function validateMember(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalidGrant('成员条目无效。');
  }
  const phone = validateAccessPhone(input.phone ?? input.id);
  const canExecuteCommands = input.canExecuteCommands === undefined
    ? true
    : Boolean(input.canExecuteCommands);
  const agentPreset = optionalAgentPreset(input.agentPreset);
  return Object.freeze({
    phone,
    canExecuteCommands,
    ...(agentPreset ? { agentPreset } : {}),
  });
}

/**
 * Optional Agent Preset override. Empty/null means follow the bot-level preset.
 * @param {unknown} value
 * @returns {string|undefined}
 */
function optionalAgentPreset(value) {
  if (value == null || value === '') return undefined;
  const id = normalizeOptionalAgentPresetId(value);
  if (!id) invalidGrant('Agent Preset 无效。');
  return id;
}

/**
 * @param {unknown} input
 * @returns {string[]}
 */
function validatePhoneList(input, { emptyMessage, label }) {
  if (!Array.isArray(input)) invalidGrant(`${label}必须是数组。`);
  const phones = input.map((entry) => (
    typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'bigint'
      ? validateAccessPhone(entry)
      : validateAccessPhone(entry?.phone ?? entry?.id)
  ));
  if (new Set(phones).size !== phones.length) invalidGrant(`${label}不能包含重复电话。`);
  if (phones.length === 0 && emptyMessage) invalidGrant(emptyMessage);
  return Object.freeze(phones);
}

/**
 * @param {unknown} input
 * @returns {object}
 */
function validateGroupGrant(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalidGrant('群授权条目无效。');
  }
  const admins = validatePhoneList(input.admins ?? [], { label: '群管理员' });
  const members = Object.freeze((Array.isArray(input.members) ? input.members : [])
    .map(validateMember));
  if (new Set(members.map((m) => m.phone)).size !== members.length) {
    invalidGrant('群成员不能包含重复电话。');
  }
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 128) : '';
  const agentPreset = optionalAgentPreset(input.agentPreset);
  return Object.freeze({
    ...(title ? { title } : {}),
    ...(agentPreset ? { agentPreset } : {}),
    admins,
    members,
  });
}

/**
 * @param {unknown} input
 * @returns {object}
 */
function validatePending(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalidGrant('待批条目无效。');
  }
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) invalidGrant('待批编号无效。');
  const kind = input.kind === 'group' ? 'group' : input.kind === 'direct' ? 'direct' : null;
  if (!kind) invalidGrant('待批场景无效。');
  const phone = input.phone ? validateAccessPhone(input.phone) : '';
  const lid = typeof input.lid === 'string' ? input.lid.trim().slice(0, 128) : '';
  if (!phone && !lid) invalidGrant('待批缺少电话或 LID。');
  const groupJid = kind === 'group' ? validateGroupJid(input.groupJid) : undefined;
  const pushName = typeof input.pushName === 'string' ? input.pushName.trim().slice(0, 128) : '';
  const requestText = typeof input.requestText === 'string'
    ? input.requestText.trim().slice(0, 500) : '';
  const createdAt = typeof input.createdAt === 'string' && input.createdAt
    ? input.createdAt : new Date().toISOString();
  const unresolved = input.unresolved === true || !phone;
  const notifyRefs = Array.isArray(input.notifyRefs)
    ? Object.freeze(input.notifyRefs.map((ref) => Object.freeze({
      adminPhone: validateAccessPhone(ref.adminPhone),
      providerMessageId: String(ref.providerMessageId ?? '').trim().slice(0, 128),
    })).filter((ref) => ref.providerMessageId))
    : Object.freeze([]);
  const resolvedByPhone = input.resolvedByPhone
    ? validateAccessPhone(input.resolvedByPhone) : undefined;
  const resolvedAt = typeof input.resolvedAt === 'string' ? input.resolvedAt : undefined;
  const status = ['pending', 'approved', 'denied', 'expired'].includes(input.status)
    ? input.status : 'pending';
  return Object.freeze({
    id,
    kind,
    ...(groupJid ? { groupJid } : {}),
    phone: phone || '',
    ...(lid ? { lid } : {}),
    ...(pushName ? { pushName } : {}),
    ...(requestText ? { requestText } : {}),
    createdAt,
    unresolved,
    notifyRefs,
    status,
    ...(resolvedByPhone ? { resolvedByPhone } : {}),
    ...(resolvedAt ? { resolvedAt } : {}),
  });
}

/**
 * @param {unknown} input
 * @returns {object}
 */
function validateContact(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalidGrant('联系人条目无效。');
  }
  const phone = input.phone ? validateAccessPhone(input.phone) : undefined;
  const lids = Object.freeze([...(Array.isArray(input.lids) ? input.lids : [])]
    .map((lid) => String(lid ?? '').trim())
    .filter((lid) => lid && lid.length <= 128)
    .slice(0, 8));
  const pushName = typeof input.pushName === 'string' ? input.pushName.trim().slice(0, 128) : '';
  const lastSeenAt = typeof input.lastSeenAt === 'string' && input.lastSeenAt
    ? input.lastSeenAt : new Date().toISOString();
  const scenes = Object.freeze([...(Array.isArray(input.scenes) ? input.scenes : [])]
    .filter((scene) => scene === 'direct' || scene === 'group')
    .slice(0, 2));
  const groupJids = Object.freeze([...(Array.isArray(input.groupJids) ? input.groupJids : [])]
    .map((jid) => String(jid ?? '').trim())
    .filter((jid) => ACCESS_GRANT_GROUP_JID_PATTERN.test(jid))
    .slice(0, 32));
  if (!phone && lids.length === 0) invalidGrant('联系人缺少电话或 LID。');
  return Object.freeze({
    ...(phone ? { phone } : {}),
    lids,
    ...(pushName ? { pushName } : {}),
    lastSeenAt,
    scenes: scenes.length > 0 ? scenes : Object.freeze(['direct']),
    ...(groupJids.length > 0 ? { groupJids } : {}),
  });
}

/**
 * Empty grant document (before owner seed).
 * @returns {object}
 */
export function emptyAccessGrant() {
  return Object.freeze({
    version: ACCESS_GRANT_VERSION,
    globalAdmins: Object.freeze([]),
    directMembers: Object.freeze([]),
    groups: Object.freeze({}),
    pending: Object.freeze([]),
    contacts: Object.freeze([]),
  });
}

/**
 * @param {unknown} input
 * @param {{ requireGlobalAdmin?: boolean }} [options]
 * @returns {object}
 */
export function validateAccessGrant(input, { requireGlobalAdmin = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalidGrant('访问授权文档无效。');
  }
  const version = input.version === undefined ? ACCESS_GRANT_VERSION : Number(input.version);
  if (version !== ACCESS_GRANT_VERSION) invalidGrant('访问授权版本不支持。');
  const globalAdmins = validatePhoneList(input.globalAdmins ?? [], {
    label: '全局管理员',
    emptyMessage: requireGlobalAdmin ? '至少保留一位全局管理员。' : undefined,
  });
  if (requireGlobalAdmin && globalAdmins.length === 0) {
    invalidGrant('至少保留一位全局管理员。');
  }
  const directMembers = Object.freeze((Array.isArray(input.directMembers) ? input.directMembers : [])
    .map(validateMember));
  if (new Set(directMembers.map((m) => m.phone)).size !== directMembers.length) {
    invalidGrant('私聊授权用户不能包含重复电话。');
  }
  const groups = Object.create(null);
  if (input.groups && typeof input.groups === 'object' && !Array.isArray(input.groups)) {
    for (const [groupJid, grant] of Object.entries(input.groups)) {
      groups[validateGroupJid(groupJid)] = validateGroupGrant(grant);
    }
  }
  const pending = Object.freeze((Array.isArray(input.pending) ? input.pending : [])
    .map(validatePending)
    .slice(0, 200));
  const contacts = Object.freeze((Array.isArray(input.contacts) ? input.contacts : [])
    .map(validateContact)
    .slice(0, 500));
  return Object.freeze({
    version: ACCESS_GRANT_VERSION,
    globalAdmins,
    directMembers,
    groups: Object.freeze(groups),
    pending,
    contacts,
  });
}

/**
 * @param {unknown} input
 * @returns {object|null}
 */
export function normalizeAccessGrant(input) {
  try {
    return validateAccessGrant(input, { requireGlobalAdmin: false });
  } catch {
    return null;
  }
}

/**
 * Resolve a chat-scoped Agent Preset override from the access grant.
 * Returns null when the chat should follow the bot-level (global) preset.
 * Priority: direct-member or group override > bot global (caller applies global).
 * @param {unknown} grant
 * @param {{ kind?: string, phone?: string, senderId?: string, groupJid?: string, conversationId?: string }} [context]
 * @returns {string|null}
 */
export function resolveAccessAgentPreset(grant, context = {}) {
  const doc = normalizeAccessGrant(grant);
  if (!doc) return null;
  if (context.kind === 'group') {
    const groupJid = typeof context.groupJid === 'string' && context.groupJid.trim()
      ? context.groupJid.trim()
      : typeof context.conversationId === 'string' ? context.conversationId.trim() : '';
    if (!groupJid || !ACCESS_GRANT_GROUP_JID_PATTERN.test(groupJid)) return null;
    return normalizeOptionalAgentPresetId(doc.groups[groupJid]?.agentPreset) ?? null;
  }
  const phone = normalizeAccessPhone(context.phone ?? context.senderId);
  if (!phone) return null;
  const member = doc.directMembers.find((entry) => entry.phone === phone);
  return normalizeOptionalAgentPresetId(member?.agentPreset) ?? null;
}

/**
 * Seed owner phone as the first global admin when missing.
 * @param {object|null} grant
 * @param {string|null} ownerPhone
 * @returns {object}
 */
export function ensureOwnerGlobalAdmin(grant, ownerPhone) {
  const base = grant ? validateAccessGrant(grant, { requireGlobalAdmin: false })
    : emptyAccessGrant();
  const owner = normalizeAccessPhone(ownerPhone);
  if (!owner) return base;
  if (base.globalAdmins.includes(owner)) return base;
  return validateAccessGrant({
    ...base,
    globalAdmins: [owner, ...base.globalAdmins],
  });
}

/**
 * Migrate legacy shared accessPolicy allowlist phones into directMembers only.
 * @param {object|null} policy
 * @param {object|null} existingGrant
 * @param {string|null} ownerPhone
 * @returns {object}
 */
export function migrateAccessPolicyToGrant(policy, existingGrant, ownerPhone) {
  let grant = ensureOwnerGlobalAdmin(existingGrant, ownerPhone);
  const phones = new Set(grant.directMembers.map((m) => m.phone));
  const scopes = [policy?.direct, policy?.group];
  for (const scope of scopes) {
    for (const user of scope?.allowlist?.users ?? []) {
      const phone = normalizeAccessPhone(user?.id);
      if (!phone || phones.has(phone)) continue;
      phones.add(phone);
    }
  }
  const directMembers = [
    ...grant.directMembers,
    ...[...phones]
      .filter((phone) => !grant.directMembers.some((m) => m.phone === phone))
      .map((phone) => ({ phone, canExecuteCommands: true })),
  ];
  return validateAccessGrant({
    ...grant,
    directMembers,
  });
}

/**
 * Evaluate whether a phone may use the bot in a scene.
 * @param {object} grant
 * @param {{ scene: AccessGrantScene, phone: string|null, groupJid?: string, isCommand?: boolean }} input
 * @returns {{ allowed: boolean, reason: string, canExecuteCommands?: boolean, canApprove?: boolean }}
 */
export function evaluateAccessGrant(grant, {
  scene,
  phone,
  groupJid,
  isCommand = false,
} = {}) {
  const doc = normalizeAccessGrant(grant) ?? emptyAccessGrant();
  const normalizedPhone = normalizeAccessPhone(phone);
  if (!normalizedPhone) {
    return { allowed: false, reason: 'phone-unavailable' };
  }
  if (doc.globalAdmins.includes(normalizedPhone)) {
    return {
      allowed: true,
      reason: 'global-admin',
      canExecuteCommands: true,
      canApprove: true,
    };
  }
  if (scene === 'direct') {
    const member = doc.directMembers.find((m) => m.phone === normalizedPhone);
    if (!member) return { allowed: false, reason: 'direct-not-allowed' };
    if (isCommand && !member.canExecuteCommands) {
      return { allowed: false, reason: 'command-not-allowed', canExecuteCommands: false };
    }
    return {
      allowed: true,
      reason: 'direct-member',
      canExecuteCommands: member.canExecuteCommands,
      canApprove: false,
    };
  }
  if (scene !== 'group' || !groupJid || !ACCESS_GRANT_GROUP_JID_PATTERN.test(groupJid)) {
    return { allowed: false, reason: 'invalid-context' };
  }
  const group = doc.groups[groupJid];
  if (!group) return { allowed: false, reason: 'group-not-allowed' };
  if (group.admins.includes(normalizedPhone)) {
    return {
      allowed: true,
      reason: 'group-admin',
      canExecuteCommands: true,
      canApprove: true,
    };
  }
  const member = group.members.find((m) => m.phone === normalizedPhone);
  if (!member) return { allowed: false, reason: 'group-not-allowed' };
  if (isCommand && !member.canExecuteCommands) {
    return { allowed: false, reason: 'command-not-allowed', canExecuteCommands: false };
  }
  return {
    allowed: true,
    reason: 'group-member',
    canExecuteCommands: member.canExecuteCommands,
    canApprove: false,
  };
}

/**
 * Who should receive a pending notify for this request.
 * @param {object} grant
 * @param {{ kind: AccessGrantScene, groupJid?: string }} pending
 * @returns {string[]}
 */
export function approverPhonesForPending(grant, pending) {
  const doc = normalizeAccessGrant(grant) ?? emptyAccessGrant();
  if (pending.kind === 'group' && pending.groupJid) {
    const group = doc.groups[pending.groupJid];
    if (group?.admins?.length) return [...group.admins];
  }
  return [...doc.globalAdmins];
}

/**
 * Whether this phone may resolve a pending request.
 * @param {object} grant
 * @param {string} adminPhone
 * @param {object} pending
 */
export function canResolvePending(grant, adminPhone, pending) {
  const phone = normalizeAccessPhone(adminPhone);
  if (!phone || pending?.status !== 'pending') return false;
  return approverPhonesForPending(grant, pending).includes(phone);
}

export function isPendingExpired(pending, now = Date.now()) {
  const created = Date.parse(pending?.createdAt ?? '');
  if (!Number.isFinite(created)) return true;
  return now - created > ACCESS_PENDING_TTL_MS;
}

/**
 * Find an open pending matching identity+scene (dedupe).
 * @param {object} grant
 * @param {{ kind: AccessGrantScene, groupJid?: string, phone?: string, lid?: string }} query
 */
export function findOpenPending(grant, query) {
  const doc = normalizeAccessGrant(grant) ?? emptyAccessGrant();
  const phone = normalizeAccessPhone(query.phone);
  return doc.pending.find((entry) => {
    if (entry.status !== 'pending' || isPendingExpired(entry)) return false;
    if (entry.kind !== query.kind) return false;
    if (query.kind === 'group' && entry.groupJid !== query.groupJid) return false;
    if (phone && entry.phone === phone) return true;
    if (query.lid && entry.lid === query.lid) return true;
    return false;
  }) ?? null;
}

/**
 * Upsert a contact observation into the grant document (immutable return).
 * @param {object} grant
 * @param {{ phone?: string, lid?: string, pushName?: string, scene: AccessGrantScene, groupJid?: string, at?: string }} sighting
 */
export function upsertAccessContact(grant, sighting) {
  const doc = validateAccessGrant(grant, { requireGlobalAdmin: false });
  const phone = normalizeAccessPhone(sighting.phone);
  const lid = typeof sighting.lid === 'string' ? sighting.lid.trim() : '';
  const at = sighting.at ?? new Date().toISOString();
  const pushName = typeof sighting.pushName === 'string' ? sighting.pushName.trim() : '';
  const scene = sighting.scene === 'group' ? 'group' : 'direct';
  const groupJid = scene === 'group' && sighting.groupJid
    ? validateGroupJid(sighting.groupJid) : null;

  const contacts = [...doc.contacts];
  let index = contacts.findIndex((contact) => (
    (phone && contact.phone === phone)
    || (lid && contact.lids.includes(lid))
  ));
  if (index < 0) {
    contacts.unshift(validateContact({
      phone,
      lids: lid ? [lid] : [],
      pushName,
      lastSeenAt: at,
      scenes: [scene],
      groupJids: groupJid ? [groupJid] : [],
    }));
  } else {
    const prev = contacts[index];
    const lids = [...new Set([...(prev.lids ?? []), ...(lid ? [lid] : [])])].slice(0, 8);
    const scenes = [...new Set([...(prev.scenes ?? []), scene])];
    const groupJids = [...new Set([
      ...(prev.groupJids ?? []),
      ...(groupJid ? [groupJid] : []),
    ])].slice(0, 32);
    contacts[index] = validateContact({
      phone: phone ?? prev.phone,
      lids,
      pushName: pushName || prev.pushName,
      lastSeenAt: at,
      scenes,
      groupJids,
    });
  }
  return validateAccessGrant({
    ...doc,
    contacts: contacts.slice(0, 500),
  }, { requireGlobalAdmin: false });
}

/**
 * Ensure a group bucket exists (for titles / admin config).
 * @param {object} grant
 * @param {string} groupJid
 * @param {{ title?: string }} [patch]
 */
export function ensureGroupBucket(grant, groupJid, patch = {}) {
  const doc = validateAccessGrant(grant, { requireGlobalAdmin: false });
  const jid = validateGroupJid(groupJid);
  const existing = doc.groups[jid] ?? { admins: [], members: [] };
  const title = typeof patch.title === 'string' && patch.title.trim()
    ? patch.title.trim().slice(0, 128)
    : existing.title;
  const groups = {
    ...doc.groups,
    [jid]: validateGroupGrant({
      ...existing,
      ...(title ? { title } : {}),
    }),
  };
  return validateAccessGrant({ ...doc, groups }, { requireGlobalAdmin: false });
}

/**
 * Create or reuse a pending request.
 * @param {object} grant
 * @param {object} request
 * @param {{ idFactory?: () => string }} [options]
 */
export function enqueueAccessPending(grant, request, { idFactory } = {}) {
  const doc = validateAccessGrant(grant, { requireGlobalAdmin: false });
  const existing = findOpenPending(doc, request);
  if (existing) return { grant: doc, pending: existing, created: false };

  const pending = validatePending({
    id: idFactory?.() ?? `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    kind: request.kind,
    groupJid: request.groupJid,
    phone: request.phone ?? '',
    lid: request.lid,
    pushName: request.pushName,
    requestText: request.requestText,
    createdAt: new Date().toISOString(),
    unresolved: !normalizeAccessPhone(request.phone),
    status: 'pending',
    notifyRefs: [],
  });
  const nextPending = [pending, ...doc.pending.filter((entry) => (
    entry.status === 'pending' && !isPendingExpired(entry)
  ))].slice(0, 200);
  return {
    grant: validateAccessGrant({ ...doc, pending: nextPending }, { requireGlobalAdmin: false }),
    pending,
    created: true,
  };
}

/**
 * Attach notify message ids after DMing admins.
 * @param {object} grant
 * @param {string} pendingId
 * @param {Array<{ adminPhone: string, providerMessageId: string }>} refs
 */
export function attachPendingNotifyRefs(grant, pendingId, refs) {
  const doc = validateAccessGrant(grant, { requireGlobalAdmin: false });
  const pending = doc.pending.map((entry) => {
    if (entry.id !== pendingId) return entry;
    return validatePending({
      ...entry,
      notifyRefs: [...(entry.notifyRefs ?? []), ...refs],
    });
  });
  return validateAccessGrant({ ...doc, pending }, { requireGlobalAdmin: false });
}

/**
 * Resolve a pending request into the correct grant bucket.
 * @param {object} grant
 * @param {{ pendingId: string, action: AccessPendingAction, resolvedByPhone: string }} input
 */
export function resolveAccessPending(grant, { pendingId, action, resolvedByPhone }) {
  const doc = validateAccessGrant(grant, { requireGlobalAdmin: false });
  const adminPhone = validateAccessPhone(resolvedByPhone);
  const index = doc.pending.findIndex((entry) => entry.id === pendingId);
  if (index < 0) {
    const error = new Error('找不到待批申请。');
    error.code = 'pending-not-found';
    throw error;
  }
  const entry = doc.pending[index];
  if (entry.status !== 'pending' || isPendingExpired(entry)) {
    const error = new Error('该申请已失效。');
    error.code = 'pending-expired';
    throw error;
  }
  if (!canResolvePending(doc, adminPhone, entry)) {
    const error = new Error('无权审批该申请。');
    error.code = 'pending-forbidden';
    throw error;
  }
  if (action !== 'approve' && action !== 'deny') {
    invalidGrant('审批动作无效。');
  }
  if (action === 'approve' && entry.unresolved) {
    const error = new Error('申请人电话尚未解析，请在设置中补全后再批准。');
    error.code = 'pending-unresolved';
    throw error;
  }

  let next = { ...doc };
  if (action === 'approve') {
    if (entry.kind === 'direct') {
      if (!next.directMembers.some((m) => m.phone === entry.phone)) {
        next.directMembers = [
          ...next.directMembers,
          { phone: entry.phone, canExecuteCommands: true },
        ];
      }
    } else {
      const group = next.groups[entry.groupJid] ?? { admins: [], members: [] };
      if (!group.members.some((m) => m.phone === entry.phone)
        && !group.admins.includes(entry.phone)) {
        next.groups = {
          ...next.groups,
          [entry.groupJid]: {
            ...group,
            members: [...group.members, { phone: entry.phone, canExecuteCommands: true }],
          },
        };
      }
    }
  }

  const pending = [...doc.pending];
  pending[index] = validatePending({
    ...entry,
    status: action === 'approve' ? 'approved' : 'denied',
    resolvedByPhone: adminPhone,
    resolvedAt: new Date().toISOString(),
  });
  next.pending = pending;
  return {
    grant: validateAccessGrant(next),
    pending: pending[index],
  };
}

/**
 * Find pending by notify stanza (quote-reply).
 * @param {object} grant
 * @param {string} providerMessageId
 */
export function findPendingByNotifyMessageId(grant, providerMessageId) {
  const id = String(providerMessageId ?? '').trim();
  if (!id) return null;
  const doc = normalizeAccessGrant(grant) ?? emptyAccessGrant();
  return doc.pending.find((entry) => (
    entry.status === 'pending'
    && !isPendingExpired(entry)
    && (entry.notifyRefs ?? []).some((ref) => ref.providerMessageId === id)
  )) ?? null;
}

const AFFIRMATIVE = new Set([
  'yes', 'y', 'approve', 'allow', 'add', 'ok', 'grant', 'whitelist',
  '同意', '可以', '是', '添加', '通过',
]);
const NEGATIVE = new Set([
  'no', 'n', 'deny', 'reject', 'ignore',
  '拒绝', '不', '否', '忽略',
]);

/**
 * Parse admin quote-reply intent.
 * @param {string} text
 * @returns {AccessPendingAction|null}
 */
export function parseApprovalIntent(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const first = raw.split(/\s+/u)[0]?.toLowerCase?.() ?? '';
  if (AFFIRMATIVE.has(first) || /添加白名单|add to whitelist/iu.test(raw)) return 'approve';
  if (NEGATIVE.has(first)) return 'deny';
  return null;
}

/**
 * Parse pending id from notify body (`请求编号: xxx` / `Request: xxx`).
 * @param {string} text
 * @returns {string|null}
 */
export function parsePendingIdFromNotifyText(text) {
  const raw = String(text ?? '');
  const match = raw.match(/(?:请求编号|Request)\s*[:：]\s*([A-Za-z0-9_-]{6,64})/u);
  return match?.[1] ?? null;
}

/** Notify / ack copy (zh). */
export const ACCESS_GRANT_COPY = Object.freeze({
  pendingAckDirect: '已提交私聊访问申请，请等待全局管理员审批。',
  pendingAckGroup: '已提交本群访问申请，请等待管理员审批。',
  pendingUnresolved: '已记录访问申请，但尚未解析到电话号码；请管理员在设置中补全后再批准。',
  notifyTitle: '[dsh-im-ops] 访问申请',
  approvedDirect: '私聊访问已批准，现在可以直接对话。',
  approvedGroup: '本群访问已批准，请在本群 @ 机器人继续。',
  denied: '访问申请未通过。',
  adminApproved: '已批准该访问申请。',
  adminDenied: '已拒绝该访问申请。',
});

/**
 * @param {object} pending
 * @returns {string}
 */
export function formatPendingNotifyBody(pending) {
  const scene = pending.kind === 'group'
    ? `群聊 ${pending.groupJid ?? ''}`
    : '私聊';
  const who = pending.pushName
    ? `${pending.pushName} (${pending.phone || pending.lid || '未知'})`
    : (pending.phone || pending.lid || '未知');
  const text = pending.requestText ? `\n原文：${pending.requestText.slice(0, 200)}` : '';
  return [
    ACCESS_GRANT_COPY.notifyTitle,
    `场景：${scene}`,
    `申请人：${who}`,
    `请求编号：${pending.id}`,
    '请引用本条消息回复「同意」或「拒绝」。',
    text,
  ].filter(Boolean).join('\n');
}
