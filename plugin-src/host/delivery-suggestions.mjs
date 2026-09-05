const CHANNELS = new Set([
  'weixin',
  'feishu',
  'dingtalk',
  'wecom',
  'qq',
  'slack',
  'telegram',
  'discord',
  'whatsapp',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function opaqueId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    && !/[\s:\u0000-\u001f\u007f]/u.test(value);
}

function afterPrefix(key, prefix) {
  const marker = `${prefix}:`;
  if (!key.startsWith(marker)) return null;
  const value = key.slice(marker.length);
  return opaqueId(value) ? value : null;
}

function simpleSuggestion(key, definitions) {
  for (const [prefix, kind, field] of definitions) {
    const value = afterPrefix(key, prefix);
    if (value) return { kind, route: { [field]: value } };
  }
  return null;
}

function feishuSuggestion(key) {
  const openId = afterPrefix(key, 'p2p');
  if (openId?.startsWith('ou_')) {
    return { kind: 'user', route: { openId } };
  }
  return simpleSuggestion(key, [['group', 'group', 'chatId']]);
}

function slackSuggestion(key) {
  const directChannel = afterPrefix(key, 'direct');
  if (directChannel && /^[A-Za-z0-9_-]{1,128}$/.test(directChannel)) {
    return { kind: 'conversation', route: { channelId: directChannel } };
  }
  const match = /^group:([^:]+):(\d{1,20}(?:\.\d{1,20})?)$/.exec(key);
  if (!match || !/^[A-Za-z0-9_-]{1,128}$/.test(match[1])) return null;
  return { kind: 'thread', route: { channelId: match[1], threadTs: match[2] } };
}

function telegramSuggestion(key) {
  const match = /^(direct|group):(-?\d+)(?::([1-9]\d*))?$/.exec(key);
  if (!match) return null;
  const chatId = Number(match[2]);
  if (!Number.isSafeInteger(chatId)) return null;
  if (match[1] === 'direct' && match[3] !== undefined) return null;
  if (match[3] === undefined) return { kind: 'chat', route: { chatId: match[2] } };
  const messageThreadId = Number(match[3]);
  if (!Number.isSafeInteger(messageThreadId) || messageThreadId <= 0) return null;
  return { kind: 'topic', route: { chatId: match[2], messageThreadId } };
}

function discordSuggestion(key) {
  const match = /^(?:direct|group):(\d{1,32})$/.exec(key);
  return match ? { kind: 'channel', route: { channelId: match[1] } } : null;
}

function whatsappSuggestion(key) {
  const direct = /^direct:(\d{5,32}@(s\.whatsapp\.net|lid))$/.exec(key);
  if (direct) return { kind: 'user', route: { jid: direct[1] } };
  const group = /^group:(\d{5,32}(?:-\d{1,32})?@g\.us)$/.exec(key);
  return group ? { kind: 'group', route: { jid: group[1] } } : null;
}

/** Convert one persisted conversation key into a stable proactive-delivery route. */
export function deliverySuggestionFromConversationKey(channel, key) {
  if (!CHANNELS.has(channel) || typeof key !== 'string') return null;
  switch (channel) {
    case 'weixin':
      return simpleSuggestion(key, [['p2p', 'user', 'toUserId']]);
    case 'feishu':
      return feishuSuggestion(key);
    case 'dingtalk':
      return simpleSuggestion(key, [
        ['p2p', 'user', 'userId'],
        ['group', 'group', 'openConversationId'],
      ]);
    case 'wecom':
      return simpleSuggestion(key, [
        ['direct', 'user', 'chatId'],
        ['group', 'group', 'chatId'],
      ]);
    case 'qq':
      return simpleSuggestion(key, [
        ['c2c', 'user', 'userOpenId'],
        ['group', 'group', 'groupOpenId'],
      ]);
    case 'slack':
      return slackSuggestion(key);
    case 'telegram':
      return telegramSuggestion(key);
    case 'discord':
      return discordSuggestion(key);
    case 'whatsapp':
      return whatsappSuggestion(key);
    default:
      return null;
  }
}

/**
 * Extract and de-duplicate stable delivery routes from a persisted sessions map.
 * Session ids and every other state field are intentionally ignored.
 */
export function deliverySuggestionsFromSessions(channel, sessions) {
  if (!CHANNELS.has(channel) || !isRecord(sessions)) return [];
  const suggestions = [];
  const seen = new Set();
  for (const key of Object.keys(sessions)) {
    const suggestion = deliverySuggestionFromConversationKey(channel, key);
    if (!suggestion) continue;
    const identity = JSON.stringify(suggestion);
    if (seen.has(identity)) continue;
    seen.add(identity);
    suggestions.push(suggestion);
  }
  return suggestions;
}

function clipName(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, 80) : '';
}

