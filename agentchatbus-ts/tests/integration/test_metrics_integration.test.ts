import { beforeEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/transports/http/server.js';

describe('Metrics Integration (Ported from tests/test_metrics.py)', () => {
  beforeEach(() => {
    process.env.AGENTCHATBUS_TEST_DB = ':memory:';
  });

  it('GET /api/metrics returns 200 with required top-level keys', async () => {
    const server = createHttpServer();

    const resp = await server.inject({ method: 'GET', url: '/api/metrics' });
    expect(resp.statusCode).toBe(200);

    const body = resp.json() as any;
    for (const key of ['uptime_seconds', 'started_at', 'schema_version', 'threads', 'messages', 'agents']) {
      expect(body).toHaveProperty(key);
    }

    await server.close();
  });

  it('GET /api/metrics reflects thread and message increments', async () => {
    const server = createHttpServer();

    const before = (await server.inject({ method: 'GET', url: '/api/metrics' })).json() as any;

    const threadResp = await server.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { topic: 'metrics-thread' }
    });
    expect([200, 201]).toContain(threadResp.statusCode);
    const thread = threadResp.json();

    await server.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: 'human',
        content: 'hello metrics',
        expected_last_seq: thread.current_seq,
        reply_token: thread.reply_token
      }
    });

    const after = (await server.inject({ method: 'GET', url: '/api/metrics' })).json() as any;
    expect(after.threads.total).toBe(before.threads.total + 1);
    expect(after.messages.total).toBe(before.messages.total + 1);

    await server.close();
  });

  it('GET /health remains lightweight without metrics payload', async () => {
    const server = createHttpServer();

    const resp = await server.inject({ method: 'GET', url: '/health' });
    expect(resp.statusCode).toBe(200);

    const body = resp.json() as any;
    expect(body).not.toHaveProperty('uptime_seconds');
    expect(body).not.toHaveProperty('threads');
    expect(body).not.toHaveProperty('messages');

    await server.close();
  });
});
