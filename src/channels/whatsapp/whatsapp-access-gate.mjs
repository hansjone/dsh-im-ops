/**
 * WhatsApp ops access gate: phone grants, pending notify, quote approve/deny.
 */

import {
  ACCESS_GRANT_COPY,
  approverPhonesForPending,
  attachPendingNotifyRefs,
  emptyAccessGrant,
  enqueueAccessPending,
  ensureGroupBucket,
  ensureOwnerGlobalAdmin,
  evaluateAccessGrant,
  findPendingByNotifyMessageId,
  formatPendingNotifyBody,
  migrateAccessPolicyToGrant,
  normalizeAccessPhone,
  parseApprovalIntent,
  parsePendingIdFromNotifyText,
  phoneFromWhatsappJid,
  resolveAccessPending,
  upsertAccessContact,
} from '../shared/access-grant.mjs';
import { isSharedLocalCommand } from '../shared/command-permission.mjs';
import { isWhatsappLidJid } from './whatsapp-identity.mjs';

/**
 * Resolve canonical phone from an enriched inbound message.
 * @param {object} message
 * @returns {{ phone: string|null, lid: string|null }}
 */
export function resolveInboundPhone(message) {
  const candidates = [
    message?.senderId,
    message?.senderAlternateId,
    ...(Array.isArray(message?.senderAliasIds) ? message.senderAliasIds : []),
  ];
  let lid = null;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue;
    if (isWhatsappLidJid(candidate)) {
      lid = lid ?? candidate;
      continue;
    }
    const phone = phoneFromWhatsappJid(candidate) ?? normalizeAccessPhone(candidate);
    if (phone) return { phone, lid };
  }
  return { phone: null, lid };
}

function quotedNotifyId(raw) {
  const context = raw?.message?.extendedTextMessage?.contextInfo
    ?? raw?.message?.imageMessage?.contextInfo
    ?? null;
  const stanzaId = typeof context?.stanzaId === 'string' ? context.stanzaId.trim() : '';
  return stanzaId || null;
}

function quotedNotifyText(raw) {
  const quoted = raw?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return '';
  return quoted.conversation
    ?? quoted.extendedTextMessage?.text
    ?? '';
}

/**
 * Load or seed the bot access grant document.
 * @param {{ workspaces: object, botId: string, accountJid: string, accessPolicy?: object|null }} input
 */
export async function loadWhatsappAccessGrant({
  workspaces,
  botId,
  accountJid,
  accessPolicy = null,
}) {
  const ownerPhone = phoneFromWhatsappJid(accountJid);
  let grant = workspaces.accessGrantFor(botId);
  if (!grant) {
    grant = migrateAccessPolicyToGrant(
      accessPolicy ?? workspaces.accessPolicyFor?.(botId),
      null,
      ownerPhone,
    );
    await workspaces.setAccessGrant(botId, grant);
    return grant;
  }
  const seeded = ensureOwnerGlobalAdmin(grant, ownerPhone);
  if (seeded !== grant && JSON.stringify(seeded) !== JSON.stringify(grant)) {
    await workspaces.setAccessGrant(botId, seeded);
    return seeded;
  }
  return grant;
}

/**
 * Persist contact sighting and return updated grant.
 */
export async function rememberWhatsappContact(workspaces, botId, grant, message, { phone, lid }) {
  if (!phone && !lid) return grant;
  const pushName = message.contextSource?.()?.senderName;
  try {
    if (typeof workspaces.mutateAccessGrant === 'function') {
      return await workspaces.mutateAccessGrant(botId, (current) => {
        const base = current ?? grant;
        return upsertAccessContact(base, {
          phone,
          lid,
          pushName,
          scene: message.kind === 'group' ? 'group' : 'direct',
          groupJid: message.kind === 'group' ? message.conversationId : undefined,
        });
      });
    }
    const next = upsertAccessContact(grant, {
      phone,
      lid,
      pushName,
      scene: message.kind === 'group' ? 'group' : 'direct',
      groupJid: message.kind === 'group' ? message.conversationId : undefined,
    });
    await workspaces.setAccessGrant(botId, next);
    return next;
  } catch {
    // Contact directory is best-effort and must not block chat.
    return grant;
  }
}

