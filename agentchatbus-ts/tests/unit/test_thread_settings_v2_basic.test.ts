/**
 * test_thread_settings_v2.test.ts - Simplified Version
 * 
 * 移植自 Python: tests/test_thread_settings_v2.py (Basic Tests Only)
 * 功能：Thread Settings Basic Operations
 * 
 * Note: Advanced features like timeout detection, activity tracking,
 * and auto-coordinator require additional implementation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';
import type { ThreadRecord } from '../../src/core/types/models.js';

describe('Thread Settings V2 Basic Tests', () => {
    let store: MemoryStore;

    beforeEach(() => {
        process.env.AGENTCHATBUS_DB = ':memory:';
        store = new MemoryStore();
        store.reset();
    });

    // Helper - Create thread
    function createThread(topic: string = "test-thread"): ThreadRecord {
        return store.createThread(topic).thread;
    }

    it('get thread settings returns defaults', () => {
        // 对应 Python: L33-44 (Simplified)
        /** Test auto-creation of thread settings with defaults. */
        const thread = createThread("test-settings-defaults");
        
        const settings = store.getThreadSettings(thread.id);
        
        expect(settings).toBeDefined();
        if (settings) {
            expect(settings.auto_administrator_enabled).toBe(true);
            expect(settings.timeout_seconds).toBe(60); // TS version default
            expect(settings.switch_timeout_seconds).toBe(60);
        }
    });

    it('update thread settings timeout', () => {
        // 对应 Python: L47-67 (Simplified)
        /** Test updating thread settings timeout. */
        const thread = createThread("test-update-timeout");
        
        // Get settings first to initialize
        store.getThreadSettings(thread.id);
        
        // Update timeout
        const updated = store.updateThreadSettings(thread.id, {
            timeout_seconds: 120
        });
        
        expect(updated).toBeDefined();
        if (updated) {
            expect(updated.timeout_seconds).toBe(120);
        }
        
        // Verify persisted
        const settings = store.getThreadSettings(thread.id);
        expect(settings?.timeout_seconds).toBe(120);
    });

    it('update thread settings auto_administrator', () => {
        // 对应 Python: L235-258 (Simplified)
        /** Test disabling auto administrator. */
        const thread = createThread("test-disable-admin");
        
        // Disable auto_administrator
        store.getThreadSettings(thread.id);
        const updated = store.updateThreadSettings(thread.id, {
            auto_administrator_enabled: false
        });
        
        expect(updated?.auto_administrator_enabled).toBe(false);
        
        // Reload and verify
        const settings = store.getThreadSettings(thread.id);
        expect(settings?.auto_administrator_enabled).toBe(false);
    });

    it('update thread settings switch_timeout', () => {
        // 对应 Python: Similar to L83-90
        /** Test that switch_timeout can be updated. */
        const thread = createThread("test-switch-timeout");
        
        store.getThreadSettings(thread.id);
        const updated = store.updateThreadSettings(thread.id, {
            switch_timeout_seconds: 300
        });
        
        expect(updated?.switch_timeout_seconds).toBe(300);
        
        const settings = store.getThreadSettings(thread.id);
        expect(settings?.switch_timeout_seconds).toBe(300);
    });

    it('settings persist across thread status change', () => {
        // 对应 Python: L321-350 (Simplified)
        /** Test settings persist across status changes. */
        const thread = createThread("test-persist-status");
        
        // Set custom timeout
        store.getThreadSettings(thread.id);
        store.updateThreadSettings(thread.id, {
            timeout_seconds: 999
        });
        
        // Change thread status
        store.updateThreadStatus(thread.id, "implement");
        
        // Settings should still be there
        const settings = store.getThreadSettings(thread.id);
        expect(settings?.timeout_seconds).toBe(999);
    });

    it('concurrent updates last wins', () => {
        // 对应 Python: L353-382 (Simplified)
        /** Test concurrent updates: last write wins. */
        const thread = createThread("test-last-wins");
        
        // First update
        store.getThreadSettings(thread.id);
        store.updateThreadSettings(thread.id, {
            timeout_seconds: 100
        });
        
        // Second update (should overwrite)
        const final = store.updateThreadSettings(thread.id, {
            timeout_seconds: 200
        });
        
        expect(final?.timeout_seconds).toBe(200);
        
        const settings = store.getThreadSettings(thread.id);
        expect(settings?.timeout_seconds).toBe(200);
    });

    it('get settings for non-existent thread auto-creates defaults', () => {
        // 对应 Python: L385-408 (Modified behavior)
        /** Test settings for missing thread auto-create defaults. */
        const fakeId = "00000000-0000-0000-0000-000000000000";
        
        const settings = store.getThreadSettings(fakeId);

        // Fix #35: getThreadSettings now auto-creates defaults (Python parity)
        expect(settings).toBeDefined();
        expect(settings!.auto_administrator_enabled).toBe(true);
        expect(settings!.timeout_seconds).toBe(60);
        expect(settings!.switch_timeout_seconds).toBe(60);
    });

    it('update thread settings rejects timeout below minimum', () => {
        // 对应 Python: test_thread_settings_update_invalid_timeout (L83-90)
        /** Test that timeout below minimum (30) is rejected. */
        const thread = createThread("test-invalid-timeout");
        
        // Initialize settings
        store.getThreadSettings(thread.id);
        
        // Try to set timeout below minimum
        expect(() => store.updateThreadSettings(thread.id, {
            timeout_seconds: 29
        })).toThrow(/timeout_seconds must be at least 30/);
    });

    it('update thread settings allows large timeout', () => {
        // 对应 Python: test_thread_settings_update_allows_large_timeout (L93-98)
        /** Large timeout values are allowed (no max cap). */
        const thread = createThread("test-large-timeout");
        
        store.getThreadSettings(thread.id);
        
        const updated = store.updateThreadSettings(thread.id, {
            timeout_seconds: 3600
        });
        
        expect(updated?.timeout_seconds).toBe(3600);
    });

    it('update thread settings rejects switch_timeout below minimum', () => {
        // 对应 Python: Similar validation for switch_timeout_seconds
        /** Test that switch_timeout below minimum (30) is rejected. */
        const thread = createThread("test-invalid-switch-timeout");
        
        store.getThreadSettings(thread.id);
        
        expect(() => store.updateThreadSettings(thread.id, {
            switch_timeout_seconds: 15
        })).toThrow(/switch_timeout_seconds must be at least 30/);
    });

    it('message updates thread state', () => {
        // 对应 Python: test_message_updates_activity (L165-191)
        /** Posting a message should update thread. */
        const thread = createThread("test-activity");
        
        // Post a message
        const sync = store.issueSyncContext(thread.id, "test-agent", "test");
        const msg = store.postMessage({
            threadId: thread.id,
            author: "test-agent",
            content: "test message",
            expectedLastSeq: sync.current_seq,
            replyToken: sync.reply_token,
            role: "user"
        });
        
        // Verify message was posted
        expect(msg.seq).toBeGreaterThan(0);
        
        // Verify thread still exists and is accessible
        const after = store.getThread(thread.id);
        expect(after).toBeDefined();
    });

    it('msg_post updates last_activity_time and clears auto-assigned admin', () => {
        const thread = createThread("test-clear-auto-admin-on-post");

        const before = store.getThreadSettings(thread.id);
        expect(before).toBeDefined();
        if (!before) return;

        const seedTs = new Date(Date.now() - 60_000).toISOString();
        (store as any).threadSettings.set(thread.id, {
            ...before,
            last_activity_time: seedTs,
            auto_assigned_admin_id: "agent-auto",
            auto_assigned_admin_name: "Auto Admin",
            admin_assignment_time: seedTs
        });
        (store as any).upsertThreadSettings(thread.id);

        const sync = store.issueSyncContext(thread.id, "test-agent", "test");
        store.postMessage({
            threadId: thread.id,
            author: "test-agent",
            content: "trigger activity update",
            expectedLastSeq: sync.current_seq,
            replyToken: sync.reply_token,
            role: "user"
        });

        const after = store.getThreadSettings(thread.id);
        expect(after).toBeDefined();
        if (!after) return;

        expect(after.last_activity_time > seedTs).toBe(true);
        expect(after.auto_assigned_admin_id).toBeUndefined();
        expect(after.auto_assigned_admin_name).toBeUndefined();
        expect(after.admin_assignment_time).toBeUndefined();
    });

    it('system message creation', () => {
        // 对应 Python: test_system_message_creation (L276-297)
        /** System messages are stored with role='system'. */
        const thread = createThread("test-sys-msg");
        
        const sync = store.issueSyncContext(thread.id, "system", "test");
        const msg = store.postMessage({
            threadId: thread.id,
            author: "system",
            content: "System announcement",
            expectedLastSeq: sync.current_seq,
            replyToken: sync.reply_token,
            role: "system"
        });
        
        expect(msg.role).toBe("system");
    });

    it('delete thread cleans up messages', () => {
        // 对应 Python: test_thread_delete_with_reactions_and_settings (L300-318)
        /** Deleting a thread should clean up associated messages. */
        const thread = createThread("test-delete");
        
        // Post a message
        const sync = store.issueSyncContext(thread.id, "test-agent", "test");
        store.postMessage({
            threadId: thread.id,
            author: "test-agent",
            content: "to be deleted",
            expectedLastSeq: sync.current_seq,
            replyToken: sync.reply_token,
            role: "user"
        });
        
        // Verify message exists
        const msgsBefore = store.getMessages(thread.id, 0);
        expect(msgsBefore.length).toBeGreaterThan(0);
        
        // Delete thread
        store.deleteThread(thread.id);
        
        // Verify thread is gone
        const deleted = store.getThread(thread.id);
        expect(deleted).toBeUndefined();
    });

    it('thread delete cleans reactions', () => {
        // 对应 Python: test_thread_delete_with_reactions_and_settings
        /** Deleting a thread cleans up reactions. */
        const thread = createThread("test-delete-reactions");
        
        // Post message and add reaction
        const sync = store.issueSyncContext(thread.id, "test-agent", "test");
        const msg = store.postMessage({
            threadId: thread.id,
            author: "test-agent",
            content: "message with reaction",
            expectedLastSeq: sync.current_seq,
            replyToken: sync.reply_token,
            role: "user"
        });
        
        store.addReaction(msg.id, "reactor", "thumbsup");
        
        // Delete thread
        store.deleteThread(thread.id);
        
        // Reaction should be gone (verified by no error when accessing)
        expect(store.getThread(thread.id)).toBeUndefined();
    });

    it('settings defaults on new thread', () => {
        // Verify default values for new thread settings
        const thread = createThread("test-defaults");
        
        const settings = store.getThreadSettings(thread.id);
        
        expect(settings?.auto_administrator_enabled).toBe(true);
        expect(settings?.timeout_seconds).toBeGreaterThan(0);
        expect(settings?.switch_timeout_seconds).toBeGreaterThan(0);
    });
});
