/**
 * test_msg_return_format.test.ts
 * 
 * 移植自 Python: tests/test_msg_return_format.py
 * 功能：消息返回格式验证 (json/blocks 双格式支持)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

describe('Message Return Format Tests', () => {
    let store: MemoryStore;

    beforeEach(() => {
        // 每测试使用独立内存数据库，模拟 Python :memory: 行为
        process.env.AGENTCHATBUS_DB = ':memory:';
        store = new MemoryStore();
        store.reset();
    });

    // 辅助函数 - 对应 Python _post_message() L13-24
    function postMessage(
        threadId: string,
        author: string,
        content: string,
        role: 'user' | 'assistant' = 'user',
        metadata?: any
    ) {
        const sync = store.issueSyncContext(threadId, author, "test");
        return store.postMessage({
            threadId,
            author,
            content,
            expectedLastSeq: sync.current_seq,
            replyToken: sync.reply_token,
            role,
            metadata
        });
    }

    it('msg_list default json compatible', async () => {
        // 对应 Python: L34-71
        const thread = store.createThread("fmt-json-default").thread;
        
        await postMessage(
            thread.id,
            "human",
            "hello",
            "user",
            {
                attachments: [
                    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }
                ]
            }
        );

        const out = store.listMessages({
            threadId: thread.id,
            afterSeq: 0,
            limit: 10,
            includeSystemPrompt: false,
            returnFormat: "json"
        });

        expect(Array.isArray(out)).toBe(true);
        expect(out.length).toBe(1);
        
        // 验证是 TextContent 类型
        const textBlock = out[0] as TextContent;
        expect(textBlock.type).toBe("text");
        
        // 解析 JSON payload
        const payload = JSON.parse(textBlock.text);
        expect(Array.isArray(payload)).toBe(true);
        expect(payload && payload[0].content).toBe("hello");
    });

    it('msg_list blocks can return imagecontent', async () => {
        // 对应 Python: L74-106
        const thread = store.createThread("fmt-blocks").thread;
        
        await postMessage(
            thread.id,
            "human",
            "look",
            "user",
            {
                attachments: [
                    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }
                ]
            }
        );

        const out = store.listMessages({
            threadId: thread.id,
            afterSeq: 0,
            limit: 10,
            includeSystemPrompt: false
        });

        expect(Array.isArray(out)).toBe(true);
        
        // 检查是否有 ImageContent
        const hasImage = out.some(x => (x as ImageContent).type === "image");
        expect(hasImage).toBe(true);
        
        // 检查是否有 TextContent 包含 "look"
        const hasText = out.some(x => 
            (x as TextContent).type === "text" && (x as TextContent).text.includes("look")
        );
        expect(hasText).toBe(true);
    });

    it('msg_list blocks strips data url prefix and inferrs mime', async () => {
        // 对应 Python: L109-142
        const thread = store.createThread("fmt-blocks-dataurl").thread;
        
        await postMessage(
            thread.id,
            "human",
            "dataurl",
            "user",
            {
                attachments: [
                    { type: "image", data: "data:image/png;base64,iVBORw0KGgo=" }
                ]
            }
        );

        const out = store.listMessages({
            threadId: thread.id,
            afterSeq: 0,
            limit: 10,
            includeSystemPrompt: false
        });

        const imgs = out.filter(x => (x as ImageContent).type === "image") as ImageContent[];
        expect(imgs.length).toBeGreaterThan(0);
        expect(imgs[0].mimeType).toBe("image/png");
        expect(imgs[0].data).toBe("iVBORw0KGgo="); // 应该移除 data URL 前缀
    });

    // ==================== UP-33: include_attachments parameter ====================

    it('msg_list blocks include_attachments false', async () => {
        // 对应 Python: L147-182
        /** UP-33: include_attachments=false should return text blocks only (no ImageContent). */
        const thread = store.createThread("no-attachments").thread;
        
        await postMessage(
            thread.id,
            "human",
            "text with image",
            "user",
            {
                attachments: [
                    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }
                ]
            }
        );

        const out = store.listMessages({
            threadId: thread.id,
            afterSeq: 0,
            limit: 10,
            includeSystemPrompt: false,
            includeAttachments: false
        });

        expect(Array.isArray(out)).toBe(true);
        // 所有 block 都应该是 TextContent
        const allText = out.every(x => (x as TextContent).type === "text");
        expect(allText).toBe(true);
        
        const hasTextWithContent = out.some(x => 
            (x as TextContent).type === "text" && (x as TextContent).text.includes("text with image")
        );
        expect(hasTextWithContent).toBe(true);
    });

    it('msg_list blocks include_attachments true default', async () => {
        // 对应 Python: L185-217
        /** UP-33: include_attachments=true (default) should still return ImageContent. */
        const thread = store.createThread("with-attachments-default").thread;
        
        await postMessage(
            thread.id,
            "human",
            "with images",
            "user",
            {
                attachments: [
                    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }
                ]
            }
        );

        const out = store.listMessages({
            threadId: thread.id,
            afterSeq: 0,
            limit: 10,
            includeSystemPrompt: false
        });

        const hasImage = out.some(x => (x as ImageContent).type === "image");
        expect(hasImage).toBe(true);
    });
});