/**
 * Try to handle an admin quote-reply approval before normal chat.
 * @returns {Promise<boolean>} true if consumed
 */
export async function tryHandleWhatsappApprovalReply({
  workspaces,
  botId,
  grant,
  message,
  raw,
  sendText,
  accountJid,
}) {
  const { phone } = resolveInboundPhone(message);
  if (!phone || message.kind !== 'direct') return false;
  const intent = parseApprovalIntent(message.content);
  if (!intent) return false;

  const notifyId = quotedNotifyId(raw);
  let pending = notifyId ? findPendingByNotifyMessageId(grant, notifyId) : null;
  if (!pending) {
    const pendingId = parsePendingIdFromNotifyText(quotedNotifyText(raw));
    if (pendingId) {
      pending = (grant.pending ?? []).find((entry) => entry.id === pendingId) ?? null;
    }
  }
  if (!pending || pending.status !== 'pending') return false;

  try {
    let resolved = pending;
    if (typeof workspaces.mutateAccessGrant === 'function') {
      await workspaces.mutateAccessGrant(botId, (current) => {
        const result = resolveAccessPending(current ?? grant, {
          pendingId: pending.id,
          action: intent,
          resolvedByPhone: phone,
        });
        resolved = result.pending;
        return result.grant;
      });
    } else {
      const result = resolveAccessPending(grant, {
        pendingId: pending.id,
        action: intent,
        resolvedByPhone: phone,
      });
      resolved = result.pending;
      await workspaces.setAccessGrant(botId, result.grant);
    }
    await sendText(
      { jid: message.replyTarget?.jid ?? `${phone}@s.whatsapp.net` },
      intent === 'approve' ? ACCESS_GRANT_COPY.adminApproved : ACCESS_GRANT_COPY.adminDenied,
    );
    const requesterJid = resolved.phone
      ? `${resolved.phone}@s.whatsapp.net`
      : (resolved.lid ?? null);
    if (requesterJid) {
      const body = intent === 'approve'
        ? (resolved.kind === 'group'
          ? ACCESS_GRANT_COPY.approvedGroup
          : ACCESS_GRANT_COPY.approvedDirect)
        : ACCESS_GRANT_COPY.denied;
      try {
        await sendText({ jid: requesterJid }, body);
      } catch {
        // Requester notify is best-effort.
      }
    }
    return true;
  } catch (error) {
    if (error?.code === 'pending-forbidden' || error?.code === 'pending-expired'
      || error?.code === 'pending-unresolved' || error?.code === 'pending-not-found') {
      await sendText(
        { jid: message.replyTarget?.jid ?? `${phone}@s.whatsapp.net` },
        error.message || '无法处理该审批。',
      );
      return true;
    }
    throw error;
  }
}

/**
 * Evaluate grant; on deny create pending + notify admins.
 * @returns {Promise<{ allowed: boolean, reason: string, grant: object, accessDecision?: object }>}
 */
