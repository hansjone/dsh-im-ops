/**
 * Map a proactive-delivery target route to conversationKey candidates
 * so schedulers can resolve the live Harness session for that chat.
 */

/**
 * @param {object|null|undefined} target
 * @returns {string[]}
 */
export function conversationKeysFromDeliveryTarget(target) {
  if (!target || typeof target !== 'object') return [];
  const kind = typeof target.kind === 'string' ? target.kind.trim() : '';
  const route = target.route && typeof target.route === 'object' ? target.route : {};
  const jid = String(route.jid || route.chatId || route.openId || route.userId || '')
    .trim();
  if (!jid) return [];

  if (kind === 'group' || jid.endsWith('@g.us')) {
    const groupJid = jid.toLowerCase().endsWith('@g.us') ? jid : `${jid}`;
    return [`group:${groupJid}`];
  }

  // DM / user targets: prefer the native jid; phone-shaped ids already include @s.whatsapp.net.
  return [`direct:${jid}`];
}

/**
 * Whether a live conversationKey belongs to a delivery target.
 * Groups accept both shared (`group:jid`) and per-user (`group:jid:user:…`) bindings.
 * @param {string} conversationKey
 * @param {object|null|undefined} target
 */
export function conversationKeyMatchesTarget(conversationKey, target) {
  const key = typeof conversationKey === 'string' ? conversationKey.trim() : '';
  if (!key) return false;
  const candidates = conversationKeysFromDeliveryTarget(target);
  for (const candidate of candidates) {
    if (key === candidate) return true;
    if (candidate.startsWith('group:') && key.startsWith(`${candidate}:user:`)) return true;
  }
  return false;
}
