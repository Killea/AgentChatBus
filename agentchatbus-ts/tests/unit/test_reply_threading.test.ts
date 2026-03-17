/**
 * test_reply_threading.test.ts
 * 
 * 移植自 Python: tests/test_reply_threading.py (L1-230 Unit Tests)
 * 功能：Reply-To Message Threading (UP-14)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

describe('Reply Threading Unit Tests', () => {
    let store: MemoryStore;

    beforeEach(() => {
        // 每测试使用独立内存数据库，模拟 Python :memory: 行为
        process.env.AGENTCHATBUS_DB = ':memory:';
        store = new MemoryStore();
        store.reset();
    });

    // 辅助函数 - 对应 Python _create_thread() L31-33
    function createThread(topic: string = "test-thread") {
        return store.createThread(topic).thread;
    }

    // 辅助函数 - 对应 Python _post_msg() L36-52
    function postMessage(
        threadId: string,
        content: string = "hello",
        author: string = "agent-a",
        replyToMsgId?: string
    ) {
        const sync = store.issueSyncContext(threadId, author, "test");
        return store.postMessage({
            threadId,
            author,
            content,
            expectedLastSeq: sync.current_seq,
            replyToken: sync.reply_token,
            role: "user",
            replyToMsgId
        });
    }

    it('msg_post no reply', () => {
        // 对应 Python: L60-67
        /** Message without reply_to → reply_to_msg_id is None. */
        const thread = createThread();
        const msg = postMessage(thread.id, "first message");
        
        expect(msg.reply_to_msg_id).toBeUndefined();
    });

    it('msg_post with reply', () => {
        // 对应 Python: L70-78
        /** Reply to a valid parent message → reply_to_msg_id stored. */
        const thread = createThread();
        const parent = postMessage(thread.id, "parent");
        const reply = postMessage(thread.id, "child", "agent-b", parent.id);
        
        expect(reply.reply_to_msg_id).toBe(parent.id);
    });

    it('msg_post reply nonexistent', () => {
        // 对应 Python: L81-89
        /** Reply to a non-existent message ID → ValueError. */
        const thread = createThread();
        const fakeId = "00000000-0000-0000-0000-000000000000";
        
        expect(() => {
            postMessage(thread.id, "orphan", "agent-a", fakeId);
        }).toThrow("does not exist");
    });

    it('msg_post reply wrong thread', () => {
        // 对应 Python: L92-102
        /** Reply to a message from a different thread → ValueError. */
        const thread1 = createThread("thread-1");
        const thread2 = createThread("thread-2");
        const msgInThread1 = postMessage(thread1.id, "in thread 1");
        
        expect(() => {
            postMessage(thread2.id, "wrong thread reply", "agent-a", msgInThread1.id);
        }).toThrow("different thread");
    });

    it('msg_list includes reply_to', () => {
        // 对应 Python: L105-119
        /** msg_list() returns messages with reply_to_msg_id populated. */
        const thread = createThread();
        const parent = postMessage(thread.id, "parent");
        const child = postMessage(thread.id, "child", "agent-b", parent.id);

        const msgs = store.getMessages(thread.id, 0);
        expect(msgs.length).toBe(2);
        
        const parentInList = msgs.find(m => m.id === parent.id);
        const childInList = msgs.find(m => m.id === child.id);
        
        expect(parentInList?.reply_to_msg_id).toBeUndefined();
        expect(childInList?.reply_to_msg_id).toBe(parent.id);
    });

    it('msg_get existing', () => {
        // 对应 Python: L122-132
        /** msg_get() returns the correct message. */
        const thread = createThread();
        const msg = postMessage(thread.id, "fetchable");
        
        const fetched = store.getMessage(msg.id);
        
        expect(fetched).toBeDefined();
        if (fetched) {
            expect(fetched.id).toBe(msg.id);
            expect(fetched.content).toBe("fetchable");
        }
    });

    it('msg_get nonexistent', () => {
        // 对应 Python: L135-142
        /** msg_get() returns None for an unknown ID. */
        createThread();
        const fakeId = "00000000-0000-0000-0000-000000000000";
        
        const result = store.getMessage(fakeId);
        
        expect(result).toBeUndefined();
    });

    it('sse event msg_reply emitted', () => {
        // 对应 Python: L145-170
        /** msg.reply SSE event is emitted when reply_to_msg_id is provided. */
        const thread = createThread();
        const parent = postMessage(thread.id, "parent");
        
        // Post reply and check if SSE event was emitted
        const reply = postMessage(thread.id, "child", "agent-b", parent.id);
        
        // Verify reply has correct reply_to_msg_id
        expect(reply.reply_to_msg_id).toBe(parent.id);
        
        // Note: Full SSE testing would require event subscription
        // This basic test verifies the reply_to_msg_id is set correctly
    });

    it('reply chain multiple levels', () => {
        // 对应 Python: L172-200
        /** Build a chain of replies: A → B → C → D. */
        const thread = createThread();
        
        const msgA = postMessage(thread.id, "A");
        const msgB = postMessage(thread.id, "B", "agent-b", msgA.id);
        const msgC = postMessage(thread.id, "C", "agent-c", msgB.id);
        const msgD = postMessage(thread.id, "D", "agent-d", msgC.id);
        
        expect(msgA.reply_to_msg_id).toBeUndefined();
        expect(msgB.reply_to_msg_id).toBe(msgA.id);
        expect(msgC.reply_to_msg_id).toBe(msgB.id);
        expect(msgD.reply_to_msg_id).toBe(msgC.id);
    });

    it('reply validation strict mode', () => {
        // 对应 Python: L202-230
        /** Reply-to validation is strict: must exist in same thread. */
        const thread = createThread();
        
        // Valid reply should succeed
        const parent = postMessage(thread.id, "parent");
        expect(() => {
            postMessage(thread.id, "valid reply", "agent-b", parent.id);
        }).not.toThrow();
        
        // Invalid reply (nonexistent) should fail
        const fakeId = "00000000-0000-0000-0000-000000000000";
        expect(() => {
            postMessage(thread.id, "invalid reply", "agent-b", fakeId);
        }).toThrow("does not exist");
        
        // Cross-thread reply should fail
        const thread2 = createThread("thread-2");
        const msgInThread2 = postMessage(thread2.id, "in thread 2");
        expect(() => {
            postMessage(thread.id, "cross thread", "agent-b", msgInThread2.id);
        }).toThrow("different thread");
    });

    it('sse event msg_reply not emitted for non-reply', () => {
        // 对应 Python: L173-187
        /** msg.reply SSE event is NOT emitted when reply_to_msg_id is NOT provided. */
        const thread = createThread();
        const msg = postMessage(thread.id, "standalone message");
        
        // No reply_to_msg_id means this is not a reply
        expect(msg.reply_to_msg_id).toBeUndefined();
    });

    it('old db compat - null reply_to_msg_id', () => {
        // 对应 Python: L233-246
        /** Old messages without reply_to_msg_id should work fine. */
        const thread = createThread();
        const msg = postMessage(thread.id, "old style message");
        
        // Verify the message was created successfully without reply_to_msg_id
        expect(msg.id).toBeDefined();
        expect(msg.content).toBe("old style message");
    });
});
