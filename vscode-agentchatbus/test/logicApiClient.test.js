const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSendMessageRequestBody,
  normalizeSendMessagePayload,
  shouldRetrySendMessage,
} = require('../out/logic/testExports');

test('normalizeSendMessagePayload converts string payloads to content objects', () => {
  assert.deepEqual(normalizeSendMessagePayload('hello'), { content: 'hello' });
});

test('buildSendMessageRequestBody preserves optional fields and sync context', () => {
  const body = buildSendMessageRequestBody(
    {
      author: 'alice',
      content: 'hello',
      mentions: ['agent-1'],
      metadata: { foo: 'bar' },
      images: [{ url: 'data:image/png;base64,abc', name: 'diagram.png' }],
      reply_to_msg_id: 'msg-123',
    },
    {
      current_seq: 7,
      reply_token: 'reply-token-1',
    },
  );

  assert.deepEqual(body, {
    author: 'alice',
    content: 'hello',
    mentions: ['agent-1'],
    metadata: { foo: 'bar' },
    images: [{ url: 'data:image/png;base64,abc', name: 'diagram.png' }],
    reply_to_msg_id: 'msg-123',
    expected_last_seq: 7,
    reply_token: 'reply-token-1',
  });
});

test('buildSendMessageRequestBody defaults the author to human', () => {
  const body = buildSendMessageRequestBody('hi', {
    current_seq: 1,
    reply_token: 'reply-token-2',
  });

  assert.equal(body.author, 'human');
  assert.equal(body.content, 'hi');
  assert.equal(body.expected_last_seq, 1);
  assert.equal(body.reply_token, 'reply-token-2');
});

test('shouldRetrySendMessage only retries the known sync mismatch contract', () => {
  assert.equal(shouldRetrySendMessage(409, { action: 'READ_MESSAGES_THEN_CALL_MSG_WAIT' }), true);
  assert.equal(shouldRetrySendMessage(409, { action: 'OTHER' }), false);
  assert.equal(shouldRetrySendMessage(500, { action: 'READ_MESSAGES_THEN_CALL_MSG_WAIT' }), false);
  assert.equal(shouldRetrySendMessage(409, null), false);
});
