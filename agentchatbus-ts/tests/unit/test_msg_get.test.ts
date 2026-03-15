/**
 * test_msg_get.test.ts
 * 
 * 移植自 Python: tests/test_msg_get.py
 * 功能：获取单条消息 (msg_get MCP tool)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

describe('Message Get Tests', () => {
    let store: MemoryStore;

    beforeEach(() => {
        // 每测试使用独立内存数据库，模拟 Python :memory: 行为
        process.env.AGENTCHATBUS_DB = ':memory:';
        store = new MemoryStore();
        store.reset();
    });

    // 辅助函数 - 对应 Python _post() L27-37
    function postMessage(
        threadId: string,
        author: string,
        content: string,
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

    it('msg_get returns message', async () => {
        // 对应 Python: L44-62
        /** msg_get returns full message fields for a valid ID. */
        const thread = store.createThread("get-test").thread;
        const msg = postMessage(thread.id, "agent-a", "hello world");

        const result = store.getMessage(msg.id);

        expect(result).toBeDefined();
        if (result) {
            expect(result.id).toBe(msg.id);
            expect(result.thread_id).toBe(thread.id);
            expect(result.author).toBe("agent-a");
            expect(result.content).toBe("hello world");
            expect(result.seq).toBe(msg.seq);
            expect(result.role).toBe("user");
            expect(result.priority).toBe("normal");
            expect(result.reply_to_msg_id).toBeUndefined();
        }
    });

    it('msg_get not found', async () => {
        // 对应 Python: L65-74
        /** msg_get returns None for a non-existent message ID. */
        const result = store.getMessage("msg-does-not-exist");

        expect(result).toBeUndefined();
    });

    it('msg_get includes reactions', async () => {
        // 对应 Python: L77-95
        /** msg_get returns message; reactions can be fetched via msg_reactions for the same ID. */
        const thread = store.createThread("reaction-get-test").thread;
        const agent = store.registerAgent({ ide: "Cursor", model: "GPT-4" });
        const msg = postMessage(thread.id, agent.id, "important message");

        // Add reaction
        store.addReaction(msg.id, agent.id, "agree");

        // Get message
        const result = store.getMessage(msg.id);
        expect(result).toBeDefined();
        if (result) {
            expect(result.id).toBe(msg.id);
        }

        // Get reactions separately
        const reactions = store.getReactions(msg.id);
        expect(reactions).toBeDefined();
        if (reactions) {
            expect(reactions.length).toBe(1);
            expect(reactions[0].reaction).toBe("agree");
            expect(reactions[0].agent_id).toBe(agent.id);
        }
    });

    it('msg_get with reply_to', async () => {
        // 对应 Python: L98-111
        /** msg_get preserves reply_to_msg_id when set at post time. */
        const thread = store.createThread("reply-to-test").thread;
        
        // Post parent message
        const parent = postMessage(thread.id, "agent-a", "parent message");
        
        // Post reply to parent
        const reply = postMessage(thread.id, "agent-b", "reply to parent", parent.id);

        // Verify reply has reply_to_msg_id set
        const result = store.getMessage(reply.id);
        expect(result).toBeDefined();
        if (result) {
            expect(result.reply_to_msg_id).toBe(parent.id);
        }

        // Verify parent has no reply_to_msg_id
        const parentResult = store.getMessage(parent.id);
        expect(parentResult).toBeDefined();
        if (parentResult) {
            expect(parentResult.reply_to_msg_id).toBeUndefined();
        }
    });
    it('msg_get projects human-only message for agent view', async () => {
        const thread = store.createThread("visibility-test").thread;
        const sync = store.issueSyncContext(thread.id, "system", "test");
        const msg = store.postMessage({
            threadId: thread.id,
            author: "system",
            content: "Human-only content",
            expectedLastSeq: sync.current_seq,
            replyToken: sync.reply_token,
            role: "system",
            metadata: { visibility: "human_only", ui_type: "admin_switch_confirmation_required" }
        });

        const result = store.getMessage(msg.id);
        
        expect(result).toBeDefined();
        if (result) {
            expect(result.content).toBe("Human-only content"); // Raw in store
            
            const projected = store.projectMessagesForAgent([result])[0];
            expect(projected.content).toBe("[human-only content hidden]");
        }
    });
});
