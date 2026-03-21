import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';
import { createHttpServer } from '../../src/transports/http/server.js';

const SAMPLE_SKILLS = [
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Reviews code for style, security, and best practices',
    tags: ['review', 'security'],
    examples: ['Review this PR for security issues']
  },
  {
    id: 'css-audit',
    name: 'CSS Audit',
    description: 'Audits CSS for token compliance and contrast',
    tags: ['css', 'accessibility']
  }
];

describe('Agent Capabilities (Ported from test_agent_capabilities.py)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(':memory:');
  });

  it('register with skills', () => {
    const agent = store.registerAgent({
      ide: 'Cursor',
      model: 'claude-3-5-sonnet',
      skills: SAMPLE_SKILLS as any
    });

    expect(agent.skills).toBeDefined();
    expect((agent.skills as any[]).length).toBe(2);
    expect((agent.skills as any[])[0].id).toBe('code-review');
    expect((agent.skills as any[])[1].id).toBe('css-audit');
  });

  it('register without skills', () => {
    const agent = store.registerAgent({ ide: 'CLI', model: 'GPT-4' });
    expect(agent.skills).toBeUndefined();

    const retrieved = store.getAgent(agent.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.skills).toBeUndefined();
  });

  it('register with capabilities and skills', () => {
    const agent = store.registerAgent({
      ide: 'Cursor',
      model: 'GPT-4',
      capabilities: ['code', 'review'],
      skills: [{ id: 'code-review', name: 'Code Review' }] as any
    });

    expect(agent.capabilities).toEqual(['code', 'review']);
    expect((agent.skills as any[])[0].id).toBe('code-review');
  });

  it('agent get', () => {
    const agent = store.registerAgent({ ide: 'Cursor', model: 'GPT-4', skills: SAMPLE_SKILLS as any });
    const retrieved = store.getAgent(agent.id);

    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(agent.id);
    expect(retrieved?.skills).toEqual(agent.skills);
  });

  it('agent get nonexistent', () => {
    const result = store.getAgent('nonexistent-id');
    expect(result).toBeUndefined();
  });

  it('update capabilities', () => {
    const agent = store.registerAgent({ ide: 'Cursor', model: 'GPT-4', capabilities: ['code'] });
    const updated = store.updateAgent(agent.id, agent.token, {
      capabilities: ['code', 'review', 'security']
    });

    expect(updated).toBeDefined();
    expect(updated?.capabilities).toEqual(['code', 'review', 'security']);
  });

  it('update skills', () => {
    const agent = store.registerAgent({ ide: 'Cursor', model: 'GPT-4' });
    expect(agent.skills).toBeUndefined();

    const updated = store.updateAgent(agent.id, agent.token, { skills: SAMPLE_SKILLS as any });

    expect(updated).toBeDefined();
    expect((updated?.skills as any[]).length).toBe(2);
    expect((updated?.skills as any[])[0].id).toBe('code-review');
  });

  it('update display_name', () => {
    const agent = store.registerAgent({ ide: 'Cursor', model: 'GPT-4' });
    expect(agent.alias_source).toBe('auto');

    const updated = store.updateAgent(agent.id, agent.token, { display_name: 'Expert Reviewer' });

    expect(updated).toBeDefined();
    expect(updated?.display_name).toBe('Expert Reviewer');
  });

  it('update partial', () => {
    const agent = store.registerAgent({
      ide: 'Cursor',
      model: 'GPT-4',
      description: 'original desc',
      capabilities: ['code']
    });

    const updated = store.updateAgent(agent.id, agent.token, {
      skills: [{ id: 'debug', name: 'Debugging' }] as any
    });

    expect(updated).toBeDefined();
    expect(updated?.description).toBe('original desc');
    expect(updated?.capabilities).toEqual(['code']);
    expect((updated?.skills as any[])[0].id).toBe('debug');
  });

  it('update invalid token', () => {
    const agent = store.registerAgent({ ide: 'Cursor', model: 'GPT-4' });
    const updated = store.updateAgent(agent.id, 'wrong-token', { skills: [{ id: 'x', name: 'X' }] as any });
    expect(updated).toBeUndefined();
  });

  it('update nonexistent agent', () => {
    const updated = store.updateAgent('no-such-id', 'any-token', {});
    expect(updated).toBeUndefined();
  });
});

