/**
 * Unit tests for UP-21: message edit/versioning.
 * Ported from Python: tests/test_msg_edit.py
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getMemoryStore } from '../../src/transports/http/server.js';

function makeFreshStore() {
  process.env.AGENTCHATBUS_DB = ':memory:';
  const store = getMemoryStore();
  store.reset();
  return store;
}

function postWithFreshToken(
  store: ReturnType<typeof getMemoryStore>,
  threadId: string,
  author: string,
  content: string,
  role: 'assistant' | 'system' = 'assistant'
) {
  const sync = store.issueSyncContext(threadId, author, 'test');
  return store.postMessage({
    threadId,
    author,
    content,
    expectedLastSeq: sync.current_seq,
    replyToken: sync.reply_token,
    role
  });
}

describe('Message Edit Unit Tests', () => {
  let store: ReturnType<typeof getMemoryStore>;

  beforeEach(() => {
    store = makeFreshStore();
  });

  it('msg_edit updates content', () => {
    const { thread } = store.createThread('edit-test');
    const msg = postWithFreshToken(store, thread.id, 'agent-a', 'original content');

    store.editMessage(msg.id, 'updated content', 'agent-a');

    const updated = store.getMessage(msg.id);
    expect(updated?.content).toBe('updated content');
  });

  it('msg_edit creates history entry', () => {
    const { thread } = store.createThread('edit-test');
    const msg = postWithFreshToken(store, thread.id, 'agent-a', 'original content');

    store.editMessage(msg.id, 'new content', 'agent-a');

    const history = store.getMessageHistory(msg.id);
    expect(history.length).toBe(1);
    expect(history[0].old_content).toBe('original content');
    expect(history[0].edited_by).toBe('agent-a');
    expect(history[0].version).toBe(1);
  });

  it('msg_edit increments version', () => {
    const { thread } = store.createThread('edit-test');
    const msg = postWithFreshToken(store, thread.id, 'agent-a', 'v0');

    store.editMessage(msg.id, 'v1', 'agent-a');
    store.editMessage(msg.id, 'v2', 'agent-a');
    store.editMessage(msg.id, 'v3', 'agent-a');

    const updated = store.getMessage(msg.id);
    expect(updated?.edit_version).toBe(3);

    const history = store.getMessageHistory(msg.id);
    expect(history.length).toBe(3);
    expect(history.map((e) => e.version)).toEqual([1, 2, 3]);
  });

  it('msg_edit sets edited_at', () => {
    const { thread } = store.createThread('edit-test');
    const msg = postWithFreshToken(store, thread.id, 'agent-a', 'hello');

    expect(msg.edited_at).toBeNull();

    store.editMessage(msg.id, 'hello world', 'agent-a');

    const updated = store.getMessage(msg.id);
    expect(updated?.edited_at).not.toBeNull();
  });

  it('msg_edit same content returns no_change', () => {
    const { thread } = store.createThread('edit-test');
    const msg = postWithFreshToken(store, thread.id, 'agent-a', 'same content');

    const result = store.editMessage(msg.id, 'same content', 'agent-a');

    expect(result).toMatchObject({ no_change: true });
  });

  it('msg_edit message not found returns undefined', () => {
    const result = store.editMessage('non-existent-id', 'new content', 'agent-a');
    expect(result).toBeUndefined();
  });

  it('msg_edit does not edit human-only transcript entries', () => {
    const { thread } = store.createThread('hidden-edit-test');
    const hidden = store.postSystemMessage(
      thread.id,
      'human only edit target',
      JSON.stringify({ visibility: 'human_only', ui_type: 'admin_takeover_confirmation_required' }),
    );

    const result = store.editMessage((hidden as any).id, 'tampered', 'system');
    expect(result).toBeUndefined();
  });

  it('msg_edit preserves thread association', () => {
    const { thread } = store.createThread('edit-test');
    const msg = postWithFreshToken(store, thread.id, 'agent-a', 'original');

    store.editMessage(msg.id, 'updated', 'agent-a');

    const updated = store.getMessage(msg.id);
    expect(updated?.thread_id).toBe(thread.id);
  });

  it('msg_edit history empty for unedited message', () => {
    const { thread } = store.createThread('edit-test');
    const msg = postWithFreshToken(store, thread.id, 'agent-a', 'untouched');

    const history = store.getMessageHistory(msg.id);
    expect(history).toEqual([]);
  });

  it('msg_edit history ordered by version', () => {
    const { thread } = store.createThread('edit-test');
    const msg = postWithFreshToken(store, thread.id, 'agent-a', 'v0');

    store.editMessage(msg.id, 'v1', 'agent-a');
    store.editMessage(msg.id, 'v2', 'agent-a');
    store.editMessage(msg.id, 'v3', 'agent-a');

    const history = store.getMessageHistory(msg.id);
    expect(history.map((e) => e.version)).toEqual([1, 2, 3]);
    expect(history[0].old_content).toBe('v0');
    expect(history[1].old_content).toBe('v1');
    expect(history[2].old_content).toBe('v2');
  });

  it('msg_edit parity: non-author edit should be rejected', () => {
    const { thread } = store.createThread('edit-test');
    const msg = postWithFreshToken(store, thread.id, 'agent-a', 'original');

    expect(() => store.editMessage(msg.id, 'hijacked', 'agent-b')).toThrowError(/Only the original author/);
  });

  it('msg_edit parity: role=system message should not be editable', () => {
    const { thread } = store.createThread('edit-test');
    const sysMsg = postWithFreshToken(store, thread.id, 'system', 'system event', 'system');

    expect(() => store.editMessage(sysMsg.id, 'tampered', 'system')).toThrowError(/cannot be edited/);
  });

  it('msg_edit parity: system can edit any message', () => {
    const { thread } = store.createThread('edit-test');
    const msg = postWithFreshToken(store, thread.id, 'agent-a', 'original');

    const result = store.editMessage(msg.id, 'corrected by system', 'system');

    // editMessage returns the updated message, not an object with edited_by
    expect(result).toMatchObject({ content: 'corrected by system' });
    const updated = store.getMessage(msg.id);
    expect(updated?.content).toBe('corrected by system');
  });

  it('msg_edit preserves old_content in history', () => {
    const { thread } = store.createThread('edit-test');
    const original = 'this is the original message body with some text';
    const msg = postWithFreshToken(store, thread.id, 'agent-a', original);

    store.editMessage(msg.id, 'completely different', 'agent-a');

    const history = store.getMessageHistory(msg.id);
    expect(history[0].old_content).toBe(original);
  });

  it('msg_edit version 0 for unedited message', () => {
    const { thread } = store.createThread('edit-test');
    const msg = postWithFreshToken(store, thread.id, 'agent-a', 'untouched');

    expect(msg.edit_version).toBe(0);
    expect(msg.edited_at).toBeNull();
  });
});

describe('Message Reaction Unit Tests', () => {
  let store: ReturnType<typeof getMemoryStore>;

  beforeEach(() => {
    store = makeFreshStore();
  });

  it('addReaction adds reaction to database', () => {
    const { thread } = store.createThread('reaction-test');
    const msg = postWithFreshToken(store, thread.id, 'agent-a', 'hello');

    store.addReaction(msg.id, 'agent-b', 'thumbsup');

    const reactions = store.getReactions(msg.id);
    expect(reactions.length).toBe(1);
    expect(reactions[0]).toEqual({ agent_id: 'agent-b', reaction: 'thumbsup' });
  });

  it('getReactionsBulk returns reactions for multiple messages', () => {
    const { thread } = store.createThread('reaction-test');
    const msg1 = postWithFreshToken(store, thread.id, 'agent-a', 'msg1');
    const msg2 = postWithFreshToken(store, thread.id, 'agent-a', 'msg2');

    store.addReaction(msg1.id, 'agent-b', 'thumbsup');
    store.addReaction(msg2.id, 'agent-c', 'heart');

    const reactionsMap = store.getReactionsBulk([msg1.id, msg2.id]);

    expect(reactionsMap.get(msg1.id)?.length).toBe(1);
    expect(reactionsMap.get(msg2.id)?.length).toBe(1);
  });
});
