/**
 * Mount a Connection-compatible unary RPC channel via webServer.
 *
 * DSH `connection.rpc.handle` registers with `owner.webServer`, but Cordis
 * rebinds `connection.ctx` onto the Connection fiber (which does not inject
 * webServer). That throws "cannot get property webServer without inject" and
 * the browser sees empty HTTP 405 from frontend-static.
 *
 * This helper registers the same POST JSON envelope on the plugin fiber that
 * already injects `webServer`, and still uses `connection.requestRejection`
 * for Host/Origin + browser auth.
 */

const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/;
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const INVALID_REQUEST_RPC_ID = 'invalid-request';

function assertChannel(channel) {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new TypeError(`dsh-im: invalid or reserved RPC channel ${JSON.stringify(channel)}`);
  }
}

function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  const segments = endpoint.split('/');
  if (segments.some((segment) => (
    segment === ''
    || segment === '.'
    || segment === '..'
    || !ENDPOINT_SEGMENT_PATTERN.test(segment)
  ))) {
    return undefined;
  }
  return endpoint;
}

function isJsonContentType(value) {
  return typeof value === 'string'
    && value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function writeRaw(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, headers);
  res.end(body);
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  writeRaw(res, status, body, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  });
}

async function readJsonBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    const error = new Error('payload-too-large');
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) {
      const error = new Error('payload-too-large');
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    const error = new Error('body is not JSON');
    error.status = 400;
    throw error;
  }
}

function isClientRequest(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.type === 'client-request'
    && typeof value.rpcId === 'string'
    && typeof value.method === 'string'
    && Object.prototype.hasOwnProperty.call(value, 'payload');
}

function serverResponse(rpcId, result) {
  return { type: 'server-response', rpcId, result };
}

/**
 * @param {object} ctx Cordis context with webServer + connection
 * @param {string} channel e.g. `/weixin`
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<{ok: boolean, value?: unknown, error?: object}>} handler
 * @returns {() => Promise<void>} disposer
 */
export function installConnectionRpcChannel(ctx, channel, handler) {
  assertChannel(channel);
  if (typeof handler !== 'function') {
    throw new TypeError('dsh-im RPC handler must be a function');
  }
  if (!ctx?.webServer || typeof ctx.webServer.register !== 'function') {
    throw new TypeError('DSH Host webServer is required to mount IM RPC channels');
  }
  if (typeof ctx?.effect !== 'function') {
    throw new TypeError('DSH Host ctx.effect is required to mount IM RPC channels');
  }
  const connection = ctx.connection;
  if (!connection || typeof connection.requestRejection !== 'function') {
    throw new TypeError('DSH Host connection.requestRejection is required to mount IM RPC channels');
  }

  const route = {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) {
        writeRaw(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }

      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const endpoint = endpointFromPath(channel, pathname);
      if (req.method !== 'POST' || endpoint === undefined) {
        writeRaw(res, 404, 'not found');
        return;
      }
      if (!isJsonContentType(req.headers['content-type'])) {
        writeRaw(res, 415, 'content type must be application/json');
        return;
      }

      const abort = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.once('close', onClose);
      try {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          writeRaw(res, error.status === 413 ? 413 : 400, error.message || 'bad request');
          return;
        }
        if (!isClientRequest(body)) {
          writeJson(res, 200, serverResponse(
            typeof body?.rpcId === 'string' ? body.rpcId : INVALID_REQUEST_RPC_ID,
            {
              ok: false,
              error: {
                code: 'gateway/bad-request',
                message: 'invalid client-request message',
                details: { issues: [] },
              },
            },
          ));
          return;
        }
        if (body.method !== endpoint) {
          writeJson(res, 200, serverResponse(body.rpcId, {
            ok: false,
            error: {
              code: 'gateway/bad-request',
              message: `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
              details: { issues: [] },
            },
          }));
          return;
        }

        try {
          const result = await handler(endpoint, body.payload, abort.signal);
          writeJson(res, 200, serverResponse(body.rpcId, result));
        } catch (error) {
          writeRaw(res, 500, `handler failure: ${String(error)}`);
        }
      } finally {
        res.off('close', onClose);
      }
    },
  };

  return ctx.effect(
    () => ctx.webServer.register(route),
    `dsh-im: ${channel} rpc channel`,
  );
}
