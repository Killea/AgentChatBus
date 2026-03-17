/**
 * Rate Limit Unit Tests
 * Ported from Python: tests/test_rate_limit_unit.py
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';
import { RateLimitExceeded } from '../../src/core/types/errors.js';

describe('Rate Limit Unit Tests', () => {
  let store: MemoryStore;
  let originalLimit: string | undefined;
  let originalEnabled: string | undefined;

  beforeEach(() => {
    process.env.AGENTCHATBUS_DB = ':memory:';
    store = new MemoryStore();
    store.reset();
    originalLimit = process.env.AGENTCHATBUS_RATE_LIMIT;
    originalEnabled = process.env.AGENTCHATBUS_RATE_LIMIT_ENABLED;
  });

  afterEach(() => {
    if (originalLimit !== undefined) {
      process.env.AGENTCHATBUS_RATE_LIMIT = originalLimit;
    } else {
      delete process.env.AGENTCHATBUS_RATE_LIMIT;
    }
    if (originalEnabled !== undefined) {
      process.env.AGENTCHATBUS_RATE_LIMIT_ENABLED = originalEnabled;
    } else {
      delete process.env.AGENTCHATBUS_RATE_LIMIT_ENABLED;
    }
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

  it('RateLimitExceeded exposes attributes', () => {
    const err = new RateLimitExceeded(30, 60, 60, 'author_id');
    expect(err.limit).toBe(30);
    expect(err.window).toBe(60);
    expect(err.retryAfter).toBe(60);
    expect(err.scope).toBe('author_id');
  });

  it('RateLimitExceeded string contains limit and window', () => {
    const err = new RateLimitExceeded(5, 60, 60, 'author');
    expect(String(err)).toContain('5');
    expect(String(err)).toContain('60');
  });

  it('rate limit allows within limit', () => {
    process.env.AGENTCHATBUS_RATE_LIMIT = '3';
    const thread = store.createThread('rl-test').thread;

    for (let i = 0; i < 3; i++) {
      const msg = postMessage(thread.id, 'rl-user', `Message ${i}`);
      expect(msg.seq).toBeGreaterThan(0);
    }
  });

  it('rate limit blocks on exceed with detailed exception fields', () => {
    process.env.AGENTCHATBUS_RATE_LIMIT = '3';
    const thread = store.createThread('rl-exceed').thread;

    for (let i = 0; i < 3; i++) {
      postMessage(thread.id, 'rl-exceed-user', `Msg ${i}`);
    }

    let caught: unknown;
    try {
      postMessage(thread.id, 'rl-exceed-user', 'One too many');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RateLimitExceeded);
    const err = caught as RateLimitExceeded;
    expect(err.limit).toBe(3);
    expect(err.window).toBe(60);
    expect(err.retryAfter).toBeGreaterThan(0);
    expect(err.scope).toBe('author');
  });

  it('rate limit uses author_id scope for registered agent', () => {
    process.env.AGENTCHATBUS_RATE_LIMIT = '1';
    const agent = store.registerAgent({ ide: 'VS Code', model: 'gpt' });
    const thread = store.createThread('rl-author-id').thread;

    postMessage(thread.id, agent.id, 'first');

    let caught: unknown;
    try {
      postMessage(thread.id, agent.id, 'second');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RateLimitExceeded);
    expect((caught as RateLimitExceeded).scope).toBe('author_id');
  });

  it('rate limit scopes per author', () => {
    process.env.AGENTCHATBUS_RATE_LIMIT = '3';
    const thread = store.createThread('rl-scope').thread;

    for (let i = 0; i < 3; i++) {
      postMessage(thread.id, 'author-a', `Msg ${i}`);
    }

    expect(() => {
      postMessage(thread.id, 'author-a', 'Blocked');
    }).toThrow(RateLimitExceeded);

    const msg = postMessage(thread.id, 'author-b', 'Author B works');
    expect(msg.seq).toBeGreaterThan(0);
  });

  it('rate limit zero disables', () => {
    process.env.AGENTCHATBUS_RATE_LIMIT = '0';
    const thread = store.createThread('rl-disabled').thread;

    for (let i = 0; i < 10; i++) {
      const msg = postMessage(thread.id, 'rl-disabled-user', `Msg ${i}`);
      expect(msg.seq).toBeGreaterThan(0);
    }
  });

  it('rate limit can be disabled via env', () => {
    process.env.AGENTCHATBUS_RATE_LIMIT = '1';
    process.env.AGENTCHATBUS_RATE_LIMIT_ENABLED = 'false';
    const thread = store.createThread('rl-env-disabled').thread;

    for (let i = 0; i < 5; i++) {
      const msg = postMessage(thread.id, 'rl-env-user', `Msg ${i}`);
      expect(msg.seq).toBeGreaterThan(0);
    }
  });

  it('rate limit normal single message always passes', () => {
    process.env.AGENTCHATBUS_RATE_LIMIT = '3';
    const thread = store.createThread('rl-single').thread;

    const msg = postMessage(thread.id, 'rl-single-user', 'Normal message');
    expect(msg.seq).toBeGreaterThan(0);
  });

  it('RateLimitExceeded scope author fallback', () => {
    const err = new RateLimitExceeded(10, 60, 30, 'author');
    expect(err.scope).toBe('author');
  });
});