export async function gateWhatsappInbound({
  workspaces,
  botId,
  grant,
  message,
  sendText,
  accountJid,
  resolveGroupTitle,
}) {
  const { phone, lid } = resolveInboundPhone(message);
  const scene = message.kind === 'group' ? 'group' : 'direct';
  const addressed = scene === 'direct' || message.addressed === true;
  let current = grant;

  // Only people who DM the bot or @ it in a group enter the contact directory.
  if (addressed) {
    current = await rememberWhatsappContact(workspaces, botId, current, message, { phone, lid });
  }
  if (scene === 'group' && addressed && message.conversationId) {
    let title = message.contextSource?.()?.conversationTitle;
    const existingTitle = current.groups?.[message.conversationId]?.title;
    if (!title && !existingTitle && typeof resolveGroupTitle === 'function') {
      try {
        title = await resolveGroupTitle(message.conversationId);
      } catch {
        title = '';
      }
    }
    const withGroup = ensureGroupBucket(current, message.conversationId, {
      ...(title ? { title } : {}),
    });
    if (withGroup !== current) {
      current = withGroup;
      await workspaces.setAccessGrant(botId, current);
    }
  }

  const isCommand = isSharedLocalCommand(message.content ?? '', {
    hasImages: Array.isArray(message.images) && message.images.length > 0,
    hasFiles: Array.isArray(message.files) && message.files.length > 0,
  });
  const decision = evaluateAccessGrant(current, {
    scene,
    phone,
    groupJid: scene === 'group' ? message.conversationId : undefined,
    isCommand,
  });

  if (decision.allowed) {
    return {
      allowed: true,
      reason: decision.reason,
      grant: current,
      accessDecision: {
        allowed: true,
        reason: decision.reason,
      },
    };
  }

  if (decision.reason === 'command-not-allowed') {
    return {
      allowed: false,
      reason: decision.reason,
      grant: current,
      accessDecision: {
        allowed: false,
        reason: 'command-not-allowed',
      },
    };
  }

  // Unaddressed group spam: do not create pending.
  if (!addressed) {
    return { allowed: false, reason: 'group-unaddressed', grant: current };
  }

  let pending;
  let created = false;
  if (typeof workspaces.mutateAccessGrant === 'function') {
    let enqueued = null;
    current = await workspaces.mutateAccessGrant(botId, (latest) => {
      enqueued = enqueueAccessPending(latest ?? current, {
        kind: scene,
        groupJid: scene === 'group' ? message.conversationId : undefined,
        phone: phone ?? '',
        lid: lid ?? undefined,
        pushName: message.contextSource?.()?.senderName,
        requestText: message.content,
      });
      return enqueued.grant;
    });
    pending = enqueued.pending;
    created = enqueued.created;
  } else {
    const enqueued = enqueueAccessPending(current, {
      kind: scene,
      groupJid: scene === 'group' ? message.conversationId : undefined,
      phone: phone ?? '',
      lid: lid ?? undefined,
      pushName: message.contextSource?.()?.senderName,
      requestText: message.content,
    });
    current = enqueued.grant;
    pending = enqueued.pending;
    created = enqueued.created;
    await workspaces.setAccessGrant(botId, current);
  }

  const ack = !phone
    ? ACCESS_GRANT_COPY.pendingUnresolved
    : (scene === 'group'
      ? ACCESS_GRANT_COPY.pendingAckGroup
      : ACCESS_GRANT_COPY.pendingAckDirect);
  try {
    await sendText(message.replyTarget, ack);
  } catch {
    // Ack is best-effort.
  }

  if (created) {
    const admins = approverPhonesForPending(current, pending);
    const body = formatPendingNotifyBody(pending);
    const refs = [];
    for (const adminPhone of admins) {
      // Never DM the linked bot account as if it were a peer when it is the only self-chat path.
      const jid = `${adminPhone}@s.whatsapp.net`;
      try {
        const result = await sendText({
          jid,
          selfChat: adminPhone === phoneFromWhatsappJid(accountJid),
        }, body);
        const providerMessageId = result?.providerMessageIds?.[0]
          ?? result?.key?.id
          ?? result?.providerMessageId
          ?? null;
        if (providerMessageId) {
          refs.push({ adminPhone, providerMessageId: String(providerMessageId) });
        }
      } catch {
        // Continue notifying other admins.
      }
    }
    if (refs.length > 0) {
      if (typeof workspaces.mutateAccessGrant === 'function') {
        current = await workspaces.mutateAccessGrant(botId, (latest) => (
          attachPendingNotifyRefs(latest ?? current, pending.id, refs)
        ));
      } else {
        current = attachPendingNotifyRefs(current, pending.id, refs);
        await workspaces.setAccessGrant(botId, current);
      }
    }
  }

  return {
    allowed: false,
    reason: decision.reason,
    grant: current,
  };
}

export { emptyAccessGrant, loadWhatsappAccessGrant as ensureWhatsappAccessGrant };
