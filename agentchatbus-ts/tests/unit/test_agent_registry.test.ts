import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';
import { AGENT_EMOJIS, deriveAgentEmojiSeed, generateAgentEmoji, generateAgentEmojiCandidates, validateEmoji } from '../../src/main.js';

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

  it('agent wait and post activity tracking', async () => {
    const thread = store.createThread('activity-test').thread;
    const agent = store.registerAgent({ ide: 'VSCode', model: 'GPT' });
    const initialHeartbeat = agent.last_heartbeat;

    await new Promise((resolve) => setTimeout(resolve, 10));
    const okWait = store.agentMsgWait(agent.id, agent.token);
    expect(okWait).toBe(true);

    const refreshed = store.listAgents()[0];
    expect(refreshed.last_activity).toBe('msg_wait');
    expect(refreshed.last_heartbeat).not.toBe(initialHeartbeat);

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

  it('waitForMessages refreshes heartbeat while polling', async () => {
    const thread = store.createThread('wait-heartbeat').thread;
    const agent = store.registerAgent({ ide: 'VSCode', model: 'GPT' });
    const initialHeartbeat = agent.last_heartbeat;

    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.waitForMessages({
      threadId: thread.id,
      afterSeq: 0,
      timeoutMs: 10,
      agentId: agent.id,
      agentToken: agent.token
    });

    const refreshed = store.listAgents()[0];
    expect(refreshed.last_activity).toBe('msg_wait');
    expect(refreshed.last_heartbeat).not.toBe(initialHeartbeat);
  });

  it('agent resume rejects bad token', () => {
    const agent = store.registerAgent({ ide: 'CLI', model: 'X' });
    expect(() => store.resumeAgent(agent.id, 'bad-token')).toThrow('Invalid agent_id/token');
  });

  it('agent register trims blank ide/model and uses Python name suffixes', () => {
    const blank = store.registerAgent({ ide: '   ', model: '' });
    const first = store.registerAgent({ ide: 'VSCode', model: 'GPT' });
    const second = store.registerAgent({ ide: 'VSCode', model: 'GPT' });

    expect(blank.name).toBe('Unknown IDE (Unknown Model)');
    expect(blank.token).toMatch(/^[0-9a-f]{64}$/);
    expect(first.name).toBe('VSCode (GPT)');
    expect(second.name).toBe('VSCode (GPT) 2');
  });

  it('agent register preserves empty description as empty string', () => {
    const agent = store.registerAgent({ ide: 'VSCode', model: 'GPT' });
    const resumed = store.resumeAgent(agent.id, agent.token);

    expect(agent.description).toBe('');
    expect(resumed?.description).toBe('');
    expect(store.listAgents()[0].description).toBe('');
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

  it('derives a stable emoji seed from user display name', () => {
    const seed1 = deriveAgentEmojiSeed({
      ide: 'Cursor',
      model: 'GPT-5',
      display_name: 'Planner',
      alias_source: 'user',
    });
    const seed2 = deriveAgentEmojiSeed({
      ide: 'Cursor',
      model: 'GPT-5',
      display_name: ' planner ',
      alias_source: 'user',
    });

    expect(seed1).toBe(seed2);
    expect(seed1).toContain('display:planner');
  });

  it('produces a deterministic emoji preference order for a stable seed', () => {
    const candidates1 = generateAgentEmojiCandidates('runtime:cursor|gpt-5');
    const candidates2 = generateAgentEmojiCandidates('runtime:cursor|gpt-5');

    expect(candidates1).toEqual(candidates2);
    expect(new Set(candidates1).size).toBe(candidates1.length);
  });

  it('keeps the expanded emoji pool from the original Python implementation', () => {
    expect(AGENT_EMOJIS.length).toBeGreaterThanOrEqual(80);
    expect(AGENT_EMOJIS).toContain('🦊');
    expect(AGENT_EMOJIS).toContain('🛰️');
    expect(AGENT_EMOJIS).toContain('🎸');
  });

  it('agent_list marks stale heartbeat agents offline even if persisted is_online is true', () => {
    const agent = store.registerAgent({ ide: 'VSCode', model: 'GPT' });
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    (store as any).persistenceDb
      .prepare('UPDATE agents SET is_online = 1, last_heartbeat = ?, last_activity_time = ? WHERE id = ?')
      .run(stale, stale, agent.id);

    const found = store.listAgents().find((a) => a.id === agent.id);
    expect(found).toBeDefined();
    expect(found?.is_online).toBe(false);
  });

  it('agent_list treats recent activity as online even when heartbeat is stale', () => {
    const agent = store.registerAgent({ ide: 'VSCode', model: 'GPT' });
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    (store as any).persistenceDb
      .prepare('UPDATE agents SET last_heartbeat = ?, last_activity_time = ? WHERE id = ?')
      .run(stale, recent, agent.id);

    const found = store.listAgents().find((a) => a.id === agent.id);
    expect(found).toBeDefined();
    expect(found?.is_online).toBe(true);
  });

  it('register with explicit emoji persists it', () => {
    const agent = store.registerAgent({ ide: 'Cursor', model: 'GPT-4', emoji: '🦊' });
    expect(agent.emoji).toBe('🦊');

    const retrieved = store.getAgent(agent.id);
    expect(retrieved?.emoji).toBe('🦊');

    const listed = store.listAgents().find(a => a.id === agent.id);
    expect(listed?.emoji).toBe('🦊');
  });

  it('register without emoji falls back to deterministic hash', () => {
    const agent = store.registerAgent({ ide: 'Cursor', model: 'GPT-4' });
    const expected = generateAgentEmojiCandidates('runtime:cursor|gpt-4')[0];
    expect(agent.emoji).toBe(expected);
  });

  it('keeps the fallback emoji stable across re-register for the same user alias', () => {
    const first = store.registerAgent({
      ide: 'Codex',
      model: 'GPT-5',
      display_name: 'Architect',
    });
    const firstEmoji = first.emoji;

    expect(store.unregisterAgent(first.id, first.token!)).toBe(true);

    const second = store.registerAgent({
      ide: 'Codex',
      model: 'GPT-5',
      display_name: 'Architect',
    });

    expect(second.emoji).toBe(firstEmoji);
  });

  it('avoids duplicate fallback emoji for concurrently online agents with the same runtime seed', () => {
    const first = store.registerAgent({ ide: 'Cursor', model: 'GPT-4' });
    const second = store.registerAgent({ ide: 'Cursor', model: 'GPT-4' });

    expect(first.emoji).toBeDefined();
    expect(second.emoji).toBeDefined();
    expect(second.emoji).not.toBe(first.emoji);
  });

  it('updateAgent with emoji changes stored emoji', () => {
    const agent = store.registerAgent({ ide: 'Cursor', model: 'GPT-4' });
    const originalEmoji = agent.emoji;

    const updated = store.updateAgent(agent.id, agent.token!, { emoji: '🎉' });
    expect(updated?.emoji).toBe('🎉');
    expect(updated?.emoji).not.toBe(originalEmoji);

    const retrieved = store.getAgent(agent.id);
    expect(retrieved?.emoji).toBe('🎉');
  });

  it('updateAgent without emoji preserves current emoji', () => {
    const agent = store.registerAgent({ ide: 'Cursor', model: 'GPT-4', emoji: '🦊' });
    const updated = store.updateAgent(agent.id, agent.token!, { display_name: 'Fox Agent' });
    expect(updated?.emoji).toBe('🦊');
  });
});

describe('validateEmoji', () => {
  it('accepts single emoji', () => {
    expect(validateEmoji('🦊')).toBe('🦊');
    expect(validateEmoji('🤖')).toBe('🤖');
    expect(validateEmoji('⚡')).toBe('⚡');
  });

  it('rejects plain text', () => {
    expect(validateEmoji('hello')).toBeNull();
    expect(validateEmoji('abc123')).toBeNull();
  });

  it('rejects empty and whitespace', () => {
    expect(validateEmoji('')).toBeNull();
    expect(validateEmoji('   ')).toBeNull();
    expect(validateEmoji(null)).toBeNull();
    expect(validateEmoji(undefined)).toBeNull();
  });

  it('trims whitespace around valid emoji', () => {
    expect(validateEmoji('  🦊  ')).toBe('🦊');
  });

  it('rejects non-string types', () => {
    expect(validateEmoji(42)).toBeNull();
    expect(validateEmoji(true)).toBeNull();
  });
});
