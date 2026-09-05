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
 * Collect local-part tokens for the linked bot account (PN and LID).
 * Used only to strip trigger @mentions from inbound text — not context injection.
 * @param {string} accountJid
 * @param {string[]} mentionedJids
 * @param {string|null} accountLid
 * @returns {string[]}
 */
export function whatsappBotMentionTokens(accountJid, mentionedJids = [], accountLid = null) {
  const tokens = new Set();
  const add = (jid) => {
    if (typeof jid !== 'string' || !jid) return;
    const decoded = jidDecode(jid.trim());
    if (decoded?.user && /^\d+$/.test(decoded.user)) tokens.add(decoded.user);
  };
  add(accountJid);
  add(accountLid);
  for (const jid of mentionedJids) {
    if (typeof jid !== 'string' || !jid) continue;
    let matchesBot = false;
    try {
      matchesBot = areJidsSameUser(jid, accountJid) === true;
    } catch {
      matchesBot = false;
    }
    if (!matchesBot && accountLid) {
      try {
        matchesBot = areJidsSameUser(jid, accountLid) === true;
      } catch {
        matchesBot = false;
      }
    }
    if (matchesBot) add(jid);
  }
  return [...tokens];
}

/**
 * Remove WhatsApp @bot trigger tokens from plain text (e.g. `@1627…` / leading LID).
 * Does not add sender identity — that belongs to optional context enhancement.
 * @param {string} text
 * @param {string[]} tokens
 * @returns {string}
 */
export function stripWhatsappBotMentionText(text, tokens) {
  if (typeof text !== 'string' || !text || !Array.isArray(tokens) || tokens.length === 0) {
    return typeof text === 'string' ? text : '';
  }
  let result = text;
  for (const token of tokens) {
    if (!/^\d{5,32}$/.test(token)) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`@${escaped}\\b[\\u200e\\u200f\\s]*`, 'gu'), '');
    result = result.replace(new RegExp(`^${escaped}\\b[\\u200e\\u200f\\s]*`, 'u'), '');
  }
  return result.replace(/[ \t]{2,}/g, ' ').trim();
}

function inboundMentionContext(rawMessage) {
  let current = rawMessage;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const context = current.extendedTextMessage?.contextInfo
      ?? current.imageMessage?.contextInfo
      ?? current.videoMessage?.contextInfo
      ?? current.documentMessage?.contextInfo
      ?? null;
    if (context) return context;
    const wrapper = ['ephemeralMessage', 'viewOnceMessage', 'documentWithCaptionMessage',
      'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'editedMessage',
      'associatedChildMessage', 'groupStatusMessage', 'groupStatusMessageV2']
      .find((key) => current[key]?.message);
    if (!wrapper) return null;
    current = current[wrapper].message;
  }
  return null;
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

  const context = inboundMentionContext(raw?.message);
  const mentioned = Array.isArray(context?.mentionedJid) ? context.mentionedJid : [];
  const accountLid = await lookupLidForPn(socket, accountJid);

  let addressed = message.addressed === true;
  if (message.kind === 'group' && addressed !== true) {
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

  const botTokens = whatsappBotMentionTokens(accountJid, mentioned, accountLid);
  const content = stripWhatsappBotMentionText(message.content, botTokens);

  aliasIds.delete(message.senderId);
  const senderAliasIds = [...aliasIds];
  return {
    ...message,
    content,
    addressed,
    ...(senderAliasIds.length > 0 ? { senderAliasIds } : {}),
    ...(senderAliasIds[0] && !message.senderAlternateId
      ? { senderAlternateId: senderAliasIds[0] }
      : {}),
  };
}

/**
 * Resolve a WhatsApp group subject for display / access-grant group cards.
 * @param {{ groupMetadata?: (jid: string) => Promise<{ subject?: string }> }|null|undefined} socket
 * @param {string} groupJid
 * @returns {Promise<string>}
 */
export async function resolveWhatsappGroupSubject(socket, groupJid) {
  if (!socket || typeof socket.groupMetadata !== 'function') return '';
  if (typeof groupJid !== 'string' || !groupJid.endsWith('@g.us')) return '';
  try {
    const meta = await socket.groupMetadata(groupJid);
    const subject = typeof meta?.subject === 'string' ? meta.subject.trim() : '';
    return subject.slice(0, 128);
  } catch {
    return '';
  }
}
