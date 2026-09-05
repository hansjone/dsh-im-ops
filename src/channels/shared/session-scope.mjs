/**
 * Group conversation → Harness Session key policy (oclaw-aligned).
 *
 * - `chat`: one Session per group (`group:<conversationId>`) — upstream dsh-im default
 * - `user_in_chat`: one Session per speaker in a group (`group:<conversationId>:user:<senderId>`)
 */

export const GROUP_SESSION_SCOPES = Object.freeze(['chat', 'user_in_chat']);

/** Ops-fork default: isolate concurrent operators in the same WhatsApp/ops group. */
export const DEFAULT_GROUP_SESSION_SCOPE = 'user_in_chat';

/**
 * @param {unknown} value
 * @returns {'chat' | 'user_in_chat'}
 */
export function normalizeGroupSessionScope(value) {
  const scope = String(value ?? '').trim().toLowerCase();
  if (scope === 'chat' || scope === 'shared' || scope === 'shared_chat') return 'chat';
  if (scope === 'user_in_chat' || scope === 'user' || scope === 'per_user' || scope === 'member') {
    return 'user_in_chat';
  }
  return DEFAULT_GROUP_SESSION_SCOPE;
}

/**
 * @param {unknown} value
 * @returns {'chat' | 'user_in_chat'}
 */
export function validateGroupSessionScope(value) {
  const scope = String(value ?? '').trim().toLowerCase();
  if (scope === 'chat' || scope === 'user_in_chat') return scope;
  const error = new TypeError(`Invalid group session scope: ${String(value)}`);
  error.code = 'invalid-group-session-scope';
  throw error;
}

/**
 * Build the durable conversation key used for session binding and queues.
 * @param {{ kind: string, conversationId: string, senderId: string, groupSessionScope?: string }} input
 * @returns {string}
 */
export function conversationKeyFor({
  kind,
  conversationId,
  senderId,
  groupSessionScope = DEFAULT_GROUP_SESSION_SCOPE,
}) {
  const conversation = String(conversationId ?? '').trim();
  const sender = String(senderId ?? '').trim();
  if (!conversation) throw new TypeError('conversationId is required');
  if (kind === 'group') {
    const scope = normalizeGroupSessionScope(groupSessionScope);
    if (scope === 'user_in_chat') {
      if (!sender) throw new TypeError('senderId is required for user_in_chat group sessions');
      return `group:${conversation}:user:${sender}`;
    }
    return `group:${conversation}`;
  }
  return `direct:${conversation}`;
}
