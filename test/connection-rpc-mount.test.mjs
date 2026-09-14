import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { installConnectionRpcChannel } from '../plugin-src/host/connection-rpc-mount.mjs';

function mockRequest({ method = 'POST', url, headers = {}, body }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json', ...headers };
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  req[Symbol.asyncIterator] = async function* () {
    if (body !== undefined) yield Buffer.from(body);
  };
  return req;
}

function mockResponse() {
  const res = new EventEmitter();
  res.statusCode = undefined;
  res.headers = undefined;
  res.body = undefined;
  res.writableEnded = false;
  res.destroyed = false;
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.end = (body) => {
    res.body = body;
    res.writableEnded = true;
    res.emit('finish');
  };
  res.off = res.removeListener.bind(res);
  return res;
}

function createCtx({ rejection } = {}) {
  const routes = [];
  const effects = [];
  return {
    routes,
    effects,
    connection: {
      requestRejection() {
        return rejection;
      },
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    effect(factory, label) {
      const dispose = factory();
      effects.push({ label, dispose });
      return async () => {
        await dispose?.();
      };
    },
  };
}

test('installConnectionRpcChannel mounts a POST JSON RPC channel on webServer', async () => {
  const ctx = createCtx();
  const calls = [];
  installConnectionRpcChannel(ctx, '/weixin', async (endpoint, payload) => {
    calls.push([endpoint, payload]);
    return { ok: true, value: { endpoint, payload } };
  });

  assert.equal(ctx.routes.length, 1);
  assert.equal(ctx.routes[0].kind, 'prefix');
  assert.equal(ctx.routes[0].path, '/weixin');
  assert.equal(ctx.effects[0].label, 'dsh-im: /weixin rpc channel');

  const req = mockRequest({
    url: '/weixin/connection.status',
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'connection.status',
      payload: { botId: 'b1' },
    }),
  });
  const res = mockResponse();
  await ctx.routes[0].handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    type: 'server-response',
    rpcId: 'rpc-1',
    result: { ok: true, value: { endpoint: 'connection.status', payload: { botId: 'b1' } } },
  });
  assert.deepEqual(calls, [['connection.status', { botId: 'b1' }]]);
});

test('installConnectionRpcChannel rejects unauthenticated requests via connection.requestRejection', async () => {
  const ctx = createCtx({ rejection: 401 });
  installConnectionRpcChannel(ctx, '/weixin', async () => ({ ok: true, value: {} }));

  const req = mockRequest({
    url: '/weixin/connection.status',
    body: '{}',
  });
  const res = mockResponse();
  await ctx.routes[0].handler(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body, 'unauthorized');
});

test('installConnectionRpcChannel requires webServer and connection.requestRejection', () => {
  assert.throws(
    () => installConnectionRpcChannel({ effect() {} }, '/weixin', async () => ({})),
    /webServer is required/,
  );
  assert.throws(
    () => installConnectionRpcChannel({
      effect() {},
      webServer: { register() {} },
    }, '/weixin', async () => ({})),
    /requestRejection is required/,
  );
});
