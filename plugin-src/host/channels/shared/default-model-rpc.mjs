import { normalizeDefaultModel } from '../../../../src/channels/shared/default-model.mjs';

export const SET_DEFAULT_MODEL_ENDPOINT = 'bot.model.set';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validDefaultModelPayload(payload) {
  if (!isRecord(payload)
    || !Object.keys(payload).every((key) => ['botId', 'defaultModel'].includes(key))
    || typeof payload.botId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.botId)) {
    return false;
  }
  if (payload.defaultModel === null) return true;
  return Boolean(normalizeDefaultModel(payload.defaultModel));
}

export function publicDefaultModelError(error) {
  if (![
    'default-model-invalid',
    'default-model-unavailable',
    'workspace-bot-not-found',
  ].includes(error?.code)) return null;
  return { code: error.code, message: error.message };
}
