import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdateRpcHandler, installUpdateRpc, HOST_LANGUAGE_SET_ENDPOINT } from '../plugin-src/host/update-rpc.mjs';
import { createImHostPlugin } from '../plugin-src/host/index.mjs';
import { getImHostLanguage, setImHostLanguage } from '../src/channels/shared/i18n.mjs';

test('update RPC rejects arbitrary commands, paths, profiles, sources and invalid request identifiers', async () => {
  const calls = [];
  const service = Object.fromEntries(['status', 'check', 'install'].map((key) => [key, async (value) => calls.push([key, value])]));
  const handle = createUpdateRpcHandler(service);
  for (const [endpoint, payload] of [
    ['unknown', {}], ['update.check', { registry: 'https://evil.test/' }],
    ['update.status', { profile: '../other' }], ['update.install', null],
    ['update.install', { checkId: 'id', requestId: 'request', command: 'anything' }],
    ['update.install', { checkId: 'id', requestId: '; rm -rf /' }],
    ['update.install', { checkId: 'id', requestId: 'request', version: '9.0.0' }],
    [HOST_LANGUAGE_SET_ENDPOINT, {}],
    [HOST_LANGUAGE_SET_ENDPOINT, { language: 'en', extra: true }],
    [HOST_LANGUAGE_SET_ENDPOINT, { language: '' }],
  ]) {
    assert.equal((await handle(endpoint, payload)).error.code, 'bad-request');
  }
  assert.deepEqual(calls, []);
});

test('host.language.set follows DSH locale ids and returns the normalized host language', async () => {
  const handle = createUpdateRpcHandler({});
  setImHostLanguage('zh');
  try {
    assert.deepEqual(await handle(HOST_LANGUAGE_SET_ENDPOINT, { language: 'en' }), {
      ok: true, value: { language: 'en' },
    });
    assert.equal(getImHostLanguage(), 'en');
    assert.deepEqual(await handle(HOST_LANGUAGE_SET_ENDPOINT, { language: 'zh-CN' }), {
      ok: true, value: { language: 'zh' },
    });
    assert.equal(getImHostLanguage(), 'zh');
  } finally {
    setImHostLanguage('zh');
  }
});

test('update RPC mounts on /dsh-im through webServer', () => {
  const routes = [];
  const service = { close: async () => {} };
  const ctx = {
    connection: {
      requestRejection: () => undefined,
    },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
    },
    effect: (factory) => {
      const dispose = factory();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };
  installUpdateRpc(ctx, { service, runtime: {} });
  assert.equal(routes[0]?.path, '/dsh-im');
  assert.equal(routes[0]?.kind, 'prefix');
});

test('update RPC returns only safe codes for unanticipated runtime errors', async () => {
  const handle = createUpdateRpcHandler({ status: async () => {
    throw new Error('token=secret /Users/private/profile');
  } });
  assert.deepEqual(await handle('update.status', {}), {
    ok: false, error: { code: 'update-failed', message: 'update-failed' },
  });
});

test('aborting a submitted browser request does not cancel the Host installation', async () => {
  const abort = new AbortController();
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const handle = createUpdateRpcHandler({ install: async () => pending });
  const result = handle('update.install', { checkId: 'confirmed', requestId: 'request' }, abort.signal);
  abort.abort();
  complete({ job: { state: 'installing' } });
  assert.deepEqual(await result, { ok: true, value: { job: { state: 'installing' } } });
});

test('Host update initialization failure leaves all channel activations available', async () => {
  const calls = [];
  const channels = ['Feishu', 'Weixin', 'Dingtalk', 'Wecom', 'Qq', 'Slack', 'Telegram', 'Discord', 'Whatsapp', 'Office'];
  const internals = Object.fromEntries(channels.map((channel) => [`apply${channel}`, async () => calls.push(channel)]));
  internals.installUpdateRpc = () => { throw new Error('updater unavailable'); };
  internals.installDeliveryRpc = () => {};
  const errors = [];
  await createImHostPlugin(internals).apply({
    connection: { rpc: {} }, logger: { error: (...args) => errors.push(args) },
  });
  assert.deepEqual(calls, channels);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /update management/);
});
