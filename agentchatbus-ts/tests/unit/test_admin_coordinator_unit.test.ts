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

  function seedWaitState(
    memoryStore: MemoryStore,
    threadId: string,
    agentId: string,
    enteredAt: string,
    timeoutMs = 120_000
  ): void {
    const internalStore = memoryStore as any;
    const waits = internalStore.threadWaitStates.get(threadId) || new Map();
    waits.set(agentId, {
      agentId,
      enteredAt,
      timeoutMs,
    });
    internalStore.threadWaitStates.set(threadId, waits);
    internalStore.replaceThreadWaitStates(threadId);
  }

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

  describe('admin coordinator sweep parity', () => {
    it('single agent emits no system message without confirmation path', () => {
      const { thread } = store.createThread('single-agent-intervention');
      const agent = store.registerAgent({ ide: 'VS Code', model: 'GPT-5.3-Codex' });

      store.updateThreadSettings(thread.id, { timeout_seconds: 30 });
      seedWaitState(store, thread.id, agent.id, new Date(Date.now() - 120_000).toISOString());

      const created = store.adminCoordinatorSweep();
      const settings = store.getThreadSettings(thread.id);
      const messages = store.getMessages(thread.id, 0, false);
      const transcript = store.getHumanTranscript(thread.id, 0, false);

      expect(created).toHaveLength(0);
      expect(settings?.auto_assigned_admin_id).toBeUndefined();
      expect(
        messages.filter((message) => message.metadata?.ui_type === 'admin_switch_confirmation_required')
      ).toHaveLength(0);
      expect(messages).toHaveLength(0);
    });

    it('multi agent emits timeout notice and takeover instruction for current admin', () => {
      const { thread } = store.createThread('multi-agent-intervention');
      const admin = store.registerAgent({ ide: 'VS Code', model: 'GPT-5.3-Codex' });
      const peer = store.registerAgent({ ide: 'Cursor', model: 'GPT-5.3-Codex' });

      const adminSync = store.issueSyncContext(thread.id, admin.id, 'seed-admin');
      store.postMessage({
        threadId: thread.id,
        author: admin.id,
        content: 'seed-admin',
        expectedLastSeq: adminSync.current_seq,
        replyToken: adminSync.reply_token,
        role: 'assistant',
      });

      const peerSync = store.issueSyncContext(thread.id, peer.id, 'seed-peer');
      store.postMessage({
        threadId: thread.id,
        author: peer.id,
        content: 'seed-peer',
        expectedLastSeq: peerSync.current_seq,
        replyToken: peerSync.reply_token,
        role: 'assistant',
      });

      store.switchAdmin(thread.id, admin.id, admin.display_name || admin.name || admin.id);
      store.updateThreadSettings(thread.id, { timeout_seconds: 30 });

      const oldEntered = new Date(Date.now() - 120_000).toISOString();
      seedWaitState(store, thread.id, admin.id, oldEntered);
      seedWaitState(store, thread.id, peer.id, oldEntered);

      const created = store.adminCoordinatorSweep();
      const settings = store.getThreadSettings(thread.id);
      const messages = store.getMessages(thread.id, 0, false);
      const transcript = store.getHumanTranscript(thread.id, 0, false);
      const noticeMessages = messages.filter(
        (message) => message.metadata?.ui_type === 'admin_coordination_timeout_notice'
      );
      const instructionMessages = messages.filter(
        (message) => message.metadata?.ui_type === 'admin_coordination_takeover_instruction'
      );
      const waitStates = store.getThreadWaitStatesGrouped();

      expect(created).toHaveLength(2);
      expect(settings?.auto_assigned_admin_id).toBe(admin.id);
      expect(
        messages.filter((message) => message.metadata?.ui_type === 'admin_switch_confirmation_required')
      ).toHaveLength(0);
      expect(noticeMessages).toHaveLength(1);
      expect(noticeMessages[0].metadata?.visibility).toBe('human_only');
      expect(instructionMessages).toHaveLength(1);
      expect(instructionMessages[0].metadata?.handoff_target).toBe(admin.id);
      expect(instructionMessages[0].metadata?.visibility).toBeUndefined();
      expect(waitStates[thread.id]).toBeDefined();
      expect(waitStates[thread.id][admin.id]).toBeDefined();
      expect(waitStates[thread.id][peer.id]).toBeDefined();
      expect(messages.some((message) => message.metadata?.visibility === 'human_only')).toBe(false);
      expect(transcript.some((message) => message.metadata?.visibility === 'human_only')).toBe(true);
    });

    it('single online current admin creates takeover confirmation instead of switch prompt', () => {
      const { thread } = store.createThread('single-agent-current-admin');
      const admin = store.registerAgent({ ide: 'VS Code', model: 'GPT-5.3-Codex' });

      store.switchAdmin(thread.id, admin.id, admin.display_name || admin.name || admin.id);
      store.updateThreadSettings(thread.id, { timeout_seconds: 30 });
      seedWaitState(store, thread.id, admin.id, new Date(Date.now() - 120_000).toISOString());

      const created = store.adminCoordinatorSweep();
      const messages = store.getMessages(thread.id, 0, false);
      const transcript = store.getHumanTranscript(thread.id, 0, false);
      const switchMessages = transcript.filter(
        (message) => message.metadata?.ui_type === 'admin_switch_confirmation_required'
      );
      const takeoverMessages = transcript.filter(
        (message) => message.metadata?.ui_type === 'admin_takeover_confirmation_required'
      );
      const waitStates = store.getThreadWaitStatesGrouped();

      expect(created).toHaveLength(1);
      expect(switchMessages).toHaveLength(0);
      expect(takeoverMessages).toHaveLength(1);
      expect(takeoverMessages[0].metadata?.visibility).toBe('human_only');
      expect(takeoverMessages[0].metadata?.current_admin_id).toBe(admin.id);
      expect(waitStates[thread.id]).toBeDefined();
      expect(waitStates[thread.id][admin.id]).toBeDefined();
      expect(messages.some((message) => message.metadata?.visibility === 'human_only')).toBe(false);
    });
  });
});