describe('Agent Capabilities HTTP integration (Ported from test_agent_capabilities.py)', () => {
  beforeEach(() => {
    process.env.AGENTCHATBUS_TEST_DB = ':memory:';
  });

  async function registerAgent(server: ReturnType<typeof createHttpServer>) {
    const r = await server.inject({
      method: 'POST',
      url: '/api/agents/register',
      payload: {
        ide: 'TestIDE-UP15',
        model: 'test-model',
        description: 'UP-15 integration test agent',
        capabilities: ['test', 'up15'],
        skills: [{ id: 'up15-skill', name: 'UP-15 Test Skill' }]
      }
    });
    expect(r.statusCode).toBe(200);
    return r.json();
  }

  it('api register returns capabilities', async () => {
    const server = createHttpServer();
    const registered = await registerAgent(server);

    expect(registered.capabilities).toEqual(['test', 'up15']);

    await server.close();
  });

  it('api register returns skills', async () => {
    const server = createHttpServer();
    const registered = await registerAgent(server);

    expect(registered.skills).toBeDefined();
    expect(registered.skills.length).toBe(1);
    expect(registered.skills[0].id).toBe('up15-skill');

    await server.close();
  });

  it('api register returns emoji', async () => {
    const server = createHttpServer();
    const registered = await registerAgent(server);

    expect(typeof registered.emoji).toBe('string');
    expect(registered.emoji.length).toBeGreaterThan(0);

    await server.close();
  });

  it('api agents includes capabilities', async () => {
    const server = createHttpServer();
    const registered = await registerAgent(server);

    const r = await server.inject({ method: 'GET', url: '/api/agents' });
    expect(r.statusCode).toBe(200);

    const matched = (r.json() as any[]).find((a) => a.id === registered.agent_id);
    expect(matched).toBeDefined();
    expect(matched.capabilities).toEqual(['test', 'up15']);

    await server.close();
  });

  it('api agents includes skills', async () => {
    const server = createHttpServer();
    const registered = await registerAgent(server);

    const r = await server.inject({ method: 'GET', url: '/api/agents' });
    const matched = (r.json() as any[]).find((a) => a.id === registered.agent_id);

    expect(matched).toBeDefined();
    expect(matched.skills.length).toBe(1);
    expect(matched.skills[0].id).toBe('up15-skill');

    await server.close();
  });

  it('api agents includes emoji', async () => {
    const server = createHttpServer();
    const registered = await registerAgent(server);

    const r = await server.inject({ method: 'GET', url: '/api/agents' });
    const matched = (r.json() as any[]).find((a) => a.id === registered.agent_id);

    expect(matched).toBeDefined();
    expect(matched.emoji).toBe(registered.emoji);

    await server.close();
  });

  it('api agent get by id', async () => {
    const server = createHttpServer();
    const registered = await registerAgent(server);

    const r = await server.inject({ method: 'GET', url: `/api/agents/${registered.agent_id}` });
    expect(r.statusCode).toBe(200);

    const data = r.json();
    expect(data.id).toBe(registered.agent_id);
    expect(data.capabilities).toEqual(['test', 'up15']);
    expect(data.skills[0].id).toBe('up15-skill');
    expect(data.emoji).toBe(registered.emoji);

    await server.close();
  });

  it('api agent get 404', async () => {
    const server = createHttpServer();
    const r = await server.inject({ method: 'GET', url: '/api/agents/nonexistent-agent-id-xyz' });

    expect(r.statusCode).toBe(404);

    await server.close();
  });

  it('api agent update', async () => {
    const server = createHttpServer();
    const registered = await registerAgent(server);

    const r = await server.inject({
      method: 'PUT',
      url: `/api/agents/${registered.agent_id}`,
      payload: {
        token: registered.token,
        skills: [
          { id: 'up15-skill', name: 'UP-15 Test Skill' },
          { id: 'new-skill', name: 'New Skill Added via Update' }
        ]
      }
    });

    expect(r.statusCode).toBe(200);
    const data = r.json();
    expect(data.ok).toBe(true);
    expect(data.skills.length).toBe(2);
    expect(data.skills[1].id).toBe('new-skill');

    await server.close();
  });

  it('api agent update wrong token', async () => {
    const server = createHttpServer();
    const registered = await registerAgent(server);

    const r = await server.inject({
      method: 'PUT',
      url: `/api/agents/${registered.agent_id}`,
      payload: {
        token: 'completely-wrong-token',
        description: 'hacked'
      }
    });

    expect(r.statusCode).toBe(401);

    await server.close();
  });

  it('api register with explicit emoji', async () => {
    const server = createHttpServer();
    const r = await server.inject({
      method: 'POST',
      url: '/api/agents/register',
      payload: {
        ide: 'TestIDE',
        model: 'test-model',
        emoji: '🦊'
      }
    });
    expect(r.statusCode).toBe(200);
    const data = r.json();
    expect(data.emoji).toBe('🦊');

    await server.close();
  });

  it('api register with invalid emoji falls back to generated', async () => {
    const server = createHttpServer();
    const r = await server.inject({
      method: 'POST',
      url: '/api/agents/register',
      payload: {
        ide: 'TestIDE',
        model: 'test-model',
        emoji: 'not-an-emoji'
      }
    });
    expect(r.statusCode).toBe(200);
    const data = r.json();
    expect(typeof data.emoji).toBe('string');
    expect(data.emoji).not.toBe('not-an-emoji');

    await server.close();
  });

  it('api agent update emoji', async () => {
    const server = createHttpServer();
    const registered = await registerAgent(server);

    const r = await server.inject({
      method: 'PUT',
      url: `/api/agents/${registered.agent_id}`,
      payload: {
        token: registered.token,
        emoji: '🎉'
      }
    });

    expect(r.statusCode).toBe(200);
    const data = r.json();
    expect(data.ok).toBe(true);
    expect(data.emoji).toBe('🎉');

    const getR = await server.inject({ method: 'GET', url: `/api/agents/${registered.agent_id}` });
    expect(getR.json().emoji).toBe('🎉');

    await server.close();
  });

  it('api agents list includes emoji', async () => {
    const server = createHttpServer();
    const r = await server.inject({
      method: 'POST',
      url: '/api/agents/register',
      payload: {
        ide: 'TestIDE',
        model: 'test-model',
        emoji: '🔥'
      }
    });
    const registered = r.json();

    const listR = await server.inject({ method: 'GET', url: '/api/agents' });
    const agents = listR.json() as any[];
    const matched = agents.find(a => a.id === registered.agent_id);
    expect(matched?.emoji).toBe('🔥');

    await server.close();
  });
});
