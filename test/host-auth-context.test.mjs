import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';

import { harnessConnection } from '../plugin-src/host/harness-connection.mjs';
import { createHarnessCommandExecutor } from '../plugin-src/host/harness-command-executor.mjs';
import { HarnessClient } from '../src/channels/shared/harness-client.mjs';
import { watchHarnessMux } from '../src/channels/shared/harness-mux.mjs';
import { classifyMessageFailure } from '../src/channels/shared/message-failure.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';
import { runHarnessHostOperation } from '../plugin-src/host/harness-host-context.mjs';
import { WhatsappHarnessClient } from '../src/channels/whatsapp/harness-client.mjs';
import { HarnessClient as WeixinHarnessClient } from '../src/channels/weixin/harness-client.mjs';

function authFixture() {
  const storage = new AsyncLocalStorage();
  return { storage, auth: { runAsHost: (operation) => storage.run(undefined, operation) } };
}

test('optional UDS lookup never reads a service property that requires Cordis inject', async () => {
  const { storage, auth } = authFixture();
  let service;
  let propertyReads = 0;
  const ctx = {
    root: {},
    get(name) {
      if (name === 'apiProxy') return undefined;
      assert.equal(name, 'udsAuth');
      return service;
    },
    get udsAuth() {
      propertyReads += 1;
      throw new Error('cannot get property "udsAuth" without inject');
    },
    typertGateway: { invoke() { assert.fail('health must not call the gateway'); }, stream() {} },
  };
  // host.describe is local in the modern adapter, but must survive the auth lookup.
  for (const Client of [WeixinHarnessClient, WhatsappHarnessClient]) {
    const client = new Client(harnessConnection(ctx));
    assert.equal(await client.health(), true, 'Host without UDS must remain reachable');
    service = auth;
    await storage.run(null, async () => {
      assert.equal(await client.health(), true, 'Host with UDS must remain reachable');
      assert.equal(await runHarnessHostOperation(ctx, async () => {
        await Promise.resolve();
        assert.equal(storage.getStore(), undefined);
        return 'host';
      }), 'host');
      assert.equal(storage.getStore(), null);
    });
    service = undefined;
  }
  assert.equal(propertyReads, 0);
});

test('modern Host session creation and model selection ignore inherited browser identities', async () => {
  const { storage, auth } = authFixture();
  const calls = [];
  const ctx = {
    root: {}, udsAuth: auth,
    typertGateway: {
      async invoke({ namespace, method, args }) {
        assert.equal(storage.getStore(), undefined);
        await Promise.resolve();
        assert.equal(storage.getStore(), undefined);
        calls.push({ namespace, method, args });
        if (method === 'create') return { sessionId: `session-${calls.length}` };
        if (method === 'selectModel') return { selected: args.request };
        return { accepted: true };
      },
      stream() {
        assert.equal(storage.getStore(), undefined);
        return (async function* () {
          await Promise.resolve();
          assert.equal(storage.getStore(), undefined);
          yield { type: 'baseline', value: { items: [{
            workspaceId: 'bot-workspace', path: process.cwd(), sessionIds: [],
          }], archivedSessionIds: [] } };
        })();
      },
    },
  };
  const client = new HarnessClient({ ...harnessConnection(ctx), workspace: process.cwd() });
  const browser = { empNo: 'browser-user' };
  await Promise.all([null, browser].map((identity) => storage.run(identity, async () => {
    const sessionId = await client.createSession({ agentPreset: 'netxops' });
    await client.selectSessionModel(sessionId, { provider: 'provider', model: 'model' });
    await client.rpc('session.prompt', { sessionId, content: [{ type: 'text', text: 'hello' }] });
    assert.equal(storage.getStore(), identity);
  })));
  assert.equal(calls.filter(({ method }) => method === 'create').length, 2);
  assert.deepEqual(calls.find(({ method }) => method === 'create').args.request, {
    workspaceId: 'bot-workspace', agentPreset: 'netxops',
  });
});

