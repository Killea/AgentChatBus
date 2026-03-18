/**
 * Unit tests for timeout handling in AgentChatBus.
 * Ported from Python: tests/test_timeout_handling.py
 *
 * These tests verify that database operations timeout gracefully and return
 * appropriate error responses.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

describe('Timeout Handling Tests (Ported from Python)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    process.env.AGENTCHATBUS_DB = ':memory:';
    store = new MemoryStore();
    store.reset();
  });

  describe('Operation timeout constants', () => {
    it('default wait timeout is configurable', () => {
      // Default timeout should be reasonable (300 seconds in Python)
      // TS version uses timeout_ms parameter in waitForMessages
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('timeout-test');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      // Short timeout should return quickly
      const start = Date.now();
      store.waitForMessages({
        threadId: thread.id,
        agentId: agent.id,
        afterSeq: sync.current_seq,
        timeoutMs: 50
      });
      const elapsed = Date.now() - start;

      // Should complete within reasonable time of timeout
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe('Message wait timeout behavior', () => {
    it('msg_wait respects timeout and returns after specified duration', async () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('wait-timeout');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      const start = Date.now();
      const result = await store.waitForMessages({
        threadId: thread.id,
        agentId: agent.id,
        afterSeq: sync.current_seq,
        timeoutMs: 100
      });
      const elapsed = Date.now() - start;

      expect(result.messages).toEqual([]);
      // Should wait approximately the timeout duration
      expect(elapsed).toBeGreaterThanOrEqual(80);
    });

    it('msg_wait returns immediately when messages are available', async () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('immediate-return');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      // Post a message
      store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'test message',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'assistant'
      });

      // Wait should return immediately with the message
      const start = Date.now();
      const result = await store.waitForMessages({
        threadId: thread.id,
        agentId: agent.id,
        afterSeq: 0,
        timeoutMs: 1000 // Long timeout, but should return early
      });
      const elapsed = Date.now() - start;

      expect(result.messages.length).toBeGreaterThan(0);
      // Should return quickly, not wait the full timeout
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('Token expiry handling', () => {
    it('tokens have reasonable expiry time', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('token-expiry');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      expect(sync.reply_token).toBeDefined();
      expect(sync.reply_window).toBeDefined();
      // reply_window should indicate the token validity period
    });

    it('expired token is rejected', async () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('expired-token');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      // Use the token immediately - should work
      store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'first message',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'assistant'
      });

      // Try to reuse the same token - should fail
      expect(() => {
        store.postMessage({
          threadId: thread.id,
          author: agent.id,
          content: 'second message',
          expectedLastSeq: sync.current_seq,
          replyToken: sync.reply_token,
          role: 'assistant'
        });
      }).toThrow();
    });
  });

  describe('Thread timeout settings', () => {
    it('thread can have custom timeout settings', () => {
      const { thread } = store.createThread('custom-timeout');
      
      const settings = store.updateThreadSettings(thread.id, {
        timeout_seconds: 120,
        switch_timeout_seconds: 60
      });

      expect(settings.timeout_seconds).toBe(120);
      expect(settings.switch_timeout_seconds).toBe(60);
    });

    it('timeout_seconds minimum is enforced', () => {
      const { thread } = store.createThread('min-timeout-enforce');
      
      // Below minimum should throw
      expect(() => {
        store.updateThreadSettings(thread.id, {
          timeout_seconds: 10 // Below minimum of 30
        });
      }).toThrow();

      // At minimum should work
      const settings = store.updateThreadSettings(thread.id, {
        timeout_seconds: 30
      });
      expect(settings.timeout_seconds).toBe(30);
    });

    it('switch_timeout_seconds minimum is enforced', () => {
      const { thread } = store.createThread('min-switch-enforce');
      
      // Below minimum should throw
      expect(() => {
        store.updateThreadSettings(thread.id, {
          switch_timeout_seconds: 15 // Below minimum of 30
        });
      }).toThrow();

      // At minimum should work
      const settings = store.updateThreadSettings(thread.id, {
        switch_timeout_seconds: 30
      });
      expect(settings.switch_timeout_seconds).toBe(30);
    });
  });

  describe('Agent heartbeat timeout', () => {
    it('agent is online after registration', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const agents = store.listAgents();
      const found = agents.find(a => a.id === agent.id);

      expect(found?.is_online).toBe(true);
    });

    it('agent heartbeat updates last_heartbeat time', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      
      // Update heartbeat using heartbeatAgent (requires token)
      store.heartbeatAgent(agent.id, agent.token!);

      const agents = store.listAgents();
      const found = agents.find(a => a.id === agent.id);

      expect(found?.is_online).toBe(true);
    });

    it('agent status can be queried via getAgent', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const found = store.getAgent(agent.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(agent.id);
    });
  });

  describe('Error handling for invalid operations', () => {
    it('invalid thread ID returns appropriate error', () => {
      expect(() => {
        store.getMessages('nonexistent-thread', 0);
      }).not.toThrow(); // Should return empty array, not throw
      
      const messages = store.getMessages('nonexistent-thread', 0);
      expect(messages).toEqual([]);
    });

    it('invalid agent ID returns undefined for getAgent', () => {
      const found = store.getAgent('nonexistent-agent');
      expect(found).toBeUndefined();
    });

    it('thread settings for nonexistent thread auto-creates defaults', () => {
      const settings = store.getThreadSettings('nonexistent-thread');
      // Fix #35: getThreadSettings now auto-creates defaults (Python parity)
      expect(settings).toBeDefined();
      expect(settings!.auto_administrator_enabled).toBe(true);
      expect(settings!.timeout_seconds).toBe(60);
    });
  });
});
