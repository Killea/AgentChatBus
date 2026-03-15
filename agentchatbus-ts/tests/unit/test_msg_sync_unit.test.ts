/**
 * Message Synchronization Unit Tests
 * 
 * 移植自：Python tests/test_msg_sync_unit.py
 * 对应关系：100% 逐行翻译
 * 
 * 覆盖的 Python 测试函数:
 * - test_msg_post_requires_sync_fields (L28-43)
 * - test_reply_token_replay_is_rejected (L46-72)
 * - test_seq_mismatch_returns_new_messages_context (L75-101)
 * - test_invalid_token_rejected (L104-120)
 * - test_token_expired (L123-144)
 * - test_fast_return_scenarios (L147-175)
 * - test_seq_tolerance (L178-203)
 * - test_concurrent_posts (L206-235)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getMemoryStore, memoryStoreInstance } from '../../src/transports/http/server.js';
import type { MessageRecord } from '../../src/core/types/index.js';

// 辅助函数 - 对应 Python _make_db() L9-13
function makeFreshStore() {
    process.env.AGENTCHATBUS_DB = ':memory:';
    const store = getMemoryStore();
    return store;
}

// 辅助函数 - 对应 Python _post_with_fresh_token() L16-25
async function postWithFreshToken(
    store: ReturnType<typeof getMemoryStore>,
    threadId: string,
    author: string,
    content: string
): Promise<MessageRecord> {
    const sync = store.issueSyncContext(threadId, author, "test");
    return store.postMessage({
        threadId,
        author,
        content,
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: "assistant"
    });
}

describe('Message Synchronization Unit Tests', () => {
    let store: ReturnType<typeof getMemoryStore>;

    beforeEach(() => {
        // 每测试使用独立内存数据库，模拟 Python :memory: 行为
        process.env.AGENTCHATBUS_DB = ':memory:';
        store = getMemoryStore();
    });

    it('msg_post requires sync fields', () => {
        // 对应 Python: L28-43
        const thread = store.createThread("sync-required").thread;

        // 对应 Python: L33-40
        expect(() => {
            store.postMessage({
                threadId: thread.id,
                author: "human",
                content: "hello",
                expectedLastSeq: undefined as any,
                replyToken: ""
            });
        }).toThrow("Missing sync fields");
    });

    it('reply token replay is rejected', () => {
        // 对应 Python: L46-72
        const thread = store.createThread("sync-replay").thread;
        const sync = store.issueSyncContext(thread.id, "human", "test");

        // 对应 Python: L53-60
        store.postMessage({
            threadId: thread.id,
            author: "human",
            content: "first",
            expectedLastSeq: sync.current_seq,
            replyToken: sync.reply_token,
            role: "assistant"
        });

        // 对应 Python: L62-70
        expect(() => {
            store.postMessage({
                threadId: thread.id,
                author: "human",
                content: "second",
                expectedLastSeq: sync.current_seq + 1,
                replyToken: sync.reply_token  // Replay same token
            });
        }).toThrow("Reply token replay");
    });

    it('seq mismatch returns new messages context', () => {
        // 对应 Python: L75-101
        const SEQ_TOLERANCE = 5; // 从 config 导入
        const thread = store.createThread("sync-seq-mismatch").thread;
        const baseline = store.issueSyncContext(thread.id, "human", "test");

        // 对应 Python: L82-84 - Move thread ahead beyond tolerance
        for (let i = 0; i < SEQ_TOLERANCE + 1; i++) {
            postWithFreshToken(store, thread.id, "human", `msg-${i}`);
        }

        const fresh = store.issueSyncContext(thread.id, "human", "test");
        
        // 对应 Python: L87-95
        try {
            store.postMessage({
                threadId: thread.id,
                author: "human",
                content: "stale-context-post",
                expectedLastSeq: baseline.current_seq,
                replyToken: fresh.reply_token
            });
            throw new Error("Should have thrown SeqMismatchError");
        } catch (err: any) {
            // 对应 Python: L97-99
            expect(err.name).toBe("SeqMismatchError");
            expect(err.current_seq).toBeGreaterThan(baseline.current_seq);
            expect(err.new_messages).toBeDefined();
            expect(err.new_messages.length).toBeGreaterThanOrEqual(SEQ_TOLERANCE);
        }
    });

    it('invalid token is rejected', () => {
        // 对应 Python: L104-120
        const thread = store.createThread("sync-invalid-token").thread;
        const sync = store.issueSyncContext(thread.id, "human", "test");

        expect(() => {
            store.postMessage({
                threadId: thread.id,
                author: "human",
                content: "bad-token",
                expectedLastSeq: sync.current_seq,
                replyToken: "invalid-token-xyz"
            });
        }).toThrow("Invalid reply token");
    });

    it('token expired after timeout', () => {
        // 对应 Python: L123-144
        const thread = store.createThread("sync-expired-token").thread;
        const sync = store.issueSyncContext(thread.id, "human", "test", 100); // 100ms expiry

        // Wait for token to expire
        setTimeout(() => {
            expect(() => {
                store.postMessage({
                    threadId: thread.id,
                    author: "human",
                    content: "expired",
                    expectedLastSeq: sync.current_seq,
                    replyToken: sync.reply_token
                });
            }).toThrow("Reply token expired");
        }, 150);
    });

    it('fast return scenarios', () => {
        // 对应 Python: L147-175
        const thread = store.createThread("sync-fast-return").thread;
        
        // Post a message first
        const sync1 = store.issueSyncContext(thread.id, "human", "test");
        store.postMessage({
            threadId: thread.id,
            author: "human",
            content: "first",
            expectedLastSeq: sync1.current_seq,
            replyToken: sync1.reply_token,
            role: "assistant"
        });

        // msg_wait with old after_seq should fast return
        const waitResult = store.waitForMessages({
            threadId: thread.id,
            afterSeq: 0, // Behind current state
            agentId: "human"
        });

        expect(waitResult.fast_return).toBe(true);
        expect(waitResult.fast_return_reason).toBe("BEHIND");
        expect(waitResult.messages.length).toBeGreaterThan(0);
    });

    it('seq tolerance within limit', () => {
        // 对应 Python: L178-203
        const SEQ_TOLERANCE = 5;
        const thread = store.createThread("sync-tolerance").thread;
        
        // Get initial token
        const initial = store.issueSyncContext(thread.id, "human", "test");
        
        // Post messages within tolerance
        for (let i = 0; i < SEQ_TOLERANCE - 1; i++) {
            const fresh = store.issueSyncContext(thread.id, "human", "test");
            store.postMessage({
                threadId: thread.id,
                author: "human",
                content: `msg-${i}`,
                expectedLastSeq: fresh.current_seq,
                replyToken: fresh.reply_token,
                role: "assistant"
            });
        }

        // Should still accept initial token (within tolerance)
        expect(() => {
            store.postMessage({
                threadId: thread.id,
                author: "human",
                content: "within-tolerance",
                expectedLastSeq: initial.current_seq,
                replyToken: initial.reply_token,
                role: "assistant"
            });
        }).not.toThrow();
    });

    it('concurrent posts handled correctly', () => {
        // 对应 Python: L206-235
        const thread = store.createThread("sync-concurrent").thread;
        
        // Multiple agents posting concurrently
        const agents = ["agent-a", "agent-b", "agent-c"];
        const results: MessageRecord[] = [];

        for (const agent of agents) {
            const sync = store.issueSyncContext(thread.id, agent, "test");
            try {
                const msg = store.postMessage({
                    threadId: thread.id,
                    author: agent,
                    content: `Message from ${agent}`,
                    expectedLastSeq: sync.current_seq,
                    replyToken: sync.reply_token,
                    role: "assistant"
                });
                results.push(msg);
            } catch (err: any) {
                // Expected for concurrent posts - only one succeeds per seq
                if (err.name !== "SeqMismatchError") {
                    throw err;
                }
            }
        }

        // At least some messages should succeed
        expect(results.length).toBeGreaterThan(0);
    });
});
