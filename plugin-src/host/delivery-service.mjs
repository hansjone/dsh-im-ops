import { normalizeDeliveryTarget } from './delivery-adapter.mjs';

const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const DRAFT_TARGET_ID = '__test__';

const ADAPTER_METHODS = Object.freeze([
  'ownsBot',
  'listTargets',
  'listSuggestions',
  'createTarget',
  'updateTarget',
  'deleteTarget',
  'sendText',
]);

const DELIVERY_ERROR_CODES = new Set([
  'bad-request',
  'unknown-bot',
  'unknown-target',
  'target-conflict',
  'invalid-target',
  'bot-not-connected',
  'target-rejected',
  'delivery-failed',
  'cancelled',
]);

function deliveryError(code, message = code, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function botIdOf(value) {
  if (typeof value !== 'string' || !BOT_ID_PATTERN.test(value)) {
    throw deliveryError('bad-request', 'Invalid bot id');
  }
  return value;
}

function targetIdOf(value) {
  if (typeof value !== 'string' || !TARGET_ID_PATTERN.test(value)) {
    throw deliveryError('bad-request', 'Invalid target id');
  }
  return value;
}

function targetObject(value, { includesTargetId } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw deliveryError('bad-request', 'Invalid target');
  }
  if (includesTargetId) targetIdOf(value.targetId);
  else if (Object.hasOwn(value, 'targetId')) {
    throw deliveryError('bad-request', 'A target id cannot be changed');
  }
  return value;
}

function draftTargetObject(value) {
  targetObject(value);
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('route')) {
    throw deliveryError('bad-request', 'Invalid draft target');
  }
  return value;
}

function cancellation(signal) {
  if (signal?.aborted) throw deliveryError('cancelled', 'Request cancelled');
}

function publicOperationError(error, fallback = 'delivery-failed') {
  if (error?.code === 'workspace-bot-not-found') {
    return deliveryError('unknown-bot', 'Unknown bot', { cause: error });
  }
  if (DELIVERY_ERROR_CODES.has(error?.code)) return error;
  return deliveryError(fallback, fallback, { cause: error });
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object'
    || typeof adapter.channel !== 'string' || !CHANNEL_PATTERN.test(adapter.channel)) {
    throw new TypeError('A delivery adapter with a valid channel is required');
  }
  for (const method of ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`A complete delivery adapter is required (${method})`);
    }
  }
  return adapter;
}

export class DeliveryService {
  #adapters = new Map();