test('legacy Host calls preserve receivers and use auth services that become ready later', async () => {
  const { storage, auth } = authFixture();
  let service;
  const api = { history() {
    assert.equal(this, api);
    assert.equal(storage.getStore(), undefined);
    const { rpcId } = arguments[0];
    return { rpcId, result: { ok: true, value: { events: [] } } };
  } };
  const client = new HarnessClient({ ...harnessConnection({
    apiProxy: { sessions: api }, get: () => service,
  }) });
  service = auth;
  await storage.run(null, () => client.rpc('session.history', { sessionId: 'existing' }));
});

test('lazy IM event streams and cleanup run in Host context and restore the caller', async () => {
  const { storage, auth } = authFixture();
  const controller = new AbortController();
  let closed = false;
  const apiProxy = { events: { mux() {
    assert.equal(storage.getStore(), undefined);
    return (async function* () {
      try {
        await Promise.resolve();
        assert.equal(storage.getStore(), undefined);
        yield { rpcId: 'event', payload: { type: 'session/event' } };
      } finally {
        assert.equal(storage.getStore(), undefined);
        closed = true;
      }
    })();
  } } };
  await storage.run(null, async () => {
    await watchHarnessMux({
      apiProxy, signal: controller.signal, rpcId: 'mux', runHostOperation: auth.runAsHost,
      onEnvelope() { assert.equal(storage.getStore(), null); controller.abort(); },
    });
    assert.equal(storage.getStore(), null);
  });
  assert.equal(closed, true);
});

test('IM commands use the optional Host auth runner without affecting browser context', async () => {
  const { storage, auth } = authFixture();
  const execute = createHarnessCommandExecutor({ udsAuth: auth, typertGateway: {
    async invoke(request) {
      await Promise.resolve();
      assert.equal(storage.getStore(), undefined);
      assert.equal(request.args.agentId, 'session');
      return 'done';
    },
  } });
  await storage.run({ empNo: 'browser' }, async () => {
    assert.equal(await execute('session', '/compact'), 'done');
    assert.equal(storage.getStore().empNo, 'browser');
  });
});

test('UDS RemoteError details survive the modern adapter and prevent preset retry', async () => {
  let creations = 0;
  const ctx = { root: {}, typertGateway: {
    async invoke() {
      creations += 1;
      const error = new Error('登录后才能创建会话');
      Object.assign(error, { name: 'RemoteError', isDSHRemoteError: true,
        code: 'gateway/bad-request', details: { udsError: 'login_required_create_session' } });
      throw error;
    },
    stream() { return (async function* () {
      yield { type: 'baseline', value: { items: [{
        workspaceId: 'workspace', path: process.cwd(), sessionIds: [],
      }], archivedSessionIds: [] } };
    })(); },
  } };
  const client = new HarnessClient({ ...harnessConnection(ctx), workspace: process.cwd() });
  await assert.rejects(client.createSession({ agentPreset: 'netxops' }), (error) => {
    assert.equal(error.code, 'gateway/bad-request');
    assert.equal(error.details.udsError, 'login_required_create_session');
    assert.equal(classifyMessageFailure(error).code, 'HARNESS_LOGIN_REQUIRED');
    return true;
  });
  assert.equal(creations, 1);
});

test('ACL rejections preserve existing chat bindings without creating replacement Sessions', async () => {
  for (const stage of ['history', 'membership']) {
    const error = Object.assign(new Error('denied'), {
      code: 'gateway/bad-request', details: { udsError: 'session_forbidden' },
    });
    const harness = {
      currentWorkspace: () => process.cwd(),
      async sessionExists() { if (stage === 'history') throw error; return true; },
      async sessionBelongsToWorkspace() { throw error; },
      createSession: () => assert.fail('ACL failures must not recreate'),
    };
    await assert.rejects(askInWorkspaceSession({
      harness, key: 'chat', text: 'hi', state: {
        sessionFor: () => 'existing',
        clearSession: () => assert.fail('ACL failures must preserve the binding'),
      },
    }), (actual) => actual === error);
  }
});