/** Prefer「昵称 · 电话」so ops pickers can tell people apart. */
export function whatsappUserDisplayName(pushName, phone) {
  const nick = clipName(pushName);
  const number = typeof phone === 'string' ? phone.trim() : '';
  if (nick && number) return clipName(`${nick} · ${number}`);
  if (nick) return nick;
  if (number) return number;
  return '';
}

function whatsappGroupDisplayName(title, jid) {
  const name = clipName(title);
  if (name) return name;
  const raw = typeof jid === 'string' ? jid.trim() : '';
  if (!raw) return '';
  const local = raw.includes('@') ? raw.slice(0, raw.indexOf('@')) : raw;
  if (local.length <= 10) return clipName(`群 · ${local}`);
  return clipName(`群 · ${local.slice(0, 6)}…${local.slice(-4)}`);
}

function suggestionKey(suggestion) {
  return `${suggestion?.kind ?? ''}\0${suggestion?.route?.jid ?? ''}`;
}

/**
 * Merge WhatsApp session routes with access-grant contacts/groups so the
 * delivery picker shows nickname+phone and known groups, not only opaque JIDs.
 *
 * @param {Array<{ kind: string, route: { jid: string }, name?: string }>} sessionSuggestions
 * @param {object|null|undefined} grant - WhatsApp accessGrant document
 * @returns {Array<{ kind: string, route: { jid: string }, name?: string }>}
 */
export function enrichWhatsappDeliverySuggestions(sessionSuggestions, grant) {
  const byKey = new Map();
  const lidToPhone = new Map();
  const contacts = Array.isArray(grant?.contacts) ? grant.contacts : [];
  for (const contact of contacts) {
    const phone = typeof contact?.phone === 'string' ? contact.phone.trim() : '';
    if (!phone) continue;
    for (const lid of Array.isArray(contact.lids) ? contact.lids : []) {
      const id = typeof lid === 'string' ? lid.trim() : '';
      if (id) lidToPhone.set(id, phone);
    }
  }

  const put = (suggestion) => {
    if (!suggestion?.kind || !suggestion?.route?.jid) return;
    const key = suggestionKey(suggestion);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, suggestion);
      return;
    }
    if (!previous.name && suggestion.name) byKey.set(key, { ...previous, name: suggestion.name });
    else if (previous.name && suggestion.name && suggestion.name.length > previous.name.length) {
      byKey.set(key, { ...previous, name: suggestion.name });
    }
  };

  for (const raw of Array.isArray(sessionSuggestions) ? sessionSuggestions : []) {
    if (raw?.kind === 'user' && typeof raw?.route?.jid === 'string') {
      const jid = raw.route.jid;
      const lidMatch = /^(\d{5,32})@lid$/.exec(jid);
      if (lidMatch) {
        const phone = lidToPhone.get(lidMatch[1]);
        if (phone) {
          put({
            kind: 'user',
            route: { jid: `${phone}@s.whatsapp.net` },
            ...(raw.name ? { name: clipName(raw.name) } : {}),
          });
          continue;
        }
      }
    }
    put({
      kind: raw.kind,
      route: { jid: raw.route.jid },
      ...(raw.name ? { name: clipName(raw.name) } : {}),
    });
  }

  for (const contact of contacts) {
    const phone = typeof contact?.phone === 'string' ? contact.phone.trim() : '';
    const lids = Array.isArray(contact?.lids)
      ? contact.lids.map((lid) => String(lid ?? '').trim()).filter(Boolean)
      : [];
    const name = whatsappUserDisplayName(contact?.pushName, phone);
    if (phone) {
      put({
        kind: 'user',
        route: { jid: `${phone}@s.whatsapp.net` },
        ...(name ? { name } : {}),
      });
      continue;
    }
    for (const lid of lids.slice(0, 1)) {
      put({
        kind: 'user',
        route: { jid: `${lid}@lid` },
        ...(name ? { name } : {}),
      });
    }
  }

  const groups = grant?.groups && typeof grant.groups === 'object' && !Array.isArray(grant.groups)
    ? grant.groups
    : {};
  for (const [groupJid, entry] of Object.entries(groups)) {
    if (typeof groupJid !== 'string' || !/^\d{5,32}(?:-\d{1,32})?@g\.us$/.test(groupJid)) continue;
    const name = whatsappGroupDisplayName(entry?.title, groupJid);
    put({
      kind: 'group',
      route: { jid: groupJid },
      ...(name ? { name } : {}),
    });
  }

  const rows = [...byKey.values()];
  rows.sort((left, right) => (
    String(left.kind).localeCompare(String(right.kind))
    || String(left.name || '').localeCompare(String(right.name || ''), 'zh')
    || String(left.route.jid).localeCompare(String(right.route.jid))
  ));
  return rows;
}
