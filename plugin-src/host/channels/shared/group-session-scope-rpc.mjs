import { validateGroupSessionScope } from '../../../../src/channels/shared/session-scope.mjs';

export const SET_GROUP_SESSION_SCOPE_ENDPOINT = 'bot.group-session-scope.set';

export function validGroupSessionScopePayload(payload) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Reflect.ownKeys(payload).length !== 2
      || !Object.hasOwn(payload, 'botId') || !Object.hasOwn(payload, 'groupSessionScope')
      || typeof payload.botId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.botId)) return false;
    validateGroupSessionScope(payload.groupSessionScope);
    return true;
  } catch {
    return false;
  }
}
