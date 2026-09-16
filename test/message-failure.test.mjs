import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyMessageFailure,
  messageFailureText,
  publicMessageFailure,
} from '../src/channels/shared/message-failure.mjs';

const options = { referenceId: 'MF-TEST01', at: 123 };

test('message failures distinguish stable Harness transport errors', () => {
  assert.equal(classifyMessageFailure({
    code: 'harness-connect-failed', method: 'host.describe',
  }, options).code, 'HARNESS_CONNECT');
  assert.equal(classifyMessageFailure({
    code: 'harness-connect-failed', method: 'session.history',
  }, options).code, 'HARNESS_RESULT_UNCERTAIN');
  assert.equal(classifyMessageFailure({
    code: 'harness-timeout', method: 'session.prompt',
  }, options).code, 'HARNESS_RESULT_UNCERTAIN');
  assert.equal(classifyMessageFailure({
    code: 'harness-auth-required', method: 'host.describe',
  }, options).code, 'HARNESS_ACCESS');
  assert.equal(classifyMessageFailure({
    code: 'harness-api-not-found', method: 'session.history',
  }, options).code, 'HARNESS_PROTOCOL');
});

test('message failures use verified turn-end provider codes without exposing provider detail', () => {
  for (const [providerCode, code] of [
    ['AUTH', 'MODEL_AUTH'],
    ['QUOTA', 'MODEL_QUOTA'],
    ['RATE_LIMIT', 'MODEL_RATE_LIMIT'],
    ['CONTEXT_WINDOW_EXCEEDED', 'MODEL_CONTEXT_LIMIT'],
    ['UNKNOWN_MODEL', 'MODEL_UNAVAILABLE'],
    ['TIMEOUT', 'MODEL_TIMEOUT'],
    ['TRANSPORT', 'MODEL_TRANSPORT'],
    ['SERVER', 'MODEL_SERVICE'],
    ['STREAM_CLOSED', 'MODEL_STREAM'],
    ['EMPTY_RESPONSE', 'MODEL_EMPTY_REPLY'],
    ['CONTENT_FILTER', 'MODEL_CONTENT_REJECTED'],
    ['INVALID_REQUEST', 'MODEL_CONFIG'],
    ['PI_AI_ERROR', 'MODEL_SERVICE'],
  ]) {
    const failure = classifyMessageFailure({
      code: 'harness-turn-failed',
      providerCode,
      message: 'provider-token /private/path',
      reason: { error: { message: 'secret provider payload' } },
    }, options);
    assert.equal(failure.code, code);
    assert.doesNotMatch(JSON.stringify(failure), /provider-token|private|secret provider/);
  }

  assert.equal(classifyMessageFailure({
    code: 'channel-send-failed', providerCode: 'RATE_LIMIT', status: 429,
  }, options).code, 'CHANNEL_RATE_LIMIT');
  assert.equal(classifyMessageFailure({
    code: 'harness-turn-failed', providerCode: 'PRIVATE_PROVIDER_CODE',
  }, options).code, 'INTERNAL_UNKNOWN');
});

test('PI_AI_ERROR with TLS or transport wording maps to MODEL_TRANSPORT', () => {
  for (const message of [
    'unable to verify the first certificate',
    'request to https://api.example.com failed, reason: UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'fetch failed: other side closed',
    'Stream ended without finish_reason',
  ]) {
    const failure = classifyMessageFailure({
      code: 'harness-turn-failed',
      providerCode: 'PI_AI_ERROR',
      reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message } },
    }, options);
    assert.equal(failure.code, 'MODEL_TRANSPORT', message);
    assert.match(failure.message, /无法连接模型服务/);
    assert.doesNotMatch(JSON.stringify(failure), /certificate|UNABLE_TO|finish_reason|example\.com/);
  }

  assert.equal(classifyMessageFailure({
    code: 'harness-turn-failed',
    providerCode: 'PI_AI_ERROR',
    reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'unable to verify the first certificate' } },
  }, options).code, 'MODEL_TRANSPORT');
});

