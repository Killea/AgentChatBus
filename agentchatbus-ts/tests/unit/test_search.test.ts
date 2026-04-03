/**
 * Search Unit Tests
 * Ported from Python: tests/test_search.py
 * Note: TypeScript uses LIKE query instead of FTS5
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

describe('Search Unit Tests', () => {
  let store: MemoryStore;

  beforeEach(() => {
    process.env.AGENTCHATBUS_DB = ':memory:';
    store = new MemoryStore();
    store.reset();
  });

  function postMessage(threadId: string, author: string, content: string) {
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

  it('searchMessages returns matching messages', () => {
    const thread = store.createThread('Search Test Thread').thread;
    postMessage(thread.id, 'agent-a', 'Angular signals are great for reactivity');
    postMessage(thread.id, 'agent-b', 'RxJS observables are also useful');

    const results = store.searchMessages('Angular');
    expect(results.length).toBe(1);
    expect(results[0].content).toContain('Angular');
  });

  it('searchMessages is case insensitive', () => {
    const thread = store.createThread('Case Test Thread').thread;
    postMessage(thread.id, 'agent-a', 'ANGULAR SIGNALS ARE GREAT');

    const results = store.searchMessages('angular');
    expect(results.length).toBe(1);
  });

  it('searchMessages returns empty for no match', () => {
    const thread = store.createThread('Empty Test Thread').thread;
    postMessage(thread.id, 'agent-a', 'hello world');

    const results = store.searchMessages('zxqvbnm');
    expect(results).toEqual([]);
  });

  it('searchMessages returns message fields', () => {
    const thread = store.createThread('Fields Test Thread').thread;
    postMessage(thread.id, 'agent-a', 'testing field completeness here');

    const results = store.searchMessages('completeness');
    expect(results.length).toBe(1);
    const r = results[0];
    expect(r.id).toBeDefined();
    expect(r.thread_id).toBeDefined();
    expect(r.author).toBeDefined();
    expect(r.content).toBeDefined();
    expect(r.seq).toBeGreaterThan(0);
    expect(r.created_at).toBeDefined();
  });

  it('searchMessages returns results across multiple threads without filter', () => {
    const threadA = store.createThread('Thread A').thread;
    const threadB = store.createThread('Thread B').thread;
    postMessage(threadA.id, 'agent-a', 'consensus algorithm decision');
    postMessage(threadB.id, 'agent-b', 'consensus protocol design');

    const results = store.searchMessages('consensus');
    const threadIds = new Set(results.map((r) => r.thread_id));
    expect(threadIds.has(threadA.id)).toBe(true);
    expect(threadIds.has(threadB.id)).toBe(true);
  });

  it('searchMessages invalid query does not throw and returns array', () => {
    const thread = store.createThread('Invalid Query Thread').thread;
    postMessage(thread.id, 'agent-a', 'some content here');

    const run = () => store.searchMessages('*');
    expect(run).not.toThrow();
    expect(Array.isArray(run())).toBe(true);
  });

  it('searchMessages with thread filter', () => {
    const threadA = store.createThread('Thread A').thread;
    const threadB = store.createThread('Thread B').thread;
    postMessage(threadA.id, 'agent-a', 'performance optimization tips');
    postMessage(threadB.id, 'agent-b', 'performance tuning in production');

    const results = store.searchMessages('performance', threadA.id);
    expect(results.length).toBe(1);
    expect(results[0].thread_id).toBe(threadA.id);
  });

  it('searchMessages respects limit parameter', () => {
    const thread = store.createThread('Limit Test Thread').thread;
    for (let i = 0; i < 10; i++) {
      postMessage(thread.id, 'agent-a', `keyword common term iteration ${i}`);
    }

    const results = store.searchMessages('keyword', undefined, 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('searchMessages excludes human-only transcript entries', () => {
    const thread = store.createThread('Hidden Search Thread').thread;
    postMessage(thread.id, 'agent-a', 'visible searchable note');
    store.postSystemMessage(
      thread.id,
      'hidden searchable note',
      JSON.stringify({ visibility: 'human_only', ui_type: 'admin_switch_confirmation_required' }),
    );

    const results = store.searchMessages('searchable');
    expect(results.map((result) => result.content)).toEqual(['visible searchable note']);
  });
});
