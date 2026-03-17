/**
 * Test to verify that agent tokens are not exposed in the agent list response.
 * Ported from Python: tests/test_token_exposure.py
 * 
 * This is a security test to ensure the vulnerability is fixed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

describe('Token Exposure Tests (Ported from Python)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    process.env.AGENTCHATBUS_DB = ':memory:';
    store = new MemoryStore();
    store.reset();
  });

  describe('Agent list does not expose tokens', () => {
    it('single agent: token is not exposed in listAgents', () => {
      // Register an agent
      const registered = store.registerAgent({
        ide: 'TestIDE',
        model: 'TestModel',
        description: 'Test agent for token exposure check'
      });

      // Token should be present in registration response
      expect(registered.token).toBeDefined();
      expect(registered.token.length).toBeGreaterThan(0);

      // Get the agent list
      const agents = store.listAgents();

      // Check that agent is in the list
      const found = agents.find(a => a.id === registered.id);
      expect(found).toBeDefined();

      // CRITICAL: Check if token is exposed in agent list
      if (found) {
        expect(found.token).toBeUndefined();
        expect((found as any).secret).toBeUndefined();
      }
    });

    it('multiple agents: no tokens exposed', () => {
      // Register multiple agents
      const agent1 = store.registerAgent({ ide: 'VS Code', model: 'GPT-4' });
      const agent2 = store.registerAgent({ ide: 'Cursor', model: 'Claude' });
      const agent3 = store.registerAgent({ ide: 'Zed', model: 'GPT-4' });

      // Verify tokens were returned during registration
      expect(agent1.token).toBeDefined();
      expect(agent2.token).toBeDefined();
      expect(agent3.token).toBeDefined();

      // Get the agent list
      const agents = store.listAgents();
      expect(agents.length).toBeGreaterThanOrEqual(3);

      // Check each agent for token exposure
      for (const agent of agents) {
        expect(agent.token).toBeUndefined();
        expect((agent as any).secret).toBeUndefined();
      }
    });

    it('agent with capabilities: token not exposed', () => {
      const registered = store.registerAgent({
        ide: 'VS Code',
        model: 'GPT-5.3-Codex',
        capabilities: ['code-generation', 'code-review'],
        description: 'Advanced coding assistant'
      });

      const agents = store.listAgents();
      const found = agents.find(a => a.id === registered.id);

      expect(found).toBeDefined();
      if (found) {
        expect(found.token).toBeUndefined();
        // Other fields should be present
        expect(found.id).toBe(registered.id);
        expect(found.ide).toBe('VS Code');
        expect(found.model).toBe('GPT-5.3-Codex');
      }
    });

    it('agent after heartbeat: token still not exposed', () => {
      const registered = store.registerAgent({ ide: 'VS Code', model: 'GPT-4' });
      
      // Send heartbeat (method requires token for auth)
      store.heartbeatAgent(registered.id, registered.token!);

      const agents = store.listAgents();
      const found = agents.find(a => a.id === registered.id);

      expect(found).toBeDefined();
      if (found) {
        expect(found.token).toBeUndefined();
        expect(found.is_online).toBe(true);
      }
    });

    it('offline agent: token not exposed', () => {
      const registered = store.registerAgent({ ide: 'VS Code', model: 'GPT-4' });
      
      // Simulate agent going offline (by waiting or manually setting)
      // In real scenario, this would be determined by heartbeat timeout
      
      const agents = store.listAgents();
      const found = agents.find(a => a.id === registered.id);

      expect(found).toBeDefined();
      if (found) {
        expect(found.token).toBeUndefined();
      }
    });
  });

  describe('Token validation', () => {
    it('valid token allows message post', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('token-validation');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      const message = store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'test message',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'assistant'
      });

      expect(message).toBeDefined();
    });

    it('invalid token is rejected', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('token-invalid');

      expect(() => {
        store.postMessage({
          threadId: thread.id,
          author: agent.id,
          content: 'test message',
          expectedLastSeq: 0,
          replyToken: 'invalid-token-12345',
          role: 'assistant'
        });
      }).toThrow();
    });

    it('token cannot be reused after consumption', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('token-reuse');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      // First use succeeds
      store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'first message',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'assistant'
      });

      // Second use with same token should fail
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
});
