/**
 * Resolve WhatsApp LID ↔ phone JIDs so group allowlists and @mentions work
 * when Baileys only surfaces opaque @lid identities on the wire.
 */

import { areJidsSameUser, jidDecode } from '@whiskeysockets/baileys';

function isLidServer(server) {
  return server === 'lid' || server === 'hosted.lid';
}

function isPnServer(server) {
  return server === 's.whatsapp.net' || server === 'c.us' || server === 'hosted';
}

export function isWhatsappLidJid(value) {
  if (typeof value !== 'string' || !value) return false;
  const decoded = jidDecode(value.trim());
  return Boolean(decoded && isLidServer(decoded.server));
}

export function isWhatsappPnJid(value) {
  if (typeof value !== 'string' || !value) return false;
  const decoded = jidDecode(value.trim());
  return Boolean(decoded && isPnServer(decoded.server) && /^\d+$/.test(decoded.user));
}

/**
 * Learn LID/PN pairs from a Baileys message key (remoteJidAlt / participantAlt).
 * @param {Map<string, string>} cache lid-user → pn JID
 * @param {object} key
 */
export function rememberWhatsappLidPnPairs(cache, key) {
  if (!cache || !key || typeof key !== 'object') return;
  const pairs = [
    [key.remoteJid, key.remoteJidAlt],
    [key.participant, key.participantAlt],
    [key.remoteJidAlt, key.remoteJid],
    [key.participantAlt, key.participant],
  ];
  for (const [left, right] of pairs) {
    if (isWhatsappLidJid(left) && isWhatsappPnJid(right)) {
      const decoded = jidDecode(left);
      if (decoded?.user) cache.set(decoded.user, right);
    }
  }
}

async function lookupPnForLid(socket, cache, lid) {
  const decoded = jidDecode(lid);
  if (!decoded?.user) return null;
  const cached = cache?.get(decoded.user);
  if (cached) return cached;
  const mapping = socket?.signalRepository?.lidMapping;
  if (!mapping || typeof mapping.getPNForLID !== 'function') return null;
  try {
    const pn = await mapping.getPNForLID(lid);
    if (typeof pn === 'string' && pn) {
      cache?.set(decoded.user, pn);
      return pn;
    }
  } catch {
    // Mapping misses stay fail-closed for that alias only.
  }
  return null;
}

async function lookupLidForPn(socket, pn) {
  const mapping = socket?.signalRepository?.lidMapping;
  if (!mapping || typeof mapping.getLIDForPN !== 'function') return null;
  try {
    const lid = await mapping.getLIDForPN(pn);
    return typeof lid === 'string' && lid ? lid : null;
  } catch {
    return null;
  }
}

/**
 * Expand inbound WhatsApp identities with PN/LID aliases and re-evaluate
 * group @mention against the linked account.
 *
 * @param {object|null} message normalizeWhatsappMessage result
 * @param {object} raw Baileys WAMessage
 * @param {{ accountJid: string, socket?: object, lidPnCache?: Map<string, string> }} options
 * @returns {Promise<object|null>}
 */
export async function enrichWhatsappInboundIdentities(message, raw, {
  accountJid,
  socket,
  lidPnCache,
} = {}) {
  if (!message) return null;
  if (raw?.key) rememberWhatsappLidPnPairs(lidPnCache, raw.key);

  const aliasIds = new Set();
  if (typeof message.senderAlternateId === 'string' && message.senderAlternateId) {
    aliasIds.add(message.senderAlternateId);
  }

  for (const candidate of [message.senderId, message.senderAlternateId]) {
    if (!isWhatsappLidJid(candidate)) continue;
    const pn = await lookupPnForLid(socket, lidPnCache, candidate);
    if (pn) aliasIds.add(pn);
  }

  let addressed = message.addressed === true;
  if (message.kind === 'group' && addressed !== true) {
    const content = raw?.message;
    let current = content;
    let context = null;
    for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
      context = current.extendedTextMessage?.contextInfo
        ?? current.imageMessage?.contextInfo
        ?? current.videoMessage?.contextInfo
        ?? current.documentMessage?.contextInfo
        ?? null;
      if (context) break;
      const wrapper = ['ephemeralMessage', 'viewOnceMessage', 'documentWithCaptionMessage',
        'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'editedMessage',
        'associatedChildMessage', 'groupStatusMessage', 'groupStatusMessageV2']
        .find((key) => current[key]?.message);
      if (!wrapper) break;
      current = current[wrapper].message;
    }
    const mentioned = Array.isArray(context?.mentionedJid) ? context.mentionedJid : [];
    const accountLid = await lookupLidForPn(socket, accountJid);
    for (const jid of mentioned) {
      if (typeof jid !== 'string' || !jid) continue;
      try {
        if (areJidsSameUser(jid, accountJid) === true) {
          addressed = true;
          break;
        }
      } catch {
        // continue
      }
      if (accountLid) {
        try {
          if (areJidsSameUser(jid, accountLid) === true) {
            addressed = true;
            break;
          }
        } catch {
          // continue
        }
      }
      if (isWhatsappLidJid(jid)) {
        const pn = await lookupPnForLid(socket, lidPnCache, jid);
        if (pn) {
          try {
            if (areJidsSameUser(pn, accountJid) === true) {
              addressed = true;
              break;
            }
          } catch {
            // continue
          }
        }
      }
    }
  }

  aliasIds.delete(message.senderId);
  const senderAliasIds = [...aliasIds];
  return {
    ...message,
    addressed,
    ...(senderAliasIds.length > 0 ? { senderAliasIds } : {}),
    ...(senderAliasIds[0] && !message.senderAlternateId
      ? { senderAlternateId: senderAliasIds[0] }
      : {}),
  };
}
