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

/**
 * Normalize a WhatsApp LID identity for contact matching.
 * Accepts `digits@lid`, `digits:device@lid`, or a bare lid token already stored on contacts.
 * @param {unknown} value
 * @returns {string|null}
 */
export function lidFromWhatsappIdentity(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const at = raw.indexOf('@');
  if (at > 0) {
    const server = raw.slice(at + 1).toLowerCase();
    if (server !== 'lid' && server !== 'hosted.lid') return null;
    const user = raw.slice(0, at).split(':')[0].trim();
    return user ? `${user}@lid` : null;
  }
  // Contacts may already store the canonical `digits@lid` form only.
  return null;
}

function lidsMatch(stored, needle) {
  if (typeof stored !== 'string' || !needle) return false;
  const left = lidFromWhatsappIdentity(stored) ?? stored.trim();
  return left === needle || left === needle.replace(/@lid$/, '');
}

/**
 * Resolve contact phone/pushName from grant by PN or LID.
 * @param {object|null} grant
 * @param {string|null} identity
 * @returns {{ phone: string|null, pushName: string|null }}
 */
export function resolveContactIdentity(grant, identity) {
  const phone = phoneFromWhatsappJid(identity) ?? normalizeAccessPhone(identity);
  const lid = lidFromWhatsappIdentity(identity);
  const contacts = Array.isArray(grant?.contacts) ? grant.contacts : [];
  const hit = contacts.find((contact) => {
    if (phone && contact?.phone === phone) return true;
    if (lid && Array.isArray(contact?.lids) && contact.lids.some((entry) => lidsMatch(entry, lid))) {
      return true;
    }
    return false;
  }) ?? null;
  const resolvedPhone = phone
    ?? (typeof hit?.phone === 'string' && hit.phone ? hit.phone : null);
  const pushName = typeof hit?.pushName === 'string' && hit.pushName.trim()
    ? hit.pushName.trim()
    : null;
  return { phone: resolvedPhone, pushName };
}

function groupTitle(grant, groupJid) {
  const title = grant?.groups?.[groupJid]?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : '';
}

/**
 * Join human-facing label parts. Never includes raw JIDs / LIDs.
 * @param {...(string|null|undefined)} parts
 * @returns {string}
 */
export function formatChannelPeerLabel(...parts) {
  return parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' · ');
}

/**
 * Build a public channel-peer summary for session-header display.
 * Label shows only group title / nickname / phone — never opaque WhatsApp ids.
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
    const { phone, pushName } = resolveContactIdentity(grant, parsed.conversationId);
    const label = formatChannelPeerLabel(pushName, phone);
    if (!label) return null;
    return Object.freeze({
      channel,
      botId,
      kind: 'direct',
      conversationKey,
      conversationId: parsed.conversationId,
      senderId: null,
      phone,
      pushName,
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
      label: title,
    });
  }

  const { phone, pushName } = resolveContactIdentity(grant, parsed.senderId);
  const label = formatChannelPeerLabel(title, pushName, phone) || title;
  return Object.freeze({
    channel,
    botId,
    kind: 'group',
    conversationKey,
    conversationId: parsed.conversationId,
    senderId: parsed.senderId,
    phone,
    pushName,
    groupTitle: title,
    label,
  });
}