test('RPC internal and UNKNOWN provider codes no longer fall through to INTERNAL_UNKNOWN', () => {
  assert.equal(classifyMessageFailure({
    code: 'internal', method: 'session.create',
  }, options).code, 'SESSION_CREATE');
  assert.equal(classifyMessageFailure({
    code: 'internal', method: 'workspace.create',
  }, options).code, 'WORKSPACE_UNAVAILABLE');
  assert.equal(classifyMessageFailure({
    code: 'internal', method: 'session.prompt',
  }, options).code, 'HARNESS_SERVICE');
  assert.equal(classifyMessageFailure({
    code: 'harness-turn-failed', providerCode: 'UNKNOWN',
  }, options).code, 'MODEL_SERVICE');
  assert.equal(classifyMessageFailure({
    code: 'harness-turn-failed',
    providerCode: 'UNKNOWN',
    reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'unable to verify the first certificate' } },
  }, options).code, 'MODEL_TRANSPORT');
  const plain = classifyMessageFailure(new Error('secret-shaped internal detail'), options);
  assert.equal(plain.code, 'INTERNAL_UNKNOWN');
  assert.equal(plain.reason, 'ERROR');
});

test('session.create failures tell operators to check the bot workspace path', () => {
  const failure = classifyMessageFailure({
    code: 'internal', method: 'session.create',
  }, options);
  assert.equal(failure.code, 'SESSION_CREATE');
  assert.equal(failure.reason, 'SESSION_CREATE');
  assert.match(failure.message, /工作区/);
});

test('Host branded gateway/internal on session.create maps to SESSION_CREATE', () => {
  assert.equal(classifyMessageFailure({
    code: 'gateway/internal', method: 'session.create',
    message: 'failed to create session "session-x": Error: boom',
  }, options).code, 'SESSION_CREATE');
});

test('Host branded workspace/invalid-path maps to WORKSPACE_UNAVAILABLE', () => {
  assert.equal(classifyMessageFailure({
    code: 'workspace/invalid-path', method: 'workspace.create',
    message: 'cannot create a Workspace at "D:\\\\missing": ENOENT',
    details: { path: 'D:\\missing' },
  }, options).code, 'WORKSPACE_UNAVAILABLE');
});

test('Host branded agent-preset/not-found maps to PRESET_UNAVAILABLE', () => {
  assert.equal(classifyMessageFailure({
    code: 'agent-preset/not-found', method: 'session.create',
    details: { agentPreset: 'gone' },
  }, options).code, 'PRESET_UNAVAILABLE');
});

test('message failure text contains a safe code and traceable reference', () => {
  const failure = classifyMessageFailure(new Error('secret-shaped internal detail'), options);
  assert.deepEqual(failure, {
    code: 'INTERNAL_UNKNOWN',
    reason: 'ERROR',
    message: '任务未完成，暂时无法确定原因。请重试；若持续发生，请将参考号提供给管理员。',
    referenceId: 'MF-TEST01',
    at: 123,
  });
  assert.match(messageFailureText(failure), /错误码：INTERNAL_UNKNOWN；参考号：MF-TEST01/);
  assert.doesNotMatch(messageFailureText(failure), /secret-shaped/);
});

test('public message failure keeps only bounded safe fields', () => {
  assert.deepEqual(publicMessageFailure({
    ...classifyMessageFailure({ code: 'agent-busy' }, options),
    providerDetail: 'secret',
    stack: '/private/path',
  }), {
    code: 'SESSION_BUSY',
    reason: 'SESSION_BUSY',
    message: '当前会话仍在处理上一项任务。请等待完成，或发送 /stop 后重试。',
    referenceId: 'MF-TEST01',
    at: 123,
  });
});

test('artifact permission failures use the shared channel permission classification', () => {
  const error = new Error('private provider permission detail');
  error.code = 'artifact-permission-required';

  const failure = classifyMessageFailure(error, {
    userMessage: '结果文件已生成，但机器人没有文件发送权限。',
    reason: error.code,
    referenceId: 'MF-ART12345',
    at: 123,
  });

  assert.deepEqual(failure, {
    code: 'CHANNEL_PERMISSION',
    reason: 'ARTIFACT_PERMISSION_REQUIRED',
    message: '结果文件已生成，但机器人没有文件发送权限。',
    referenceId: 'MF-ART12345',
    at: 123,
  });
});
