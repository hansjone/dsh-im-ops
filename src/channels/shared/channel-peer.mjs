import { normalizeAccessPhone, phoneFromWhatsappJid } from './access-grant.mjs';

/**
 * Parse a durable conversation binding key into chat identity fields.
 * @param {unknown} key
 * @returns {{ kind: 'direct' | 'group', conversationId: string, senderId: string | null } | null}
 */
export function parseConversationKey(key) {
  if (typeof key !== 'string' || !key) return null;
  if (key.startsWith('direct:')) {
    const conversationId = key.slice('direct:'.length).trim();
    return conversationId ? { kind: 'direct', conversationId, senderId: null } : null;
  }
  if (!key.startsWith('group:')) return null;
  const rest = key.slice('group:'.length);
  const userMarker = ':user:';
  const userAt = rest.indexOf(userMarker);
  if (userAt >= 0) {
    const conversationId = rest.slice(0, userAt).trim();
    const senderId = rest.slice(userAt + userMarker.length).trim();
    if (!conversationId || !senderId) return null;
    return { kind: 'group', conversationId, senderId };
  }
  const conversationId = rest.trim();
  return conversationId ? { kind: 'group', conversationId, senderId: null } : null;
}

function contactPushName(grant, phone) {
  if (!phone || !grant || !Array.isArray(grant.contacts)) return '';
  const hit = grant.contacts.find((contact) => contact?.phone === phone);
  return typeof hit?.pushName === 'string' ? hit.pushName.trim() : '';
}

function groupTitle(grant, groupJid) {
  const title = grant?.groups?.[groupJid]?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : '';
}

function phoneFromIdentity(value) {
  return phoneFromWhatsappJid(value) ?? normalizeAccessPhone(value);
}

/**
 * Build a public channel-peer summary for session-header display.
 * @param {{
 *   channel: string,
 *   botId: string,
 *   conversationKey: string,
 *   grant?: object | null,
 * }} input
 * @returns {object | null}
 */
export function resolveChannelPeerFromBinding(input) {
  const channel = typeof input?.channel === 'string' ? input.channel.trim() : '';
  const botId = typeof input?.botId === 'string' ? input.botId.trim() : '';
  const conversationKey = typeof input?.conversationKey === 'string'
    ? input.conversationKey.trim() : '';
  if (!channel || !botId || !conversationKey) return null;
  const parsed = parseConversationKey(conversationKey);
  if (!parsed) return null;
  const grant = input.grant && typeof input.grant === 'object' ? input.grant : null;

  if (parsed.kind === 'direct') {
    const phone = phoneFromIdentity(parsed.conversationId);
    const pushName = contactPushName(grant, phone);
    const who = pushName || phone || parsed.conversationId;
    const label = phone && pushName && pushName !== phone
      ? `${pushName} · ${phone}`
      : who;
    return Object.freeze({
      channel,
      botId,
      kind: 'direct',
      conversationKey,
      conversationId: parsed.conversationId,
      senderId: null,
      phone: phone || null,
      pushName: pushName || null,
      groupTitle: null,
      label,
    });
  }

  const title = groupTitle(grant, parsed.conversationId) || '未命名群';
  if (!parsed.senderId) {
    return Object.freeze({
      channel,
      botId,
      kind: 'group',
      conversationKey,
      conversationId: parsed.conversationId,
      senderId: null,
      phone: null,
      pushName: null,
      groupTitle: title,
      label: `群 · ${title}`,
    });
  }

  const phone = phoneFromIdentity(parsed.senderId);
  const pushName = contactPushName(grant, phone);
  const who = pushName || phone || parsed.senderId;
  return Object.freeze({
    channel,
    botId,
    kind: 'group',
    conversationKey,
    conversationId: parsed.conversationId,
    senderId: parsed.senderId,
    phone: phone || null,
    pushName: pushName || null,
    groupTitle: title,
    label: `${title} · ${who}`,
  });
}
