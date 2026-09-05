import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY_STATE = Object.freeze({
  version: 1,
  sessions: {},
  sessionOrigins: {},
  seenMessageIds: [],
  cursor: null,
});

/** Cap unbound+bound provenance so bot state files stay bounded. */
const MAX_SESSION_ORIGINS = 2_000;

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function normalizeOrigins(value) {
  const origins = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return origins;
  for (const [sessionId, conversationKey] of Object.entries(value)) {
    if (typeof sessionId !== 'string' || !sessionId) continue;
    if (typeof conversationKey !== 'string' || !conversationKey) continue;
    origins[sessionId] = conversationKey;
  }
  return origins;
}

/**
 * Seed provenance from live bindings so older state files gain reverse maps.
 * @param {Record<string, string>} sessions
 * @param {Record<string, string>} origins
 */
function mergeLiveIntoOrigins(sessions, origins) {
  for (const [conversationKey, sessionId] of Object.entries(sessions)) {
    if (typeof conversationKey === 'string' && conversationKey
      && typeof sessionId === 'string' && sessionId) {
      origins[sessionId] = conversationKey;
    }
  }
}

/**
 * Drop oldest provenance entries when over the cap (insertion order).
 * @param {Record<string, string>} origins
 */
function pruneOrigins(origins) {
  const ids = Object.keys(origins);
  if (ids.length <= MAX_SESSION_ORIGINS) return;
  const drop = ids.length - MAX_SESSION_ORIGINS;
  for (let i = 0; i < drop; i += 1) delete origins[ids[i]];
}

function normalizeState(value) {
  if (!value || typeof value !== 'object') return structuredClone(EMPTY_STATE);
  const sessions = {};
  if (value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)) {
    for (const [key, sessionId] of Object.entries(value.sessions)) {
      if (typeof key === 'string' && key && typeof sessionId === 'string' && sessionId) {
        sessions[key] = sessionId;
      }
    }
  }
  const sessionOrigins = normalizeOrigins(value.sessionOrigins);
  mergeLiveIntoOrigins(sessions, sessionOrigins);
  pruneOrigins(sessionOrigins);
  return {
    version: 1,
    sessions,
    sessionOrigins,
    seenMessageIds: Array.isArray(value.seenMessageIds)
      ? value.seenMessageIds.filter((id) => typeof id === 'string' && id).slice(-1_000)
      : [],
    cursor: Number.isSafeInteger(value.cursor) && value.cursor >= 0 ? value.cursor : null,
  };
}

export class ConversationStateStore {
  #path;
  #state = structuredClone(EMPTY_STATE);
  #writeQueue = Promise.resolve();

  constructor(path) {
    this.#path = path;
  }

  async load() {
    try {
      this.#state = normalizeState(JSON.parse(await readFile(this.#path, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#state = structuredClone(EMPTY_STATE);
      await this.#persist();
    }
    return this;
  }

  sessionFor(key) {
    return this.#state.sessions[key] ?? null;
  }

  /**
   * Reverse-map a Harness session id to its conversation binding key.
   * Live bindings win; unbound sessions still resolve via sessionOrigins
   * so DSH can show channel provenance after `/new`.
   * @param {string} sessionId
   * @returns {string|null}
   */
  keyForSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    for (const [key, bound] of Object.entries(this.#state.sessions)) {
      if (bound === sessionId) return key;
    }
    const former = this.#state.sessionOrigins?.[sessionId];
    return typeof former === 'string' && former ? former : null;
  }

  /**
   * Whether this session id is the live binding for its conversation key.
   * @param {string} sessionId
   * @returns {boolean}
   */
  isLiveSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    for (const bound of Object.values(this.#state.sessions)) {
      if (bound === sessionId) return true;
    }
    return false;
  }

  async setSession(key, sessionId) {
    this.#state.sessions[key] = sessionId;
    if (typeof sessionId === 'string' && sessionId) {
      this.#state.sessionOrigins[sessionId] = key;
      pruneOrigins(this.#state.sessionOrigins);
    }
    await this.#persist();
  }

  async clearSession(key) {
    // Keep sessionOrigins so unbound Harness sessions still show channel peer.
    delete this.#state.sessions[key];
    await this.#persist();
  }

  async clearSessions() {
    // Workspace switches drop live chat→session maps only; provenance stays.
    this.#state.sessions = {};
    await this.#persist();
  }

  hasSeen(messageId) {
    return this.#state.seenMessageIds.includes(messageId);
  }

  async markSeen(messageId) {
    if (this.hasSeen(messageId)) return;
    this.#state.seenMessageIds.push(messageId);
    if (this.#state.seenMessageIds.length > 1_000) {
      this.#state.seenMessageIds.splice(0, this.#state.seenMessageIds.length - 1_000);
    }
    await this.#persist();
  }

  cursor() {
    return this.#state.cursor;
  }

  async setCursor(cursor) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError('Invalid update cursor');
    this.#state.cursor = cursor;
    await this.#persist();
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  async remove() {
    try {
      await unlink(this.#path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.#state = structuredClone(EMPTY_STATE);
  }

  async #persist() {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}\n`;
    const operation = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.#path);
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    await operation;
  }
}
