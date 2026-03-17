import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';
import { generateAgentEmoji } from '../../src/main.js';

describe('Agent Registry (Ported from test_agent_registry.py)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(':memory:');
  });

  it('agent register supports display_name and resume updates activity', () => {
    const agent = store.registerAgent({
      ide: 'Cursor',
      model: 'GPT-4',
      description: 'worker',
      capabilities: ['code'],
      display_name: 'Alpha'
    });

    expect(agent.display_name).toBe('Alpha');
    expect(agent.alias_source).toBe('user');
    expect(agent.last_activity).toBe('registered');
    expect(agent.last_activity_time).toBeDefined();

    const resumed = store.resumeAgent(agent.id, agent.token);
    expect(resumed?.id).toBe(agent.id);
    expect(resumed?.display_name).toBe('Alpha');
    expect(resumed?.last_activity).toBe('resume');
    expect(resumed?.last_activity_time).toBeDefined();
  });

  it('agent wait and post activity tracking', () => {
    const thread = store.createThread('activity-test').thread;
    const agent = store.registerAgent({ ide: 'VSCode', model: 'GPT' });

    const okWait = store.agentMsgWait(agent.id, agent.token);
    expect(okWait).toBe(true);

    const refreshed = store.listAgents()[0];
    expect(refreshed.last_activity).toBe('msg_wait');

    const sync = store.issueSyncContext(thread.id, agent.id, 'msg_post');
    store.postMessage({
      threadId: thread.id,
      author: agent.id,
      content: 'hello',
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
      role: 'assistant'
    });

    const refreshed2 = store.listAgents()[0];
    expect(refreshed2.last_activity).toBe('msg_post');
  });

  it('agent resume rejects bad token', () => {
    const agent = store.registerAgent({ ide: 'CLI', model: 'X' });
    expect(() => store.resumeAgent(agent.id, 'bad-token')).toThrow('Invalid agent_id or token');
  });

  it('agent thread create updates activity', async () => {
    const agent = store.registerAgent({ ide: 'VSCode', model: 'GPT' });
    const initialHeartbeat = agent.last_heartbeat;

    await new Promise((resolve) => setTimeout(resolve, 10));
    store.updateAgentActivity(agent.id, 'thread_create', true);

    const refreshed = store.listAgents()[0];
    expect(refreshed.last_activity).toBe('thread_create');
    expect(refreshed.last_heartbeat).not.toBe(initialHeartbeat);
  });

  it('agent emoji mapping is deterministic and normalized', () => {
    const emoji1 = generateAgentEmoji('AbC-123');
    const emoji2 = generateAgentEmoji('AbC-123');
    const emoji3 = generateAgentEmoji('  abc-123  ');

    expect(emoji1).toBe(emoji2);
    expect(emoji1).toBe(emoji3);
  });
});
