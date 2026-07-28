/**
 * Tests for UP-27 thread tagging.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';
import { randomUUID } from 'crypto';
import { unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let store: MemoryStore;
let dbPath: string;

beforeEach(() => {
  vi.stubEnv('AGENTCHATBUS_RATE_LIMIT_ENABLED', 'false');
  dbPath = join(tmpdir(), `test-thread-tags-${randomUUID()}.db`);
  store = new MemoryStore(dbPath);
});

afterEach(() => {
  try {
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
  } catch {}
});

describe('Thread tags (UP-27)', () => {
  it('addThreadTag stores normalized tag', () => {
    const { thread } = store.createThread('tag-test');
    const tags = store.addThreadTag(thread.id, '  Feature-X  ');
    expect(tags).toEqual(['feature-x']);
    expect(store.getThreadTags(thread.id)).toEqual(['feature-x']);
  });

  it('addThreadTag is idempotent on re-add', () => {
    const { thread } = store.createThread('tag-idempotent');
    store.addThreadTag(thread.id, 'bugfix');
    const tags = store.addThreadTag(thread.id, 'bugfix');
    expect(tags).toEqual(['bugfix']);
    expect(store.getThreadTags(thread.id).length).toBe(1);
  });

  it('removeThreadTag removes tag', () => {
    const { thread } = store.createThread('tag-remove');
    store.addThreadTag(thread.id, 'review');
    const result = store.removeThreadTag(thread.id, 'review');
    expect(result?.removed).toBe(true);
    expect(result?.tags).toEqual([]);
  });

  it('normalizeThreadTag rejects invalid tags', () => {
    const { thread } = store.createThread('tag-invalid');
    expect(() => store.addThreadTag(thread.id, '')).toThrow(/Invalid tag/);
    expect(() => store.addThreadTag(thread.id, 'bad tag')).toThrow(/Invalid tag/);
    expect(() => store.addThreadTag(thread.id, '-invalid')).toThrow(/Invalid tag/);
  });

  it('deleteThread cascades thread_tags', () => {
    const { thread } = store.createThread('tag-cascade');
    store.addThreadTag(thread.id, 'temp');
    expect(store.getThreadTags(thread.id)).toEqual(['temp']);
    store.deleteThread(thread.id);
    expect(store.getThreadTags(thread.id)).toEqual([]);
    expect(store.listAllTags()).toEqual([]);
  });

  it('getThreads includes tags via bulk attach', () => {
    const { thread: t1 } = store.createThread('tag-list-1');
    const { thread: t2 } = store.createThread('tag-list-2');
    store.addThreadTag(t1.id, 'alpha');
    store.addThreadTag(t2.id, 'beta');

    const threads = store.getThreads(true);
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    expect(byId.get(t1.id)?.tags).toEqual(['alpha']);
    expect(byId.get(t2.id)?.tags).toEqual(['beta']);
  });

  it('getThread includes tags', () => {
    const { thread } = store.createThread('tag-get');
    store.addThreadTag(thread.id, 'docs');
    const loaded = store.getThread(thread.id);
    expect(loaded?.tags).toEqual(['docs']);
  });

  it('listThreads filters by tag', () => {
    const { thread: t1 } = store.createThread('tag-filter-1');
    const { thread: t2 } = store.createThread('tag-filter-2');
    store.addThreadTag(t1.id, 'shared');
    store.addThreadTag(t2.id, 'other');

    const filtered = store.listThreads({ tag: 'shared' }).threads;
    expect(filtered.map((thread) => thread.id)).toEqual([t1.id]);
    expect(filtered[0].tags).toEqual(['shared']);
  });

  it('getThreadTagsBulk returns map for multiple threads', () => {
    const { thread: t1 } = store.createThread('tag-bulk-1');
    const { thread: t2 } = store.createThread('tag-bulk-2');
    store.addThreadTag(t1.id, 'one');
    store.addThreadTag(t2.id, 'two');

    const bulk = store.getThreadTagsBulk([t1.id, t2.id, 'missing']);
    expect(bulk.get(t1.id)).toEqual(['one']);
    expect(bulk.get(t2.id)).toEqual(['two']);
    expect(bulk.get('missing')).toEqual([]);
  });
});
