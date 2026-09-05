import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  conversationKeyFor,
  DEFAULT_GROUP_SESSION_SCOPE,
  normalizeGroupSessionScope,
  validateGroupSessionScope,
} from '../../../src/channels/shared/session-scope.mjs';

describe('session-scope', () => {
  it('defaults ops fork to user_in_chat', () => {
    assert.equal(DEFAULT_GROUP_SESSION_SCOPE, 'user_in_chat');
    assert.equal(normalizeGroupSessionScope(undefined), 'user_in_chat');
    assert.equal(normalizeGroupSessionScope('shared'), 'chat');
    assert.equal(normalizeGroupSessionScope('per_user'), 'user_in_chat');
  });

  it('validates strict scopes only', () => {
    assert.equal(validateGroupSessionScope('chat'), 'chat');
    assert.equal(validateGroupSessionScope('user_in_chat'), 'user_in_chat');
    assert.throws(() => validateGroupSessionScope('shared'), /Invalid group session scope/);
  });

  it('builds direct and group conversation keys', () => {
    assert.equal(
      conversationKeyFor({ kind: 'direct', conversationId: 'u1', senderId: 'u1' }),
      'direct:u1',
    );
    assert.equal(
      conversationKeyFor({
        kind: 'group',
        conversationId: 'g1',
        senderId: 'u2',
        groupSessionScope: 'chat',
      }),
      'group:g1',
    );
    assert.equal(
      conversationKeyFor({
        kind: 'group',
        conversationId: 'g1',
        senderId: 'u2',
        groupSessionScope: 'user_in_chat',
      }),
      'group:g1:user:u2',
    );
  });

  it('requires senderId for user_in_chat groups', () => {
    assert.throws(
      () => conversationKeyFor({
        kind: 'group',
        conversationId: 'g1',
        senderId: '',
        groupSessionScope: 'user_in_chat',
      }),
      /senderId is required/,
    );
  });
});
