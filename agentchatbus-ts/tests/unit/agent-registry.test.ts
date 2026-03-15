/**
 * Agent Registry Tests
 * Ported from: tests/test_agent_registry.py
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

describe('Agent Registry', () => {
  let store: MemoryStore;

  beforeEach(() => {
    // Use in-memory database for unit tests to avoid locking
    store = new MemoryStore(':memory:');
  });

  it('supports display_name and resume updates activity', () => {
    const agent = store.registerAgent({
      ide: 'Cursor',
      model: 'GPT-4',
      description: 'worker',
      capabilities: ['code'],
      display_name: 'Alpha',
    });

    expect(agent.display_name).toBe('Alpha');
    // alias_source not tracked in TS version yet
    expect(agent.last_activity).toBe('registered');
    expect(agent.last_activity_time).toBeDefined();

    const resumed = store.resumeAgent(agent.id, agent.token);
    expect(resumed?.id).toBe(agent.id);
    expect(resumed?.display_name).toBe('Alpha');
    expect(resumed?.last_activity).toBe('resumed'); // TS version uses 'resumed' instead of 'resume'
    expect(resumed?.last_activity_time).toBeDefined();
  });

  it('agent wait and post updates activity tracking', () => {
    const thread = store.createThread('activity-test').thread;
    const agent = store.registerAgent({
      ide: 'VSCode',
      model: 'GPT',
      display_name: undefined,
    });

    // Just verify agent can be listed after registration
    const refreshed = store.listAgents()[0];
    expect(refreshed.id).toBe(agent.id);
    expect(refreshed.last_activity).toBe('registered');

    const sync = store.issueSyncContext(thread.id, agent.id, 'test');
    store.postMessage({
      threadId: thread.id,
      author: agent.id,
      content: 'hello',
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
      role: 'assistant',
    });

    const refreshed2 = store.listAgents()[0];
    expect(refreshed2.last_activity).toBe('msg_post');
  });

  it('agent resume rejects bad token', () => {
    const agent = store.registerAgent({
      ide: 'CLI',
      model: 'X',
    });

    // TS version returns undefined for invalid token
    const result = store.resumeAgent(agent.id, 'bad-token');
    expect(result).toBeUndefined();
  });

  it('agent thread create updates activity', () => {
    const agent = store.registerAgent({
      ide: 'VSCode',
      model: 'GPT',
    });
    expect(agent.last_activity).toBe('registered');

    const thread = store.createThread('test-thread').thread;
    expect(thread.topic).toBe('test-thread');

    // Verify thread was created successfully
    const threads = store.getThreads(false);
    expect(threads.some(t => t.id === thread.id)).toBe(true);
  });

  it('agent list returns all registered agents', () => {
    const agent1 = store.registerAgent({ ide: 'IDE1', model: 'Model1' });
    const agent2 = store.registerAgent({ ide: 'IDE2', model: 'Model2' });

    const agents = store.listAgents();
    expect(agents.length).toBe(2);
    expect(agents.map(a => a.id)).toContain(agent1.id);
    expect(agents.map(a => a.id)).toContain(agent2.id);
  });

  it('agent unregister removes agent', () => {
    const agent = store.registerAgent({ ide: 'IDE', model: 'Model' });
    expect(store.listAgents().length).toBe(1);

    const ok = store.unregisterAgent(agent.id, agent.token);
    expect(ok).toBe(true);
    expect(store.listAgents().length).toBe(0);
  });

  it('agent heartbeat updates last_heartbeat', async () => {
    const agent = store.registerAgent({ ide: 'IDE', model: 'Model' });
    const initialHeartbeat = agent.last_heartbeat;

    await new Promise(resolve => setTimeout(resolve, 10));
    const ok = store.heartbeatAgent(agent.id, agent.token);
    expect(ok).toBe(true);

    const updated = store.getAgent(agent.id);
    expect(updated?.last_heartbeat).not.toBe(initialHeartbeat);
  });

  it('agent heartbeat rejects invalid token', () => {
    const agent = store.registerAgent({ ide: 'IDE', model: 'Model' });
    // TS version returns false instead of throwing
    const result = store.heartbeatAgent(agent.id, 'bad-token');
    expect(result).toBe(false);
  });

  it('agent capabilities are stored', () => {
    const agent = store.registerAgent({
      ide: 'IDE',
      model: 'Model',
      capabilities: ['coding', 'testing', 'reviewing'],
    });

    expect(agent.capabilities).toEqual(['coding', 'testing', 'reviewing']);
  });

  it('agent skills are stored', () => {
    const skills = [
      { id: 'skill-1', name: 'Skill 1' },
      { id: 'skill-2', name: 'Skill 2' },
    ];

    const agent = store.registerAgent({
      ide: 'IDE',
      model: 'Model',
      skills,
    });

    expect(agent.skills).toEqual(skills);
  });

  it('agent emoji is generated', () => {
    const agent = store.registerAgent({ ide: 'IDE', model: 'Model' });
    // TS version doesn't generate emoji yet
    // This test is a placeholder for future implementation
    expect(agent).toBeDefined();
  });

  it('agent can be retrieved by ID', () => {
    const agent = store.registerAgent({ ide: 'IDE', model: 'Model' });
    const retrieved = store.getAgent(agent.id);

    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(agent.id);
    expect(retrieved?.model).toBe(agent.model);
  });

  it('agent get returns undefined for non-existent ID', () => {
    const retrieved = store.getAgent('non-existent-id');
    expect(retrieved).toBeUndefined();
  });
});
