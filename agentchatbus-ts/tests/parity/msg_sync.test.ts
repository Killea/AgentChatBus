import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, memoryStoreInstance } from "../../src/transports/http/server.js";
import { memoryStore } from "../../src/core/services/memoryStore.js";
import type { FastifyInstance } from "fastify";

describe("Message Synchronization Parity Tests (Python vs TS)", () => {
  let server: FastifyInstance;

  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(async () => {
    memoryStore.reset();
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
    server = createHttpServer();
  });

  afterEach(async () => {
    await server.close();
  });

  async function createThread(topic: string) {
    const res = await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic }
    });
    return res.json();
  }

  it("handles sequence tolerance (UP-PARITY)", async () => {
    const thread = await createThread("tolerance-thread");
    
    // With SEQ_TOLERANCE = 0 (strict mode), ANY difference in seq triggers SeqMismatchError
    // Post 1 message from system to advance sequence
    await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/messages`,
        payload: {
            author: "system",
            content: "background message",
            role: "system"
        }
    });
    
    // Now try to post with the ORIGINAL sync context (seq=0)
    // SEQ_TOLERANCE = 0 means ANY mismatch is rejected
    const res = await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/messages`,
        payload: {
            author: "human",
            content: "user message with old seq",
            expected_last_seq: 0,
            reply_token: thread.reply_token
        }
    });
    
    // Should fail with SeqMismatchError because seq advanced by 1 > SEQ_TOLERANCE (0)
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("SEQ_MISMATCH");
  });

  it("rejects when beyond sequence tolerance", async () => {
    const thread = await createThread("tolerance-fail-thread");
    
    // Post 3 messages - ANY difference triggers SeqMismatchError when SEQ_TOLERANCE = 0
    for (let i = 0; i < 3; i++) {
        await server.inject({
            method: "POST",
            url: `/api/threads/${thread.id}/messages`,
            payload: {
                author: "system",
                content: `background ${i}`,
                role: "system"
            }
        });
    }
    
    const res = await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/messages`,
        payload: {
            author: "human",
            content: "user message with stale seq",
            expected_last_seq: 0,
            reply_token: thread.reply_token
        }
    });
    
    // Should fail with SeqMismatchError because seq advanced by 3 > SEQ_TOLERANCE (0)
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error || body.detail?.error).toBe("SEQ_MISMATCH");
    expect(body.current_seq || body.detail?.current_seq).toBe(3);
  });

  it("returns naked array for /api/agents (frontend parity)", async () => {
    const res = await server.inject({
        method: "GET",
        url: "/api/agents"
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it("registers and lists agents (UP-PARITY)", async () => {
    const regRes = await server.inject({
        method: "POST",
        url: "/api/agents/register",
        payload: {
            ide: "VSCode",
            model: "GPT-4",
            display_name: "TestAgent",
            capabilities: ["code"],
            skills: [{ id: "lint", name: "Linter" }]
        }
    });
    
    expect(regRes.statusCode).toBe(200);
    const agent = regRes.json();
    expect(agent.agent_id || agent.id).toBeTruthy();
    expect(agent.token).toBeTruthy();
    expect(agent.display_name).toBe("TestAgent");
    
    const listRes = await server.inject({
        method: "GET",
        url: "/api/agents"
    });
    const agents = listRes.json();
    expect(Array.isArray(agents)).toBe(true);
    const found = agents.find((a: any) => a.id === agent.id);
    expect(found).toBeTruthy();
    expect(found.display_name).toBe("TestAgent");
  });
});
