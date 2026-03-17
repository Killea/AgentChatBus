/**
 * Agent Attention Mechanisms Tests
 *
 * 移植自：Python tests/test_agent_attention_mechanisms.py
 * 说明：实现与 Python 版本等价的断言。
 * 测试 attention 字段（priority, handoff_target, stop_reason）在 feature flags
 * 启用和禁用时的行为。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';
import type { MessageRecord } from '../../src/core/types/models.js';

async function postMsgWithAttention(store: MemoryStore, threadId: string) {
  const sync = store.issueSyncContext(threadId);
  return store.postMessage({
    threadId,
    author: 'agent-test',
    content: 'Testing attention mechanisms',
    expectedLastSeq: sync.current_seq,
    replyToken: sync.reply_token,
    metadata: { handoff_target: 'agent-xyz', stop_reason: 'timeout' },
    priority: 'urgent'
  });
}

describe('Agent Attention Mechanisms (Ported from Python)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(':memory:');
  });

  describe('when all attention features are enabled (default)', () => {
    it('msg_get preserves attention fields', async () => {
      const { thread } = store.createThread('Topic');
      const msg = await postMsgWithAttention(store, thread.id);

      const fetched = store.getMessage(msg.id);
      expect(fetched).toBeDefined();
      expect(fetched?.priority).toBe('urgent');

      const meta = fetched?.metadata as any;
      expect(meta).toBeDefined();
      expect(meta.handoff_target).toBe('agent-xyz');
      expect(meta.stop_reason).toBe('timeout');
    });

    it('msg_post returns attention fields', async () => {
      const { thread } = store.createThread('Topic');
      const sync = store.issueSyncContext(thread.id);

      const result = store.postMessage({
        threadId: thread.id,
        author: 'agent-test',
        content: 'Testing post attention enabled',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        metadata: { handoff_target: 'agent-xyz', stop_reason: 'timeout' },
        priority: 'urgent'
      });

      expect(result.priority).toBe('urgent');
      const meta = result.metadata as any;
      expect(meta.handoff_target).toBe('agent-xyz');
      expect(meta.stop_reason).toBe('timeout');
    });

    it('formatMessageForAgent returns attention fields when enabled', () => {
      const msg: MessageRecord = {
        id: 'test-1',
        thread_id: 'thread-1',
        seq: 1,
        priority: 'urgent',
        author: 'agent-test',
        author_id: 'agent-test',
        author_name: 'Test Agent',
        role: 'user',
        content: 'Test message',
        metadata: { handoff_target: 'agent-xyz', stop_reason: 'timeout', other_field: 'value' },
        reactions: [],
        created_at: new Date().toISOString(),
        edited_at: null,
        edit_version: 0
      };

      const formatted = store.formatMessageForAgent(msg, {
        includePriority: true,
        enableHandoffTarget: true,
        enableStopReason: true
      });
      expect(formatted.priority).toBe('urgent');
      expect(formatted.handoff_target).toBe('agent-xyz');
      expect(formatted.stop_reason).toBe('timeout');
      // Other metadata should be preserved
      expect((formatted.metadata as any)?.other_field).toBe('value');
    });
  });

  describe('when all attention features are disabled', () => {
    it('formatMessageForAgent strips attention fields when disabled', () => {
      const msg: MessageRecord = {
        id: 'test-1',
        thread_id: 'thread-1',
        seq: 1,
        priority: 'urgent',
        author: 'agent-test',
        author_id: 'agent-test',
        author_name: 'Test Agent',
        role: 'user',
        content: 'Test message',
        metadata: { handoff_target: 'agent-xyz', stop_reason: 'timeout', other_field: 'value' },
        reactions: [],
        created_at: new Date().toISOString(),
        edited_at: null,
        edit_version: 0
      };

      // When all disabled
      const formatted = store.formatMessageForAgent(msg, {
        includePriority: false,
        enableHandoffTarget: false,
        enableStopReason: false
      });
      expect(formatted.priority).toBeUndefined();
      // handoff_target and stop_reason should be stripped from metadata
      expect(formatted.handoff_target).toBeUndefined();
      expect(formatted.stop_reason).toBeUndefined();
      // Other metadata should be preserved
      expect((formatted.metadata as any)?.other_field).toBe('value');
      // But handoff_target and stop_reason should be removed from metadata too
      expect((formatted.metadata as any)?.handoff_target).toBeUndefined();
      expect((formatted.metadata as any)?.stop_reason).toBeUndefined();
    });

    it('formatMessagesForAgent strips attention fields for all messages', () => {
      const msgs: MessageRecord[] = [
        {
          id: 'test-1',
          thread_id: 'thread-1',
          seq: 1,
          priority: 'urgent',
          author: 'agent-test',
          author_id: 'agent-test',
          author_name: 'Test Agent',
          role: 'user',
          content: 'Test message 1',
          metadata: { handoff_target: 'agent-xyz' },
          reactions: [],
          created_at: new Date().toISOString(),
          edited_at: null,
          edit_version: 0
        },
        {
          id: 'test-2',
          thread_id: 'thread-1',
          seq: 2,
          priority: 'normal',
          author: 'agent-test',
          author_id: 'agent-test',
          author_name: 'Test Agent',
          role: 'user',
          content: 'Test message 2',
          metadata: { stop_reason: 'timeout' },
          reactions: [],
          created_at: new Date().toISOString(),
          edited_at: null,
          edit_version: 0
        }
      ];

      const formatted = store.formatMessagesForAgent(msgs, {
        includePriority: false,
        enableHandoffTarget: false,
        enableStopReason: false
      });
      expect(formatted[0].priority).toBeUndefined();
      expect(formatted[0].handoff_target).toBeUndefined();
      expect(formatted[1].priority).toBeUndefined();
      expect(formatted[1].stop_reason).toBeUndefined();
    });
  });

  describe('individual feature flags', () => {
    it('only strips priority when includePriority is false', () => {
      const msg: MessageRecord = {
        id: 'test-1',
        thread_id: 'thread-1',
        seq: 1,
        priority: 'urgent',
        author: 'agent-test',
        author_id: 'agent-test',
        author_name: 'Test Agent',
        role: 'user',
        content: 'Test message',
        metadata: { handoff_target: 'agent-xyz', stop_reason: 'timeout' },
        reactions: [],
        created_at: new Date().toISOString(),
        edited_at: null,
        edit_version: 0
      };

      // With priority disabled but others enabled
      const formatted = store.formatMessageForAgent(msg, {
        includePriority: false,
        enableHandoffTarget: true,
        enableStopReason: true
      });
      expect(formatted.priority).toBeUndefined();
      // But handoff_target and stop_reason should still be present
      expect(formatted.handoff_target).toBe('agent-xyz');
      expect(formatted.stop_reason).toBe('timeout');
    });

    it('only strips handoff_target when enableHandoffTarget is false', () => {
      const msg: MessageRecord = {
        id: 'test-1',
        thread_id: 'thread-1',
        seq: 1,
        priority: 'urgent',
        author: 'agent-test',
        author_id: 'agent-test',
        author_name: 'Test Agent',
        role: 'user',
        content: 'Test message',
        metadata: { handoff_target: 'agent-xyz', stop_reason: 'timeout' },
        reactions: [],
        created_at: new Date().toISOString(),
        edited_at: null,
        edit_version: 0
      };

      const formatted = store.formatMessageForAgent(msg, {
        includePriority: true,
        enableHandoffTarget: false,
        enableStopReason: true
      });
      expect(formatted.priority).toBe('urgent');
      expect(formatted.handoff_target).toBeUndefined();
      expect(formatted.stop_reason).toBe('timeout');
      expect((formatted.metadata as any)?.handoff_target).toBeUndefined();
      expect((formatted.metadata as any)?.stop_reason).toBe('timeout');
    });

    it('only strips stop_reason when enableStopReason is false', () => {
      const msg: MessageRecord = {
        id: 'test-1',
        thread_id: 'thread-1',
        seq: 1,
        priority: 'urgent',
        author: 'agent-test',
        author_id: 'agent-test',
        author_name: 'Test Agent',
        role: 'user',
        content: 'Test message',
        metadata: { handoff_target: 'agent-xyz', stop_reason: 'timeout' },
        reactions: [],
        created_at: new Date().toISOString(),
        edited_at: null,
        edit_version: 0
      };

      const formatted = store.formatMessageForAgent(msg, {
        includePriority: true,
        enableHandoffTarget: true,
        enableStopReason: false
      });
      expect(formatted.priority).toBe('urgent');
      expect(formatted.handoff_target).toBe('agent-xyz');
      expect(formatted.stop_reason).toBeUndefined();
      expect((formatted.metadata as any)?.handoff_target).toBe('agent-xyz');
      expect((formatted.metadata as any)?.stop_reason).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('handles null metadata correctly', () => {
      const msg: MessageRecord = {
        id: 'test-1',
        thread_id: 'thread-1',
        seq: 1,
        priority: 'normal',
        author: 'agent-test',
        author_id: 'agent-test',
        author_name: 'Test Agent',
        role: 'user',
        content: 'Test message',
        metadata: null,
        reactions: [],
        created_at: new Date().toISOString(),
        edited_at: null,
        edit_version: 0
      };

      const formatted = store.formatMessageForAgent(msg, {
        includePriority: true,
        enableHandoffTarget: true,
        enableStopReason: true
      });
      expect(formatted.metadata).toBeNull();
      expect(formatted.handoff_target).toBeUndefined();
      expect(formatted.stop_reason).toBeUndefined();
    });

    it('handles empty metadata correctly', () => {
      const msg: MessageRecord = {
        id: 'test-1',
        thread_id: 'thread-1',
        seq: 1,
        priority: 'normal',
        author: 'agent-test',
        author_id: 'agent-test',
        author_name: 'Test Agent',
        role: 'user',
        content: 'Test message',
        metadata: {},
        reactions: [],
        created_at: new Date().toISOString(),
        edited_at: null,
        edit_version: 0
      };

      const formatted = store.formatMessageForAgent(msg, {
        includePriority: true,
        enableHandoffTarget: true,
        enableStopReason: true
      });
      // Empty metadata should become null after filtering
      expect(formatted.metadata).toBeNull();
      expect(formatted.handoff_target).toBeUndefined();
      expect(formatted.stop_reason).toBeUndefined();
    });

    it('preserves other metadata fields', () => {
      const msg: MessageRecord = {
        id: 'test-1',
        thread_id: 'thread-1',
        seq: 1,
        priority: 'urgent',
        author: 'agent-test',
        author_id: 'agent-test',
        author_name: 'Test Agent',
        role: 'user',
        content: 'Test message',
        metadata: {
          handoff_target: 'agent-xyz',
          stop_reason: 'timeout',
          custom_field: 'custom_value',
          attachments: [{ type: 'image', url: 'test.jpg' }],
          reply_to_msg_id: 'msg-123'
        },
        reactions: [],
        created_at: new Date().toISOString(),
        edited_at: null,
        edit_version: 0
      };

      // Test with all flags disabled
      const formatted = store.formatMessageForAgent(msg, {
        includePriority: false,
        enableHandoffTarget: false,
        enableStopReason: false
      });
      expect((formatted.metadata as any)?.custom_field).toBe('custom_value');
      expect((formatted.metadata as any)?.attachments).toEqual([{ type: 'image', url: 'test.jpg' }]);
      expect((formatted.metadata as any)?.reply_to_msg_id).toBe('msg-123');
    });
  });
});
