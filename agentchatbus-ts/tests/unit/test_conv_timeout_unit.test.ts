import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

function backdateThread(store: MemoryStore, threadId: string, minutesAgo: number) {
  const oldIso = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  (store as any).persistenceDb.prepare('UPDATE threads SET created_at = ? WHERE id = ?').run(oldIso, threadId);
}

function backdateMessages(store: MemoryStore, threadId: string, minutesAgo: number) {
  const oldIso = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  (store as any).persistenceDb.prepare('UPDATE messages SET created_at = ? WHERE thread_id = ?').run(oldIso, threadId);
}

function postMessage(store: MemoryStore, threadId: string, author: string, content: string) {
  const sync = store.issueSyncContext(threadId, author, 'test');
  return store.postMessage({
    threadId,
    author,
    content,
    expectedLastSeq: sync.current_seq,
    replyToken: sync.reply_token,
    role: 'user'
  });
}

describe('Conversation Timeout Unit Tests (Ported from test_conv_timeout_unit.py)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(':memory:');
  });

  it('timeout sweep disabled returns empty', () => {
    const result = store.threadTimeoutSweep(0);
    expect(result).toEqual([]);
  });

  it('timeout sweep closes stale empty thread', () => {
    const thread = store.createThread('timeout-stale-empty-thread').thread;
    backdateThread(store, thread.id, 61);

    const closed = store.threadTimeoutSweep(60);
    expect(closed).toContain(thread.id);
    expect(store.getThread(thread.id)?.status).toBe('closed');
  });

  it('timeout sweep closes stale thread with old messages', () => {
    const thread = store.createThread('timeout-stale-with-msg').thread;
    postMessage(store, thread.id, 'agent', 'Old message');
    backdateMessages(store, thread.id, 61);
    backdateThread(store, thread.id, 61);

    const closed = store.threadTimeoutSweep(60);
    expect(closed).toContain(thread.id);
    expect(store.getThread(thread.id)?.status).toBe('closed');
  });

  it('timeout sweep keeps active thread', () => {
    const thread = store.createThread('timeout-active-thread').thread;
    postMessage(store, thread.id, 'agent', 'Recent message');

    const closed = store.threadTimeoutSweep(60);
    expect(closed).not.toContain(thread.id);
    expect(store.getThread(thread.id)?.status).toBe('discuss');
  });

  it('timeout sweep skips already closed', () => {
    const thread = store.createThread('timeout-already-closed').thread;
    store.setThreadStatus(thread.id, 'closed');
    backdateThread(store, thread.id, 61);

    const closed = store.threadTimeoutSweep(60);
    expect(closed).not.toContain(thread.id);
  });

  it('timeout sweep independent of other threads', () => {
    const stale = store.createThread('timeout-mix-stale').thread;
    const active = store.createThread('timeout-mix-active').thread;

    backdateThread(store, stale.id, 61);
    postMessage(store, active.id, 'agent', 'Fresh message');

    const closed = store.threadTimeoutSweep(60);
    expect(closed).toContain(stale.id);
    expect(closed).not.toContain(active.id);
    expect(store.getThread(stale.id)?.status).toBe('closed');
    expect(store.getThread(active.id)?.status).toBe('discuss');
  });

  it('timeout sweep returns list of ids', () => {
    const thread = store.createThread('timeout-id-list-test').thread;
    backdateThread(store, thread.id, 120);

    const closed = store.threadTimeoutSweep(60);
    expect(Array.isArray(closed)).toBe(true);
    expect(closed.every((id) => typeof id === 'string')).toBe(true);
    expect(closed).toContain(thread.id);
  });
});
