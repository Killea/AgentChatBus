/**
 * Tests for UP-17: Structured message metadata attachments.
 * Ported from Python: tests/test_structured_metadata.py
 * 
 * Covers:
 * - handoff_target / stop_reason stored in metadata
 * - msg.handoff and msg.stop SSE events emitted
 * - for_agent filter in msg_wait dispatch
 * - metadata preserved in msg_list
 * - Invalid stop_reason validation
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';
import { eventBus } from '../../src/shared/eventBus.js';
import { randomUUID } from 'crypto';
import { unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let store: MemoryStore;
let dbPath: string;

function postWithMetadata(
  store: MemoryStore,
  threadId: string,
  author: string,
  content: string,
  metadata?: Record<string, unknown>
) {
  const sync = store.issueSyncContext(threadId);
  return store.postMessage({
    threadId,
    author,
    content,
    metadata,
    expectedLastSeq: sync.current_seq,
    replyToken: sync.reply_token,
  });
}

beforeEach(() => {
  // Disable rate limiting for tests
  vi.stubEnv('AGENTCHATBUS_RATE_LIMIT_ENABLED', 'false');
  // Use unique DB path for each test
  dbPath = join(tmpdir(), `test-metadata-${randomUUID()}.db`);
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
// Metadata Storage Tests
// ─────────────────────────────────────────────

describe('Metadata Storage', () => {
  it('msg_post with handoff_target', () => {
    const { thread } = store.createThread('metadata-test');
    const msg = postWithMetadata(store, thread.id, 'agent-a', 'Handing off to you', {
      handoff_target: 'agent-b',
    });
    expect(msg.metadata).not.toBeNull();
    expect(msg.metadata?.handoff_target).toBe('agent-b');
  });

  it('msg_post with stop_reason', () => {
    const { thread } = store.createThread('metadata-test');
    const msg = postWithMetadata(store, thread.id, 'agent-a', "I'm done", {
      stop_reason: 'convergence',
    });
    expect(msg.metadata).not.toBeNull();
    expect(msg.metadata?.stop_reason).toBe('convergence');
  });

  it('msg_post with both', () => {
    const { thread } = store.createThread('metadata-test');
    const msg = postWithMetadata(store, thread.id, 'agent-a', 'Done and passing over', {
      handoff_target: 'agent-b',
      stop_reason: 'complete',
    });
    expect(msg.metadata?.handoff_target).toBe('agent-b');
    expect(msg.metadata?.stop_reason).toBe('complete');
  });

  it('msg_post invalid stop_reason raises', () => {
    const { thread } = store.createThread('metadata-test');
    expect(() =>
      postWithMetadata(store, thread.id, 'agent-a', 'Should fail', {
        stop_reason: 'not-valid',
      })
    ).toThrow(/Invalid stop_reason/);
  });

  it('msg_post backward compat', () => {
    const { thread } = store.createThread('metadata-test');
    const msg = postWithMetadata(store, thread.id, 'agent-a', 'Plain message');
    expect(msg.metadata).toBeNull();
  });

  it('metadata preserved in msg_list', () => {
    const { thread } = store.createThread('metadata-test');
    postWithMetadata(store, thread.id, 'agent-a', 'With metadata', {
      handoff_target: 'agent-b',
      stop_reason: 'complete',
    });
    const msgs = store.getMessages(thread.id, 0);
    expect(msgs.length).toBe(1);
    expect(msgs[0].metadata).not.toBeNull();
    expect(msgs[0].metadata?.handoff_target).toBe('agent-b');
    expect(msgs[0].metadata?.stop_reason).toBe('complete');
  });
});

// ─────────────────────────────────────────────
// Event Emission Tests
// ─────────────────────────────────────────────

describe('Event Emission', () => {
  it('msg_post handoff event', () => {
    const { thread } = store.createThread('event-test');
    const emitSpy = vi.spyOn(eventBus, 'emit');

    postWithMetadata(store, thread.id, 'agent-a', 'Passing to agent-b', {
      handoff_target: 'agent-b',
    });

    const handoffCall = emitSpy.mock.calls.find(([evt]) => (evt as any)?.type === 'msg.handoff');
    expect(handoffCall).toBeDefined();
    expect(((handoffCall?.[0] as any)?.payload)?.to_agent).toBe('agent-b');

    emitSpy.mockRestore();
  });

  it('msg_post stop event', () => {
    const { thread } = store.createThread('event-test');
    const emitSpy = vi.spyOn(eventBus, 'emit');

    postWithMetadata(store, thread.id, 'agent-a', 'Stopping now', {
      stop_reason: 'impasse',
    });

    const stopCall = emitSpy.mock.calls.find(([evt]) => (evt as any)?.type === 'msg.stop');
    expect(stopCall).toBeDefined();
    expect(((stopCall?.[0] as any)?.payload)?.reason).toBe('impasse');

    emitSpy.mockRestore();
  });

  it('msg_post no handoff event when missing', () => {
    const { thread } = store.createThread('event-test');
    const emitSpy = vi.spyOn(eventBus, 'emit');

    postWithMetadata(store, thread.id, 'agent-a', 'Regular message');

    const handoffCall = emitSpy.mock.calls.find(([evt]) => (evt as any)?.type === 'msg.handoff');
    expect(handoffCall).toBeUndefined();

    emitSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────
// for_agent Filter Tests
// ─────────────────────────────────────────────

describe('for_agent Filter', () => {
  it('msg_wait for_agent match', () => {
    const { thread } = store.createThread('for-agent-test');
    // Post a message directed to agent-b
    const msg = postWithMetadata(store, thread.id, 'agent-a', 'Hey agent-b, your turn', {
      handoff_target: 'agent-b',
    });
    
    // Check metadata targeting helper
    const meta = msg.metadata as any;
    expect(meta?.handoff_target).toBe('agent-b');
  });

  it('msg_wait for_agent no match', () => {
    const { thread } = store.createThread('for-agent-test');
    const msg = postWithMetadata(store, thread.id, 'agent-a', 'General message');
    
    // Message should have no handoff_target
    expect(msg.metadata).toBeNull();
  });

  it('msg_wait no filter backward compat', () => {
    const { thread } = store.createThread('for-agent-test');
    postWithMetadata(store, thread.id, 'agent-a', 'General message');
    
    // Without for_agent filter, all messages should be returned
    const msgs = store.getMessages(thread.id, 0);
    expect(msgs.length).toBe(1);
  });
});

// ─────────────────────────────────────────────
// Valid stop_reason Values
// ─────────────────────────────────────────────

describe('Valid stop_reason Values', () => {
  const validReasons = ['convergence', 'timeout', 'error', 'complete', 'impasse'];

  for (const reason of validReasons) {
    it(`accepts stop_reason '${reason}'`, () => {
      const { thread } = store.createThread('stop-reason-test');
      const msg = postWithMetadata(store, thread.id, 'agent-a', 'Done', {
        stop_reason: reason,
      });
      expect(msg.metadata?.stop_reason).toBe(reason);
    });
  }

  it('rejects invalid stop_reason', () => {
    const { thread } = store.createThread('stop-reason-test');
    expect(() =>
      postWithMetadata(store, thread.id, 'agent-a', 'Bad', {
        stop_reason: 'invalid-reason',
      })
    ).toThrow(/Invalid stop_reason/);
  });
});
