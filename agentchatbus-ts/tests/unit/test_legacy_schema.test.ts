/**
 * Unit tests for legacy schema required columns.
 * Ported from Python: tests/test_legacy_schema_required_columns.py
 *
 * These tests verify that the schema includes all columns needed by current CRUD operations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

describe('Legacy Schema Required Columns Tests (Ported from Python)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    process.env.AGENTCHATBUS_DB = ':memory:';
    store = new MemoryStore();
    store.reset();
  });

  describe('Agent columns', () => {
    it('agent has ide column', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'GPT-4' });
      expect(agent.ide).toBe('VS Code');
    });

    it('agent has model column', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'GPT-4' });
      expect(agent.model).toBe('GPT-4');
    });

    it('agent has display_name column', () => {
      const agent = store.registerAgent({ 
        ide: 'VS Code', 
        model: 'GPT-4',
        display_name: 'MyAssistant'
      });
      expect(agent.display_name).toBe('MyAssistant');
    });

    it('agent has name column', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'GPT-4' });
      expect(agent.name).toBeDefined();
    });

    it('agent has last_heartbeat column', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'GPT-4' });
      expect(agent.last_heartbeat).toBeDefined();
    });
  });

  describe('Message columns', () => {
    it('message has author_id column', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('message-cols');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      const message = store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'test',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'assistant'
      });

      expect(message.author_id).toBe(agent.id);
    });

    it('message has author_name column', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('author-name');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      const message = store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'test',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'assistant'
      });

      expect(message.author_name).toBeDefined();
    });

    it('message has seq column', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('seq-col');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      const message = store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'test',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'assistant'
      });

      expect(message.seq).toBe(1);
    });

    it('message has created_at column', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('created-at');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      const message = store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'test',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'assistant'
      });

      expect(message.created_at).toBeDefined();
    });

    it('message has role column', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('role-col');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      const message = store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'test',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'assistant'
      });

      expect(message.role).toBe('assistant');
    });
  });

  describe('Thread columns', () => {
    it('thread has system_prompt column', () => {
      const { thread } = store.createThread('system-prompt-test', 'Custom system prompt');
      expect(thread.system_prompt).toBe('Custom system prompt');
    });

    it('thread has created_at column', () => {
      const { thread } = store.createThread('created-at-test');
      expect(thread.created_at).toBeDefined();
    });

    it('thread has status column', () => {
      const { thread } = store.createThread('status-test');
      expect(thread.status).toBeDefined();
    });

    it('thread has topic column', () => {
      const { thread } = store.createThread('topic-test');
      expect(thread.topic).toBe('topic-test');
    });
  });

  describe('Thread settings columns', () => {
    it('thread settings has auto_administrator_enabled column', () => {
      const { thread } = store.createThread('auto-admin-col');
      const settings = store.getThreadSettings(thread.id);
      expect(settings?.auto_administrator_enabled).toBeDefined();
    });

    it('thread settings has timeout_seconds column', () => {
      const { thread } = store.createThread('timeout-col');
      const settings = store.updateThreadSettings(thread.id, {
        timeout_seconds: 60
      });
      expect(settings.timeout_seconds).toBe(60);
    });

    it('thread settings has switch_timeout_seconds column', () => {
      const { thread } = store.createThread('switch-timeout-col');
      const settings = store.updateThreadSettings(thread.id, {
        switch_timeout_seconds: 120
      });
      expect(settings.switch_timeout_seconds).toBe(120);
    });

    it('thread settings has last_activity_time column', () => {
      const { thread } = store.createThread('last-activity-col');
      const settings = store.getThreadSettings(thread.id);
      expect(settings?.last_activity_time).toBeDefined();
    });
  });

  describe('CRUD operations work with all required columns', () => {
    it('thread_create works with all columns', () => {
      const { thread } = store.createThread('legacy-required-columns');
      expect(thread.id).toBeDefined();
      expect(thread.topic).toBe('legacy-required-columns');
      expect(thread.status).toBe('discuss');
    });

    it('agent_register works with all columns', () => {
      const agent = store.registerAgent({ 
        ide: 'CLI', 
        model: 'X', 
        display_name: 'Alpha' 
      });
      expect(agent.id).toBeDefined();
      expect(agent.display_name).toBe('Alpha');
    });

    it('agent_list returns agents with display_name', () => {
      store.registerAgent({ ide: 'CLI', model: 'X', display_name: 'Alpha' });
      const agents = store.listAgents();
      expect(agents.length).toBeGreaterThan(0);
      expect(agents[0].display_name).toBeDefined();
    });

    it('msg_post works with all required columns', () => {
      const agent = store.registerAgent({ ide: 'CLI', model: 'X', display_name: 'Alpha' });
      const { thread } = store.createThread('msg-post-legacy');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      const message = store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'hello',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'assistant'
      });

      expect(message.id).toBeDefined();
      expect(message.seq).toBe(1);
      expect(message.author_id).toBe(agent.id);
    });
  });
});
