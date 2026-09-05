import { validateAccessGrant, normalizeAccessGrant } from '../../../../src/channels/shared/access-grant.mjs';

export const SET_ACCESS_GRANT_ENDPOINT = 'bot.access-grant.set';
export const RESOLVE_ACCESS_PENDING_ENDPOINT = 'bot.access-pending.resolve';
export const REFRESH_ACCESS_GROUP_TITLES_ENDPOINT = 'bot.access-group-titles.refresh';

export function validAccessGrantPayload(payload) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !Object.hasOwn(payload, 'botId') || !Object.hasOwn(payload, 'grant')
      || typeof payload.botId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.botId)) return false;
    validateAccessGrant(payload.grant);
    return true;
  } catch {
    return false;
  }
}

export function validAccessPendingResolvePayload(payload) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const keys = Reflect.ownKeys(payload);
    if (keys.length !== 4
      || !Object.hasOwn(payload, 'botId')
      || !Object.hasOwn(payload, 'pendingId')
      || !Object.hasOwn(payload, 'action')
      || !Object.hasOwn(payload, 'resolvedByPhone')) return false;
    if (typeof payload.botId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.botId)) {
      return false;
    }
    if (typeof payload.pendingId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(payload.pendingId)) {
      return false;
    }
    if (payload.action !== 'approve' && payload.action !== 'deny') return false;
    if (typeof payload.resolvedByPhone !== 'string' || !payload.resolvedByPhone.trim()) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function validAccessGroupTitlesRefreshPayload(payload) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (!Object.hasOwn(payload, 'botId') || typeof payload.botId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.botId)) return false;
    const keys = Reflect.ownKeys(payload);
    if (keys.length === 1) return true;
    if (keys.length !== 2 || !Object.hasOwn(payload, 'groupJids')) return false;
    if (!Array.isArray(payload.groupJids)) return false;
    return payload.groupJids.every((jid) => typeof jid === 'string' && /^\d{5,32}@g\.us$/.test(jid));
  } catch {
    return false;
  }
}

export function publicAccessGrant(grant) {
  const normalized = normalizeAccessGrant(grant);
  if (!normalized) return null;
  return {
    version: normalized.version,
    globalAdmins: [...normalized.globalAdmins],
    directMembers: normalized.directMembers.map((m) => ({ ...m })),
    groups: Object.fromEntries(Object.entries(normalized.groups).map(([jid, group]) => [jid, {
      ...(group.title ? { title: group.title } : {}),
      ...(group.agentPreset ? { agentPreset: group.agentPreset } : {}),
      admins: [...group.admins],
      members: group.members.map((m) => ({ ...m })),
    }])),
    pending: normalized.pending
      .filter((entry) => entry.status === 'pending')
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        ...(entry.groupJid ? { groupJid: entry.groupJid } : {}),
        phone: entry.phone,
        ...(entry.lid ? { lid: entry.lid } : {}),
        ...(entry.pushName ? { pushName: entry.pushName } : {}),
        ...(entry.requestText ? { requestText: entry.requestText } : {}),
        createdAt: entry.createdAt,
        unresolved: entry.unresolved === true,
      })),
    contacts: normalized.contacts.slice(0, 100).map((contact) => ({
      ...(contact.phone ? { phone: contact.phone } : {}),
      lids: [...contact.lids],
      ...(contact.pushName ? { pushName: contact.pushName } : {}),
      lastSeenAt: contact.lastSeenAt,
      scenes: [...contact.scenes],
      ...(contact.groupJids ? { groupJids: [...contact.groupJids] } : {}),
    })),
  };
}