  registerAdapter(value) {
    const adapter = validateAdapter(value);
    const registration = Object.freeze({ adapter });
    this.#adapters.set(adapter.channel, registration);
    return () => {
      if (this.#adapters.get(adapter.channel) !== registration) return false;
      this.#adapters.delete(adapter.channel);
      return true;
    };
  }

  async listTargets(botId) {
    const id = botIdOf(botId);
    const adapter = await this.#adapterFor(id);
    try {
      const targets = await adapter.listTargets(id);
      if (!Array.isArray(targets)) throw new TypeError('Adapter returned invalid targets');
      return { botId: id, channel: adapter.channel, targets };
    } catch (error) {
      throw publicOperationError(error);
    }
  }

  /**
   * List every saved delivery target across registered channel adapters.
   * @returns {Promise<Array<{ botId: string, targetId: string, name: string, kind: string, channel: string }>>}
   */
  async listCatalog() {
    const rows = [];
    const seen = new Set();
    for (const { adapter } of this.#adapters.values()) {
      if (typeof adapter.listAllTargets !== 'function') continue;
      let list;
      try {
        list = await adapter.listAllTargets();
      } catch {
        continue;
      }
      if (!Array.isArray(list)) continue;
      for (const row of list) {
        const botId = typeof row?.botId === 'string' ? row.botId.trim() : '';
        const targetId = typeof row?.targetId === 'string' ? row.targetId.trim() : '';
        if (!botId || !targetId) continue;
        const key = `${botId}\0${targetId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          botId,
          targetId,
          name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : targetId,
          kind: typeof row.kind === 'string' ? row.kind : '',
          channel: typeof row.channel === 'string' ? row.channel : adapter.channel,
        });
      }
    }
    rows.sort((left, right) => (
      left.channel.localeCompare(right.channel)
      || left.name.localeCompare(right.name)
      || left.targetId.localeCompare(right.targetId)
    ));
    return rows;
  }

  async listSuggestions(botId) {
    const id = botIdOf(botId);
    const adapter = await this.#adapterFor(id);
    try {
      const suggestions = await adapter.listSuggestions(id);
      if (!Array.isArray(suggestions)) throw new TypeError('Adapter returned invalid suggestions');
      return {
        botId: id,
        channel: adapter.channel,
        suggestions: suggestions.map((suggestion) => normalizeDeliveryTarget(
          adapter.channel,
          suggestion,
          { targetIdRequired: false },
        )),
      };
    } catch (error) {
      throw publicOperationError(error);
    }
  }

  async createTarget(botId, target) {
    const id = botIdOf(botId);
    targetObject(target, { includesTargetId: true });
    const adapter = await this.#adapterFor(id);
    try {
      return await adapter.createTarget(id, target);
    } catch (error) {
      throw publicOperationError(error);
    }
  }

  async updateTarget(botId, targetId, replacement) {
    const id = botIdOf(botId);
    const targetKey = targetIdOf(targetId);
    targetObject(replacement);
    const adapter = await this.#adapterFor(id);
    try {
      return await adapter.updateTarget(id, targetKey, replacement);
    } catch (error) {
      throw publicOperationError(error);
    }
  }

  async deleteTarget(botId, targetId) {
    const id = botIdOf(botId);
    const targetKey = targetIdOf(targetId);
    const adapter = await this.#adapterFor(id);
    try {
      await adapter.deleteTarget(id, targetKey);
      return { deleted: true };
    } catch (error) {
      throw publicOperationError(error);
    }
  }

  async send(botId, targetIdOrDraft, text, { signal, mentions } = {}) {
    const id = botIdOf(botId);
    const targetKey = typeof targetIdOrDraft === 'string'
      ? targetIdOf(targetIdOrDraft)
      : null;
    const draft = targetKey === null ? draftTargetObject(targetIdOrDraft) : null;
    if (typeof text !== 'string' || !text.trim()) {
      throw deliveryError('bad-request', 'Message text is required');
    }
    cancellation(signal);
    const adapter = await this.#adapterFor(id);
    try {
      let target;
      if (draft) {
        target = { targetId: DRAFT_TARGET_ID, ...draft };
      } else {
        const targets = await adapter.listTargets(id);
        if (!Array.isArray(targets)) throw new TypeError('Adapter returned invalid targets');
        target = targets.find((candidate) => candidate?.targetId === targetKey);
        if (!target) throw deliveryError('unknown-target', 'Unknown target');
      }
      cancellation(signal);
      const mentionList = Array.isArray(mentions)
        ? mentions.filter((jid) => typeof jid === 'string' && jid.includes('@'))
        : [];
      await adapter.sendText(id, target, text, {
        signal,
        ...mentionList.length > 0 ? { mentions: mentionList } : {},
      });
      return { sent: true };
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        throw deliveryError('cancelled', 'Request cancelled', { cause: error });
      }
      throw publicOperationError(error);
    }
  }

  async #adapterFor(botId) {
    for (const { adapter } of this.#adapters.values()) {
      let ownsBot;
      try {
        ownsBot = await adapter.ownsBot(botId);
      } catch (error) {
        throw publicOperationError(error);
      }
      if (ownsBot) return adapter;
    }
    throw deliveryError('unknown-bot', 'Unknown bot');
  }
}

export function createDeliveryService() {
  return new DeliveryService();
}
