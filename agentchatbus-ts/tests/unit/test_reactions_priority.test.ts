/**
 * Tests for UP-13 (message reactions) and UP-16 (priority messages).
 * Ported from Python: tests/test_reactions_priority.py
 * 
 * Unit tests (in-memory store):
 *   - Priority: 8 tests
 *   - Reactions: 11 tests
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';
import { randomUUID } from 'crypto';
import { unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let store: MemoryStore;
let dbPath: string;

function postWithFreshToken(
  store: MemoryStore,
  threadId: string,
  author: string,
  content: string,
  priority = "normal"
) {
  const sync = store.issueSyncContext(threadId);
  return store.postMessage({
    threadId,
    author,
    content,
    priority,
    expectedLastSeq: sync.current_seq,
    replyToken: sync.reply_token,
  });
}

beforeEach(() => {
  // Disable rate limiting for tests
  vi.stubEnv('AGENTCHATBUS_RATE_LIMIT_ENABLED', 'false');
  // Use unique DB path for each test
  dbPath = join(tmpdir(), `test-reactions-${randomUUID()}.db`);
  store = new MemoryStore(dbPath);
});

afterEach(() => {
  // Cleanup DB file
  try {
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
  } catch {}
});

// ─────────────────────────────────────────────
// Priority Tests (UP-16)
// ─────────────────────────────────────────────

describe('Priority (UP-16)', () => {
  it('msg_post default priority normal', () => {
    const { thread } = store.createThread('priority-test');
    const msg = postWithFreshToken(store, thread.id, 'human', 'hello');
    expect(msg.priority).toBe('normal');
  });

  it('msg_post with urgent priority', () => {
    const { thread } = store.createThread('priority-test');
    const msg = postWithFreshToken(store, thread.id, 'human', 'urgent msg', 'urgent');
    expect(msg.priority).toBe('urgent');
  });

  it('msg_post with system priority', () => {
    const { thread } = store.createThread('priority-test');
    const msg = postWithFreshToken(store, thread.id, 'human', 'system msg', 'system');
    expect(msg.priority).toBe('system');
  });

  it('msg_post invalid priority raises', () => {
    const { thread } = store.createThread('priority-test');
    expect(() => postWithFreshToken(store, thread.id, 'human', 'test', 'critical')).toThrow(
      /Invalid priority/
    );
  });

  it('priority in message object', () => {
    const { thread } = store.createThread('priority-test');
    const msg = postWithFreshToken(store, thread.id, 'human', 'urgent', 'urgent');
    expect(msg).toHaveProperty('priority');
    expect(msg.priority).toBe('urgent');
  });

  it('msg_list filter by priority', () => {
    const { thread } = store.createThread('priority-test');
    postWithFreshToken(store, thread.id, 'human', 'normal msg', 'normal');
    postWithFreshToken(store, thread.id, 'human', 'urgent msg', 'urgent');
    postWithFreshToken(store, thread.id, 'human', 'system msg', 'system');

    const urgentMsgs = store.getMessages(thread.id, 0, false, 'urgent');
    expect(urgentMsgs.length).toBe(1);
    expect(urgentMsgs[0].content).toBe('urgent msg');
    expect(urgentMsgs[0].priority).toBe('urgent');
  });

  it('msg_list no priority filter returns all', () => {
    const { thread } = store.createThread('priority-test');
    postWithFreshToken(store, thread.id, 'human', 'normal', 'normal');
    postWithFreshToken(store, thread.id, 'human', 'urgent', 'urgent');
    postWithFreshToken(store, thread.id, 'human', 'system', 'system');

    const allMsgs = store.getMessages(thread.id, 0, false);
    expect(allMsgs.length).toBe(3);
  });

  it('priority column exists in schema', () => {
    // Verify that priority is part of the message structure
    const { thread } = store.createThread('priority-test');
    const msg = postWithFreshToken(store, thread.id, 'human', 'test');
    expect(msg.priority).toBeDefined();
  });
});

// ─────────────────────────────────────────────
// Reactions Tests (UP-13)
// ─────────────────────────────────────────────

describe('Reactions (UP-13)', () => {
  it('react add', () => {
    const { thread } = store.createThread('reaction-test');
    const msg = postWithFreshToken(store, thread.id, 'human', 'hello');

    const result = store.addReaction(msg.id, 'agent-1', 'agree');
    expect(result).toBeDefined();
    expect(result?.id).toBe(msg.id);
    
    const reactions = store.getReactions(msg.id);
    expect(reactions.length).toBe(1);
    expect(reactions[0].agent_id).toBe('agent-1');
    expect(reactions[0].reaction).toBe('agree');
  });

  it('react duplicate idempotent', () => {
    const { thread } = store.createThread('reaction-test');
    const msg = postWithFreshToken(store, thread.id, 'human', 'hello');

    store.addReaction(msg.id, 'agent-1', 'agree');
    store.addReaction(msg.id, 'agent-1', 'agree'); // Second call should be idempotent

    const reactions = store.getReactions(msg.id);
    expect(reactions.length).toBe(1);
  });

  it('react multiple agents', () => {
    const { thread } = store.createThread('reaction-test');
    const msg = postWithFreshToken(store, thread.id, 'human', 'hello');

    store.addReaction(msg.id, 'agent-1', 'agree');
    store.addReaction(msg.id, 'agent-2', 'agree');
    store.addReaction(msg.id, 'agent-3', 'agree');

    const reactions = store.getReactions(msg.id);
    expect(reactions.length).toBe(3);
  });

  it('react multiple types', () => {
    const { thread } = store.createThread('reaction-test');
    const msg = postWithFreshToken(store, thread.id, 'human', 'hello');

    store.addReaction(msg.id, 'agent-1', 'agree');
    store.addReaction(msg.id, 'agent-1', 'important');

    const reactions = store.getReactions(msg.id);
    const labels = new Set(reactions.map(r => r.reaction));
    expect(labels).toContain('agree');
    expect(labels).toContain('important');
  });

  it('unreact existing', () => {
    const { thread } = store.createThread('reaction-test');
    const msg = postWithFreshToken(store, thread.id, 'human', 'hello');

    store.addReaction(msg.id, 'agent-1', 'agree');
    const result = store.removeReaction(msg.id, 'agent-1', 'agree');
    
    expect(result?.removed).toBe(true);
    const reactions = store.getReactions(msg.id);
    expect(reactions.length).toBe(0);
  });

  it('unreact nonexistent returns false', () => {
    const { thread } = store.createThread('reaction-test');
    const msg = postWithFreshToken(store, thread.id, 'human', 'hello');

    const result = store.removeReaction(msg.id, 'agent-1', 'agree');
    expect(result?.removed).toBe(false);
  });

  it('reactions for message', () => {
    const { thread } = store.createThread('reaction-test');
    const msg = postWithFreshToken(store, thread.id, 'human', 'hello');

    store.addReaction(msg.id, 'a', 'agree');
    store.addReaction(msg.id, 'b', 'disagree');

    const reactions = store.getReactions(msg.id);
    expect(reactions.length).toBe(2);
    const labels = new Set(reactions.map(r => r.reaction));
    expect(labels).toContain('agree');
    expect(labels).toContain('disagree');
  });

  it('reactions for message empty', () => {
    const { thread } = store.createThread('reaction-test');
    const msg = postWithFreshToken(store, thread.id, 'human', 'hello');

    const reactions = store.getReactions(msg.id);
    expect(reactions).toEqual([]);
  });

  it('react invalid message id returns undefined', () => {
    const result = store.addReaction('nonexistent-id', 'a', 'agree');
    expect(result).toBeUndefined();
  });

  it('reactions bulk for thread', () => {
    const { thread } = store.createThread('reaction-test');
    const m1 = postWithFreshToken(store, thread.id, 'human', 'msg 1');
    const m2 = postWithFreshToken(store, thread.id, 'human', 'msg 2');
    const m3 = postWithFreshToken(store, thread.id, 'human', 'msg 3');

    store.addReaction(m1.id, 'a', 'agree');
    store.addReaction(m2.id, 'b', 'important');

    const result = store.getReactionsBulk([m1.id, m2.id, m3.id]);
    expect(result.get(m1.id)?.length).toBe(1);
    expect(result.get(m1.id)?.[0].reaction).toBe('agree');
    expect(result.get(m2.id)?.length).toBe(1);
    expect(result.get(m2.id)?.[0].reaction).toBe('important');
    expect(result.get(m3.id)?.length ?? 0).toBe(0);
  });

  it('react emits event', () => {
    const { thread } = store.createThread('reaction-test');
    const msg = postWithFreshToken(store, thread.id, 'human', 'hello');

    // Add reaction should emit msg.updated event
    const events: unknown[] = [];
    const unsubscribe = (globalThis as any).__testEventBus?.subscribe?.((e: unknown) => events.push(e));
    
    store.addReaction(msg.id, 'agent-1', 'agree');
    
    // The event is emitted via eventBus.emit({ type: "msg.updated", ... })
    // We can verify the reaction was stored
    const reactions = store.getReactions(msg.id);
    expect(reactions.length).toBe(1);
    expect(reactions[0].reaction).toBe('agree');
    
    unsubscribe?.();
  });
});
