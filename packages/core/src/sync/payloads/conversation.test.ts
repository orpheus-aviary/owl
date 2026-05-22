import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConversationPayloadInvalidError, parseConversationPayload } from './conversation.js';

const VALID_USER_MSG = {
  role: 'user',
  content: 'hi',
  tool_calls: null,
  tool_call_id: null,
  is_error: null,
  reasoning_content: null,
  reasoning_signature: null,
};

const VALID_ASSISTANT_MSG = {
  role: 'assistant',
  content: 'sure',
  tool_calls: '[]',
  tool_call_id: null,
  is_error: null,
  reasoning_content: 'thinking',
  reasoning_signature: 'sig',
};

describe('parseConversationPayload — append (subsequent, no title)', () => {
  it('accepts a minimal append', () => {
    const parsed = parseConversationPayload('append', {
      messages: [VALID_USER_MSG],
      applied_at_ms: 1_000,
    });
    assert.equal(parsed.op, 'append');
    if (parsed.op !== 'append') throw new Error('narrowing failed');
    assert.equal(parsed.body.messages.length, 1);
    assert.equal(parsed.body.title, undefined);
    assert.equal(parsed.body.created_at_ms, undefined);
  });

  it('accepts multiple roles in one batch', () => {
    const parsed = parseConversationPayload('append', {
      messages: [VALID_USER_MSG, VALID_ASSISTANT_MSG],
      applied_at_ms: 2_000,
    });
    if (parsed.op !== 'append') throw new Error('narrowing failed');
    assert.equal(parsed.body.messages.length, 2);
    assert.equal(parsed.body.messages[1]?.role, 'assistant');
    assert.equal(parsed.body.messages[1]?.reasoning_content, 'thinking');
  });
});

describe('parseConversationPayload — append (first, with title + created_at_ms)', () => {
  it('accepts both title and created_at_ms', () => {
    const parsed = parseConversationPayload('append', {
      messages: [VALID_USER_MSG],
      applied_at_ms: 1,
      title: 'Hello',
      created_at_ms: 0,
    });
    if (parsed.op !== 'append') throw new Error('narrowing failed');
    assert.equal(parsed.body.title, 'Hello');
    assert.equal(parsed.body.created_at_ms, 0);
  });

  it('rejects title without created_at_ms', () => {
    assert.throws(
      () =>
        parseConversationPayload('append', {
          messages: [VALID_USER_MSG],
          applied_at_ms: 1,
          title: 'Hello',
        }),
      /title and created_at_ms must both be present or both absent/,
    );
  });

  it('rejects created_at_ms without title', () => {
    assert.throws(
      () =>
        parseConversationPayload('append', {
          messages: [VALID_USER_MSG],
          applied_at_ms: 1,
          created_at_ms: 0,
        }),
      /title and created_at_ms must both be present or both absent/,
    );
  });
});

describe('parseConversationPayload — message shape', () => {
  it('rejects an unknown role', () => {
    assert.throws(
      () =>
        parseConversationPayload('append', {
          messages: [{ ...VALID_USER_MSG, role: 'system' }],
          applied_at_ms: 1,
        }),
      /role must be user\/assistant\/tool/,
    );
  });

  it('rejects content of wrong type', () => {
    assert.throws(
      () =>
        parseConversationPayload('append', {
          messages: [{ ...VALID_USER_MSG, content: 42 }],
          applied_at_ms: 1,
        }),
      /content must be a string/,
    );
  });

  it('rejects is_error as a non-number, non-null', () => {
    assert.throws(
      () =>
        parseConversationPayload('append', {
          messages: [{ ...VALID_USER_MSG, is_error: 'yes' }],
          applied_at_ms: 1,
        }),
      /is_error must be a finite number or null/,
    );
  });
});

describe('parseConversationPayload — delete', () => {
  it('accepts an empty payload', () => {
    const parsed = parseConversationPayload('delete', {});
    assert.equal(parsed.op, 'delete');
  });

  it('accepts and ignores extra fields (defensive)', () => {
    const parsed = parseConversationPayload('delete', { stray: 1 });
    assert.equal(parsed.op, 'delete');
  });
});

describe('parseConversationPayload — op gate', () => {
  it('rejects unknown op', () => {
    assert.throws(
      () => parseConversationPayload('update', { messages: [], applied_at_ms: 1 }),
      /op must be one of append \/ delete/,
    );
  });

  it('rejects non-object payload', () => {
    assert.throws(() => parseConversationPayload('append', null), /payload must be a JSON object/);
  });
});

describe('ConversationPayloadInvalidError shape', () => {
  it('carries op + reason + raw', () => {
    try {
      parseConversationPayload('append', { messages: 'not-array', applied_at_ms: 1 });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof ConversationPayloadInvalidError);
      assert.equal(err.op, 'append');
      assert.match(err.reason, /messages must be an array/);
    }
  });
});
