import { withSessionBindingLock } from './session-binding-lock.mjs';
import { isMissingSessionError } from './message-failure.mjs';
import { initialSessionTitle } from './session-title.mjs';

export const WORKSPACE_SESSION_STALE = 'workspace-session-stale';

function workspaceSession(harness, sessionId) {
  if (typeof harness.workspaceSession === 'function') {
    return harness.workspaceSession(sessionId);
  }
  const session = {
    sessionId,
    sessionExists: (...args) => harness.sessionExists(sessionId, ...args),
    models: (...args) => harness.getSessionModels(sessionId, ...args),
    selectModel: (...args) => harness.selectSessionModel(sessionId, ...args),
    isRunning: (...args) => harness.isSessionRunning(sessionId, ...args),
    hasActiveTurn: (...args) => harness.hasActiveTurn(sessionId, ...args),
    stopActiveTurn: (...args) => harness.stopActiveTurn(sessionId, ...args),
    steerActiveTurn: (...args) => harness.steerActiveTurn(sessionId, ...args),
    ask: (...args) => harness.ask(sessionId, ...args),
  };
  if (typeof harness.renameSession === 'function') {
    session.renameTitle = (...args) => harness.renameSession(sessionId, ...args);
  }
  return Object.freeze(session);
}

async function sessionExists(session, options) {
  return options === undefined
    ? session.sessionExists()
    : session.sessionExists(options);
}

async function createSession(harness, options) {
  return options === undefined
    ? harness.createSession()
    : harness.createSession(options);
}

function configuredWorkspacePath(harness, createOptions) {
  if (typeof createOptions?.workspace === 'string' && createOptions.workspace.trim()) {
    return createOptions.workspace.trim();
  }
  if (typeof harness?.currentWorkspace === 'function') {
    const value = harness.currentWorkspace();
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Prefer the chat's bound Session only when it still exists under the bot's
 * configured workspace. Otherwise drop the binding and create a fresh Session
 * (workspace + agent preset + default model are applied by createSession).
 */
async function boundSessionReusable({
  session,
  harness,
  createOptions,
  existsOptions,
}) {
  if (!session) return false;
  try {
    if (!(await sessionExists(session, existsOptions))) return false;
  } catch (error) {
    if (error?.code === WORKSPACE_SESSION_STALE || existsOptions?.signal?.aborted) throw error;
    if (isMissingSessionError(error)) return false;
    // History probe failed with a non-missing code (often Host `internal` on a
    // zombie binding). Recreate from bot settings instead of surfacing HARNESS_SERVICE.
    console.warn(
      '[dsh-im] bound Session probe failed; recreating from bot workspace settings:',
      error?.message ?? error,
    );
    return false;
  }

  const workspacePath = configuredWorkspacePath(harness, createOptions);
  if (!workspacePath) return true;
  if (typeof harness?.sessionBelongsToWorkspace !== 'function') return true;

  try {
    const belongs = await harness.sessionBelongsToWorkspace(
      session.sessionId,
      workspacePath,
      existsOptions,
    );
    if (!belongs) {
      console.warn(
        `[dsh-im] bound Session ${session.sessionId} is outside workspace ${workspacePath}; recreating`,
      );
    }
    return belongs;
  } catch (error) {
    if (error?.code === WORKSPACE_SESSION_STALE || existsOptions?.signal?.aborted) throw error;
    console.warn(
      '[dsh-im] unable to verify Session workspace membership; recreating:',
      error?.message ?? error,
    );
    return false;
  }
}

/**
 * Resolve, persist, and ask through a session that belongs to the bot's
 * current workspace. A concurrent workspace switch invalidates the scoped
 * session and retries before any prompt is sent to the stale session.
 */
export async function askInWorkspaceSession({
  harness,
  state,
  key,
  text,
  content,
  contextEnhanced = false,
  createOptions,
  existsOptions,
  askOptions,
}) {
  const initialTitle = contextEnhanced
    ? initialSessionTitle({
        text,
        content,
        files: typeof askOptions === 'object' ? askOptions?.files : undefined,
      })
    : null;
  const renameSignal = createOptions?.signal
    ?? (typeof askOptions === 'object' ? askOptions?.signal : undefined);
  const renameOptions = renameSignal ? { signal: renameSignal } : undefined;
  while (true) {
    try {
      const binding = await withSessionBindingLock(state, key, async () => {
        let sessionId = state.sessionFor(key);
        let session = sessionId ? workspaceSession(harness, sessionId) : null;
        const reusable = await boundSessionReusable({
          session,
          harness,
          createOptions,
          existsOptions,
        });
        if (!reusable) {
          if (sessionId && typeof state.clearSession === 'function') {
            await state.clearSession(key);
          }
          sessionId = await createSession(harness, createOptions);
          if (await state.setSession(key, sessionId) === false) return null;
          session = workspaceSession(harness, sessionId);
          if (initialTitle && typeof session.renameTitle === 'function') {
            try {
              await session.renameTitle(initialTitle, renameOptions);
            } catch (error) {
              if (error?.code === WORKSPACE_SESSION_STALE || renameOptions?.signal?.aborted) {
                throw error;
              }
              console.warn('[dsh-im] unable to set the initial Session title:', error?.message ?? error);
            }
          }
        }
        return { sessionId, session };
      });
      if (!binding) continue;
      const artifacts = [];
      const originalOnArtifact = typeof askOptions === 'object'
        && typeof askOptions?.onArtifact === 'function'
        ? askOptions.onArtifact
        : null;
      const artifactOptions = typeof askOptions === 'number'
        ? { timeoutMs: askOptions }
        : { ...askOptions };
      artifactOptions.onArtifact = async (artifact) => {
        artifacts.push(artifact);
        await originalOnArtifact?.(artifact);
      };
      const answer = await binding.session.ask(content ?? text, artifactOptions);
      return {
        sessionId: binding.sessionId,
        answer,
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
    } catch (error) {
      if (error?.code !== WORKSPACE_SESSION_STALE) throw error;
    }
  }
}
