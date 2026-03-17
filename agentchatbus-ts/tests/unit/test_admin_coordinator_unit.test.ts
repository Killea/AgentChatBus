/**
 * Unit tests for admin coordinator functionality.
 * Ported from Python: tests/test_admin_coordinator_loop.py
 * 
 * Covers:
 * - Admin assignment to agents
 * - Creator admin assignment
 * - Thread settings for auto-administrator
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

describe('Admin Coordinator Unit Tests (Ported from Python)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    process.env.AGENTCHATBUS_DB = ':memory:';
    store = new MemoryStore();
    store.reset();
  });

  describe('Thread settings for auto-administrator', () => {
    it('creates thread with auto-administrator disabled by default', () => {
      const { thread } = store.createThread('default-admin-test');
      const settings = store.getThreadSettings(thread.id);

      expect(settings).toBeDefined();
      expect(settings?.auto_administrator_enabled).toBe(true); // Default is enabled
    });

    it('enables auto-administrator via updateThreadSettings', () => {
      const { thread } = store.createThread('enable-auto-admin');
      
      const settings = store.updateThreadSettings(thread.id, {
        auto_administrator_enabled: true,
        timeout_seconds: 60,
        switch_timeout_seconds: 120
      });

      expect(settings.auto_administrator_enabled).toBe(true);
      expect(settings.timeout_seconds).toBe(60);
      expect(settings.switch_timeout_seconds).toBe(120);
    });

    it('disables auto-administrator via updateThreadSettings', () => {
      const { thread } = store.createThread('disable-auto-admin');
      
      const settings = store.updateThreadSettings(thread.id, {
        auto_administrator_enabled: false
      });

      expect(settings.auto_administrator_enabled).toBe(false);
    });

    it('validates minimum timeout_seconds (>= 30)', () => {
      const { thread } = store.createThread('min-timeout');
      
      // Should accept valid timeout
      const valid = store.updateThreadSettings(thread.id, {
        timeout_seconds: 30
      });
      expect(valid.timeout_seconds).toBe(30);

      // Should reject invalid timeout (< 30)
      expect(() => {
        store.updateThreadSettings(thread.id, {
          timeout_seconds: 15
        });
      }).toThrow();
    });

    it('validates minimum switch_timeout_seconds (>= 30)', () => {
      const { thread } = store.createThread('min-switch-timeout');
      
      // Should accept valid switch timeout
      const valid = store.updateThreadSettings(thread.id, {
        switch_timeout_seconds: 30
      });
      expect(valid.switch_timeout_seconds).toBe(30);

      // Should reject invalid switch timeout (< 30)
      expect(() => {
        store.updateThreadSettings(thread.id, {
          switch_timeout_seconds: 10
        });
      }).toThrow();
    });
  });

  describe('assignAdmin functionality', () => {
    it('assigns admin to thread when auto-admin enabled', () => {
      const { thread } = store.createThread('assign-admin-test');
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });

      // Enable auto-admin
      store.updateThreadSettings(thread.id, {
        auto_administrator_enabled: true,
        timeout_seconds: 60
      });

      // Assign admin
      const settings = store.assignAdmin(thread.id, agent.id, 'TestAdmin');

      expect(settings).toBeDefined();
      expect(settings?.auto_assigned_admin_id).toBe(agent.id);
      expect(settings?.auto_assigned_admin_name).toBe('TestAdmin');
      expect(settings?.admin_assignment_time).toBeDefined();
    });

    it('assignAdmin returns undefined when auto-admin disabled', () => {
      const { thread } = store.createThread('assign-admin-disabled');
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });

      // Disable auto-admin
      store.updateThreadSettings(thread.id, {
        auto_administrator_enabled: false
      });

      // Try to assign admin - should return undefined
      const settings = store.assignAdmin(thread.id, agent.id, 'TestAdmin');

      expect(settings).toBeUndefined();
    });

    it('assignAdmin returns undefined for nonexistent thread', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });

      const settings = store.assignAdmin('nonexistent-thread', agent.id, 'TestAdmin');

      expect(settings).toBeUndefined();
    });

    it('can reassign admin to different agent', () => {
      const { thread } = store.createThread('reassign-admin');
      const agent1 = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const agent2 = store.registerAgent({ ide: 'Cursor', model: 'test' });

      store.updateThreadSettings(thread.id, {
        auto_administrator_enabled: true
      });

      // First assignment
      store.assignAdmin(thread.id, agent1.id, 'FirstAdmin');
      
      // Reassign to second agent
      const settings = store.assignAdmin(thread.id, agent2.id, 'SecondAdmin');

      expect(settings?.auto_assigned_admin_id).toBe(agent2.id);
      expect(settings?.auto_assigned_admin_name).toBe('SecondAdmin');
    });
  });

  describe('setCreatorAdmin functionality', () => {
    it('sets creator as admin when auto-admin enabled', () => {
      const { thread } = store.createThread('creator-admin-test');
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });

      // Enable auto-admin
      store.updateThreadSettings(thread.id, {
        auto_administrator_enabled: true
      });

      // Set creator admin
      const settings = store.setCreatorAdmin(thread.id, agent.id, 'CreatorAgent');

      expect(settings).toBeDefined();
      expect(settings?.creator_admin_id).toBe(agent.id);
      expect(settings?.creator_admin_name).toBe('CreatorAgent');
      expect(settings?.creator_assignment_time).toBeDefined();
    });

    it('setCreatorAdmin returns undefined when auto-admin disabled', () => {
      const { thread } = store.createThread('creator-admin-disabled');
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });

      // Disable auto-admin
      store.updateThreadSettings(thread.id, {
        auto_administrator_enabled: false
      });

      // Try to set creator admin - should return undefined
      const settings = store.setCreatorAdmin(thread.id, agent.id, 'CreatorAgent');

      expect(settings).toBeUndefined();
    });

    it('setCreatorAdmin returns undefined for nonexistent thread', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });

      const settings = store.setCreatorAdmin('nonexistent-thread', agent.id, 'CreatorAgent');

      expect(settings).toBeUndefined();
    });
  });

  describe('Admin state persistence', () => {
    it('admin assignment persists in thread settings', () => {
      const { thread } = store.createThread('persist-admin');
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });

      store.updateThreadSettings(thread.id, {
        auto_administrator_enabled: true
      });

      store.assignAdmin(thread.id, agent.id, 'PersistentAdmin');

      // Retrieve settings again
      const settings = store.getThreadSettings(thread.id);

      expect(settings?.auto_assigned_admin_id).toBe(agent.id);
      expect(settings?.auto_assigned_admin_name).toBe('PersistentAdmin');
    });

    it('creator admin persists in thread settings', () => {
      const { thread } = store.createThread('persist-creator');
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });

      store.updateThreadSettings(thread.id, {
        auto_administrator_enabled: true
      });

      store.setCreatorAdmin(thread.id, agent.id, 'PersistentCreator');

      // Retrieve settings again
      const settings = store.getThreadSettings(thread.id);

      expect(settings?.creator_admin_id).toBe(agent.id);
      expect(settings?.creator_admin_name).toBe('PersistentCreator');
    });

    it('both admin and creator can be set on same thread', () => {
      const { thread } = store.createThread('both-admins');
      const agent1 = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const agent2 = store.registerAgent({ ide: 'Cursor', model: 'test' });

      store.updateThreadSettings(thread.id, {
        auto_administrator_enabled: true
      });

      store.setCreatorAdmin(thread.id, agent1.id, 'Creator');
      store.assignAdmin(thread.id, agent2.id, 'AssignedAdmin');

      const settings = store.getThreadSettings(thread.id);

      expect(settings?.creator_admin_id).toBe(agent1.id);
      expect(settings?.auto_assigned_admin_id).toBe(agent2.id);
    });
  });

  describe('Last activity time tracking', () => {
    it('thread settings includes last_activity_time', () => {
      const { thread } = store.createThread('activity-time');
      const settings = store.getThreadSettings(thread.id);

      expect(settings?.last_activity_time).toBeDefined();
    });

    it('last_activity_time updates on message post', async () => {
      const { thread } = store.createThread('activity-update');
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      const initialSettings = store.getThreadSettings(thread.id);
      const initialTime = initialSettings?.last_activity_time;

      // Small delay to ensure time difference
      await new Promise(r => setTimeout(r, 10));

      store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'test message',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'assistant'
      });

      const updatedSettings = store.getThreadSettings(thread.id);
      
      // last_activity_time should be updated
      expect(updatedSettings?.last_activity_time).toBeDefined();
    });
  });
});
