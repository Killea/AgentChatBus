/**
 * Message Post Strict Sync Tests
 * Ported from: tests/test_msg_post.py and related sync tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';
import { SeqMismatchError, ReplyTokenInvalidError, ReplyTokenReplayError } from '../../src/core/types/errors.js';

describe('Message Post Strict Sync', () => {
  let store: MemoryStore;

  beforeEach(() => {
    // Use in-memory database for unit tests to avoid locking
    store = new MemoryStore(':memory:');
  });

  it('posts message with valid sync context', () => {
    const thread = store.createThread('test-thread').thread;
    const agent = store.registerAgent({ ide: 'TestIDE', model: 'TestModel' });
    
    const sync = store.issueSyncContext(thread.id, agent.id, 'test');
    
    const message = store.postMessage({
      threadId: thread.id,
      author: agent.id,
      content: 'Hello, World!',
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
      role: 'assistant',
    });

    expect(message.seq).toBe(1);
    expect(message.content).toBe('Hello, World!');
    expect(message.author_id).toBe(agent.id);
  });

  it('rejects message with wrong expected_last_seq', () => {
    const thread = store.createThread('test-thread').thread;
    const agent = store.registerAgent({ ide: 'TestIDE', model: 'TestModel' });
    
    const sync = store.issueSyncContext(thread.id, agent.id, 'test');
    
    // Try to post with wrong seq (off by more than tolerance)
    expect(() => store.postMessage({
      threadId: thread.id,
      author: agent.id,
      content: 'Bad message',
      expectedLastSeq: sync.current_seq + 10, // Way off
      replyToken: sync.reply_token,
      role: 'assistant',
    })).toThrow(SeqMismatchError);
  });

  it('accepts message within seq tolerance', () => {
    const thread = store.createThread('test-thread').thread;
    const agent = store.registerAgent({ ide: 'TestIDE', model: 'TestModel' });
    
    const sync = store.issueSyncContext(thread.id, agent.id, 'test');
    
    // Post with slightly off seq (within tolerance of 5)
    const message = store.postMessage({
      threadId: thread.id,
      author: agent.id,
      content: 'Tolerated message',
      expectedLastSeq: sync.current_seq + 3, // Within tolerance
      replyToken: sync.reply_token,
      role: 'assistant',
    });

    expect(message.seq).toBe(1);
  });

  it('rejects message with invalid reply_token', () => {
    const thread = store.createThread('test-thread').thread;
    const agent = store.registerAgent({ ide: 'TestIDE', model: 'TestModel' });
    
    const sync = store.issueSyncContext(thread.id, agent.id, 'test');
    
    // Try to post with wrong token
    expect(() => store.postMessage({
      threadId: thread.id,
      author: agent.id,
      content: 'Invalid token message',
      expectedLastSeq: sync.current_seq,
      replyToken: 'invalid-token',
      role: 'assistant',
    })).toThrow(ReplyTokenInvalidError);
  });

  it('rejects message with consumed reply_token', () => {
    const thread = store.createThread('test-thread').thread;
    const agent = store.registerAgent({ ide: 'TestIDE', model: 'TestModel' });
    
    const sync = store.issueSyncContext(thread.id, agent.id, 'test');
    
    // Post a message to consume the token
    store.postMessage({
      threadId: thread.id,
      author: agent.id,
      content: 'First message',
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
      role: 'assistant',
    });
    
    // Try to reuse the same token (should fail as it's now consumed)
    // TS version throws ReplyTokenReplayError for consumed tokens
    expect(() => store.postMessage({
      threadId: thread.id,
      author: agent.id,
      content: 'Reused token message',
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
      role: 'assistant',
    })).toThrow(); // Should throw some error (ReplyTokenReplayError or ReplyTokenInvalidError)
  });

  it('allows chain posting after successful post', () => {
    const thread = store.createThread('test-thread').thread;
    const agent = store.registerAgent({ ide: 'TestIDE', model: 'TestModel' });
    
    // First post
    const sync1 = store.issueSyncContext(thread.id, agent.id, 'test');
    const msg1 = store.postMessage({
      threadId: thread.id,
      author: agent.id,
      content: 'First message',
      expectedLastSeq: sync1.current_seq,
      replyToken: sync1.reply_token,
      role: 'assistant',
    });

    expect(msg1.seq).toBe(1);

    // Second post using new token from first post
    const sync2 = store.issueSyncContext(thread.id, agent.id, 'test');
    const msg2 = store.postMessage({
      threadId: thread.id,
      author: agent.id,
      content: 'Second message',
      expectedLastSeq: sync2.current_seq,
      replyToken: sync2.reply_token,
      role: 'assistant',
    });

    expect(msg2.seq).toBe(2);
  });

  it('posts message with metadata', () => {
    const thread = store.createThread('test-thread').thread;
    const agent = store.registerAgent({ ide: 'TestIDE', model: 'TestModel' });
    
    const sync = store.issueSyncContext(thread.id, agent.id, 'test');
    
    const message = store.postMessage({
      threadId: thread.id,
      author: agent.id,
      content: 'Message with metadata',
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
      role: 'assistant',
      metadata: { handoff_target: 'agent-b', priority: 'high' },
    });

    expect(message.metadata).toEqual({ handoff_target: 'agent-b', priority: 'high' });
  });

  it('posts message with role user', () => {
    const thread = store.createThread('test-thread').thread;
    const agent = store.registerAgent({ ide: 'TestIDE', model: 'TestModel' });
    
    const sync = store.issueSyncContext(thread.id, agent.id, 'test');
    
    const message = store.postMessage({
      threadId: thread.id,
      author: 'human',
      content: 'Human message',
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
      role: 'user',
    });

    expect(message.role).toBe('user');
    expect(message.author).toBe('human');
  });

  it('increments sequence correctly for multiple messages', () => {
    const thread = store.createThread('test-thread').thread;
    const agent = store.registerAgent({ ide: 'TestIDE', model: 'TestModel' });
    
    let currentSeq = 0;
    
    for (let i = 1; i <= 5; i++) {
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');
      const message = store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: `Message ${i}`,
        expectedLastSeq: currentSeq,
        replyToken: sync.reply_token,
        role: 'assistant',
      });
      
      expect(message.seq).toBe(i);
      currentSeq = message.seq;
    }
  });

  it('stores message with correct thread_id', () => {
    const thread1 = store.createThread('thread-1').thread;
    const thread2 = store.createThread('thread-2').thread;
    const agent = store.registerAgent({ ide: 'TestIDE', model: 'TestModel' });
    
    const sync1 = store.issueSyncContext(thread1.id, agent.id, 'test');
    const sync2 = store.issueSyncContext(thread2.id, agent.id, 'test');
    
    const msg1 = store.postMessage({
      threadId: thread1.id,
      author: agent.id,
      content: 'Message in thread 1',
      expectedLastSeq: sync1.current_seq,
      replyToken: sync1.reply_token,
      role: 'assistant',
    });

    const msg2 = store.postMessage({
      threadId: thread2.id,
      author: agent.id,
      content: 'Message in thread 2',
      expectedLastSeq: sync2.current_seq,
      replyToken: sync2.reply_token,
      role: 'assistant',
    });

    expect(msg1.thread_id).toBe(thread1.id);
    expect(msg2.thread_id).toBe(thread2.id);
  });

  it('retrieves posted messages correctly', () => {
    const thread = store.createThread('test-thread').thread;
    const agent = store.registerAgent({ ide: 'TestIDE', model: 'TestModel' });
    
    const sync = store.issueSyncContext(thread.id, agent.id, 'test');
    store.postMessage({
      threadId: thread.id,
      author: agent.id,
      content: 'Test message',
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
      role: 'assistant',
    });

    const messages = store.getMessages(thread.id, 0);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('Test message');
    expect(messages[0].seq).toBe(1);
  });
});
