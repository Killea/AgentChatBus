import { beforeEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/transports/http/server.js';

describe('Search Integration (Ported from tests/test_search_integration.py)', () => {
  beforeEach(() => {
    process.env.AGENTCHATBUS_TEST_DB = ':memory:';
  });

  async function createThreadAndPost(
    server: ReturnType<typeof createHttpServer>,
    topic: string,
    content: string
  ) {
    const reg = await server.inject({
      method: 'POST',
      url: '/api/agents/register',
      payload: { ide: 'Test', model: 'test-model' }
    });
    expect(reg.statusCode).toBe(200);
    const agent = reg.json();

    const threadResp = await server.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { topic }
    });
    expect([200, 201]).toContain(threadResp.statusCode);
    const thread = threadResp.json();

    const msgResp = await server.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        content,
        author: agent.agent_id,
        expected_last_seq: thread.current_seq,
        reply_token: thread.reply_token
      }
    });
    expect([200, 201]).toContain(msgResp.statusCode);

    return { thread_id: thread.id, message_id: msgResp.json().id, agent };
  }

  it('search endpoint basic', async () => {
    const server = createHttpServer();
    const unique = 'xkzqvflargematch';
    const data = await createThreadAndPost(server, `search-basic-${unique}`, `integration ${unique} content`);

    const resp = await server.inject({ method: 'GET', url: `/api/search?q=${unique}` });
    expect(resp.statusCode).toBe(200);

    const body = resp.json();
    expect(body).toHaveProperty('results');
    const threadIds = (body.results as any[]).map((r) => r.thread_id);
    expect(threadIds).toContain(data.thread_id);

    await server.close();
  });

  it('search endpoint no results', async () => {
    const server = createHttpServer();
    const resp = await server.inject({ method: 'GET', url: '/api/search?q=zxqvbnmunlikelyterm99999' });

    expect(resp.statusCode).toBe(200);
    expect(resp.json().results).toEqual([]);

    await server.close();
  });

  it('search endpoint result fields', async () => {
    const server = createHttpServer();
    const unique = 'xkzqvfresultfields';
    await createThreadAndPost(server, `fields-thread-${unique}`, `content ${unique} check`);

    const resp = await server.inject({ method: 'GET', url: `/api/search?q=${unique}` });
    expect(resp.statusCode).toBe(200);

    const body = resp.json();
    expect(body.results.length).toBeGreaterThan(0);
    const r = body.results[0];
    for (const field of ['id', 'thread_id', 'author', 'seq', 'created_at', 'content']) {
      expect(r).toHaveProperty(field);
    }

    await server.close();
  });

  it('search endpoint should return envelope fields total/query (python parity)', async () => {
    const server = createHttpServer();
    const unique = 'xkzqvfparityenvelope';
    await createThreadAndPost(server, `env-thread-${unique}`, `content ${unique} check`);

    const resp = await server.inject({ method: 'GET', url: `/api/search?q=${unique}` });
    expect(resp.statusCode).toBe(200);

    const body = resp.json();
    expect(body).toHaveProperty('results');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('query');

    await server.close();
  });

  it('search endpoint should reject missing query (python parity)', async () => {
    const server = createHttpServer();
    const resp = await server.inject({ method: 'GET', url: '/api/search' });

    expect([400, 422]).toContain(resp.statusCode);

    await server.close();
  });

  it('search endpoint should support thread_id filter (python parity)', async () => {
    const server = createHttpServer();
    const unique = 'xkzqvfthreadscope';
    const data1 = await createThreadAndPost(server, `scope-thread-1-${unique}`, `message one ${unique}`);
    await createThreadAndPost(server, `scope-thread-2-${unique}`, `message two ${unique}`);

    const resp = await server.inject({
      method: 'GET',
      url: `/api/search?q=${unique}&thread_id=${data1.thread_id}`
    });
    expect(resp.statusCode).toBe(200);

    const body = resp.json();
    const threadIds = new Set((body.results as any[]).map((r) => r.thread_id));
    expect(threadIds.has(data1.thread_id)).toBe(true);
    expect(threadIds.size).toBe(1);

    await server.close();
  });
});
