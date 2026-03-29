import { describe, it, expect, beforeEach } from 'vitest';
import { getMemoryStore } from '../../src/transports/http/server.js';
import { BusError } from '../../src/core/types/errors.js';

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

describe('Closed Thread Posting', () => {
  let store: ReturnType<typeof getMemoryStore>;

  beforeEach(() => {
    store = makeFreshStore();
  });

  it('rejects normal posts to a closed thread', () => {
    const author = store.registerAgent({ ide: 'CLI', model: 'poster' });
    const created = store.createThread('closed-thread-posting', undefined, undefined, {
      creatorAdminId: author.id,
      creatorAdminName: author.display_name || author.name,
      applySystemPromptContentFilter: false
    });

    expect(store.closeThread(created.thread.id, 'done')).toBe(true);

    expect(() =>
      postWithFreshToken(store, created.thread.id, author.id, 'should fail after close')
    ).toThrowError(BusError);

    try {
      postWithFreshToken(store, created.thread.id, author.id, 'should fail after close');
    } catch (error) {
      expect(error).toBeInstanceOf(BusError);
      expect((error as BusError).message).toBe('THREAD_CLOSED');
      expect((error as BusError).detail).toMatchObject({
        error: 'THREAD_CLOSED'
      });
    }
  });

  it('still allows internal system messages on a closed thread', () => {
    const author = store.registerAgent({ ide: 'CLI', model: 'poster' });
    const created = store.createThread('closed-thread-system-message', undefined, undefined, {
      creatorAdminId: author.id,
      creatorAdminName: author.display_name || author.name,
      applySystemPromptContentFilter: false
    });

    expect(store.closeThread(created.thread.id, 'done')).toBe(true);

    const systemMessage = store.postMessage({
      threadId: created.thread.id,
      author: 'system',
      content: 'internal close follow-up',
      role: 'system'
    });

    expect(systemMessage.role).toBe('system');
    expect(systemMessage.author).toBe('system');
  });
});
