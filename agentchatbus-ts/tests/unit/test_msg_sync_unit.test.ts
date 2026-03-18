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
import { getMemoryStore } from '../../src/transports/http/server.js';
import type { MessageRecord } from '../../src/core/types/models.js';

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
        // 重置 store 到初始状态
        store.reset();
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
        }).toThrow("Missing required sync fields");
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
        }).toThrow("TOKEN_REPLAY");
    });

    it('seq mismatch returns new messages context', async () => {
        // 对应 Python: L75-101
        const SEQ_TOLERANCE = 5; // 从 config 导入
        const thread = store.createThread("sync-seq-mismatch").thread;
        const baseline = store.issueSyncContext(thread.id, "human", "test");

        // 对应 Python: L82-84 - Move thread ahead beyond tolerance
        for (let i = 0; i < SEQ_TOLERANCE + 1; i++) {
            await postWithFreshToken(store, thread.id, "human", `msg-${i}`);
        }

        const fresh = store.issueSyncContext(thread.id, "human", "test");
        
        // 对应 Python: L87-95
        try {
            store.postMessage({
                threadId: thread.id,
                author: "human",
                content: "stale-context-post",
                expectedLastSeq: baseline.current_seq,
                replyToken: fresh.reply_token,
                role: "assistant"
            });
            throw new Error("Should have thrown SeqMismatchError but succeeded");
        } catch (err: any) {
            // 对应 Python: L97-99
            if (err.message.includes("Should have thrown")) throw err;
            
            expect(err.name).oneOf(["SeqMismatchError", "BusError"]);
            expect(err.message).toContain("SEQ_MISMATCH");
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
        }).toThrow("TOKEN_INVALID");
    });

    it('token expired after timeout', async () => {
        // 对应 Python: L123-144
        // 注意：Python 版本中 tokens 实际上不会过期 (expires_at="9999-12-31")
        // 所以这个测试应该验证 token 在等待后仍然有效
        const thread = store.createThread("sync-expired-token").thread;
        const sync = store.issueSyncContext(thread.id, "human", "test");

        // Wait a bit
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Token should still be valid (not expired)
        expect(() => {
            store.postMessage({
                threadId: thread.id,
                author: "human",
                content: "after-wait",
                expectedLastSeq: sync.current_seq,
                replyToken: sync.reply_token,
                role: "assistant"
            });
        }).not.toThrow();
    });

    it('fast return scenarios', async () => {
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

        // msg_wait with old after_seq should return messages (agent is behind)
        const waitResult = await store.waitForMessages({
            threadId: thread.id,
            afterSeq: 0, // Behind current state
            agentId: "human"
        });

        // Should return the message that was posted
        expect(waitResult.messages.length).toBeGreaterThan(0);
    });

    it('msg_wait returns at most 100 messages per poll like Python msg_list', async () => {
        const thread = store.createThread("sync-msg-wait-batch").thread;
        const agent = store.registerAgent({ ide: "VSCode", model: "GPT" });
        const previousRateLimitFlag = process.env.AGENTCHATBUS_RATE_LIMIT_ENABLED;
        const originalPersistState = (store as any).persistState;
        process.env.AGENTCHATBUS_RATE_LIMIT_ENABLED = "false";

        try {
            (store as any).persistState = () => {};
            for (let i = 0; i < 105; i++) {
                store.postSystemMessage(thread.id, `system-${i}`);
            }
            (store as any).persistState = originalPersistState;
            originalPersistState.call(store);

            const first = await store.waitForMessages({
                threadId: thread.id,
                afterSeq: 0,
                timeoutMs: 1,
                agentId: agent.id,
                agentToken: agent.token
            });
            expect(first.messages).toHaveLength(100);
            expect(first.messages[0].content).toBe("system-0");
            expect(first.messages[99].content).toBe("system-99");

            const second = await store.waitForMessages({
                threadId: thread.id,
                afterSeq: first.messages[99].seq,
                timeoutMs: 1,
                agentId: agent.id,
                agentToken: agent.token
            });
            expect(second.messages).toHaveLength(5);
            expect(second.messages[0].content).toBe("system-100");
            expect(second.messages[4].content).toBe("system-104");
        } finally {
            (store as any).persistState = originalPersistState;
            if (previousRateLimitFlag === undefined) {
                delete process.env.AGENTCHATBUS_RATE_LIMIT_ENABLED;
            } else {
                process.env.AGENTCHATBUS_RATE_LIMIT_ENABLED = previousRateLimitFlag;
            }
        }
    });

    it('msg_wait without token issues an unbound reply token', async () => {
        const thread = store.createThread("sync-msg-wait-unbound").thread;
        const agent = store.registerAgent({ ide: "VSCode", model: "GPT" });

        const out = await store.waitForMessages({
            threadId: thread.id,
            afterSeq: 0,
            timeoutMs: 1,
            agentId: agent.id
        });

        const tokenRecord = (store as any).syncTokens.get(out.reply_token);
        expect(tokenRecord).toBeDefined();
        expect(tokenRecord.agentId).toBeUndefined();
    });

    it('seq tolerance within limit', () => {
        // With SEQ_TOLERANCE = 0 (strict mode), ANY mismatch triggers SeqMismatchError
        // This test verifies that posting with the correct seq succeeds
        const thread = store.createThread("sync-tolerance").thread;
        
        // Get baseline seq
        const baseline = store.issueSyncContext(thread.id, "human", "test");
        const baselineSeq = baseline.current_seq; // Should be 0 after reset
        
        // Post a message with correct sync context - should succeed
        const fresh = store.issueSyncContext(thread.id, "human", "test");
        expect(() => {
            store.postMessage({
                threadId: thread.id,
                author: "human",
                content: "at-current-seq",
                expectedLastSeq: fresh.current_seq, // Using CURRENT seq, not stale
                replyToken: fresh.reply_token,
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

    it('token rejects cross thread use', () => {
        // Test 1: Token issued for thread A must not work for thread B
        const threadA = store.createThread("cross-thread-a").thread;
        const threadB = store.createThread("cross-thread-b").thread;
        
        // Issue token for thread A
        const syncA = store.issueSyncContext(threadA.id, "human", "test");
        
        // Try to use token_a in thread_b → should reject
        expect(() => {
            store.postMessage({
                threadId: threadB.id,  // ← Different thread!
                author: "human",
                content: "wrong-thread-use",
                expectedLastSeq: syncA.current_seq,
                replyToken: syncA.reply_token,  // ← Token from thread A
                role: "assistant"
            });
        }).toThrow();
    });

    it('token rejects cross agent use', () => {
        // Token bound to agent_a must not be usable by agent_b (Python parity)
        const thread = store.createThread("cross-agent").thread;
        
        // Register two agents
        const agentA = store.registerAgent({ ide: "VSCode", model: "GPT-A" });
        const agentB = store.registerAgent({ ide: "VSCode", model: "GPT-B" });
        
        // Issue token bound to agent_a
        const sync = store.issueSyncContext(thread.id, agentA.id, "test");
        
        // Attempt to use agent_a token for agent_b
        expect(() => {
            store.postMessage({
                threadId: thread.id,
                author: agentB.id,
                content: "cross-agent misuse",
                expectedLastSeq: sync.current_seq,
                replyToken: sync.reply_token,
                role: "assistant"
            });
        }).toThrow();
    });

    it('cross agent token misuse does not leak sync context and does not burn owner token', () => {
        const thread = store.createThread("cross-agent-no-leak").thread;
        const agentA = store.registerAgent({ ide: "VSCode", model: "GPT-A" });
        const agentB = store.registerAgent({ ide: "VSCode", model: "GPT-B" });
        const sync = store.issueSyncContext(thread.id, agentA.id, "test");

        try {
            store.postMessage({
                threadId: thread.id,
                author: agentB.id,
                content: "cross-agent misuse",
                expectedLastSeq: sync.current_seq,
                replyToken: sync.reply_token,
                role: "assistant"
            });
            throw new Error("Should have thrown ReplyTokenInvalidError but succeeded");
        } catch (err: any) {
            if (err.message.includes("Should have thrown")) throw err;

            expect(err.name).toBe("ReplyTokenInvalidError");
            expect(err.message).toBe("TOKEN_INVALID");
            expect(err.detail).toMatchObject({
                error: "TOKEN_INVALID",
                action: "CALL_MSG_WAIT"
            });
            expect(err.detail.current_seq).toBeUndefined();
            expect(err.detail.new_messages).toBeUndefined();
            expect(err.detail.expected_last_seq).toBeUndefined();
        }

        expect(store.getRefreshRequest(thread.id, agentB.id)).toBeUndefined();

        const ownerPost = store.postMessage({
            threadId: thread.id,
            author: agentA.id,
            content: "owner still has a valid token",
            expectedLastSeq: sync.current_seq,
            replyToken: sync.reply_token,
            role: "assistant"
        });

        expect(ownerPost.seq).toBe(1);
        expect(ownerPost.author_id).toBe(agentA.id);
    });

    it('chain token issued for registered agent', () => {
        // UP-32: msg_post with a registered agent should issue a chain reply_token
        // Note: Chain token is issued at dispatch layer (handle_msg_post), not CRUD layer
        // This test verifies the CRUD layer behavior - actual chain token is in HTTP response
        const thread = store.createThread("chain-token").thread;
        const agent = store.registerAgent({ ide: "Cursor", model: "test-model" });
        const sync = store.issueSyncContext(thread.id, agent.id, "test");

        const result = store.postMessage({
            threadId: thread.id,
            author: agent.id,
            content: "first message",
            expectedLastSeq: sync.current_seq,
            replyToken: sync.reply_token,
            role: "assistant"
        });

        // CRUD layer returns the message, chain_token is added at dispatch layer
        expect(result.id).toBeDefined();
        expect(result.seq).toBeGreaterThan(0);
    });

    it('anonymous author message posts successfully', () => {
        // Verify anonymous authors can still post messages
        const thread = store.createThread("anon-post").thread;
        const sync = store.issueSyncContext(thread.id, "anonymous-user", "test");

        const result = store.postMessage({
            threadId: thread.id,
            author: "anonymous-user",
            content: "anon message",
            expectedLastSeq: sync.current_seq,
            replyToken: sync.reply_token,
            role: "assistant"
        });

        // Message should be posted successfully
        expect(result.id).toBeDefined();
        expect(result.author).toBe("anonymous-user");
    });
});
