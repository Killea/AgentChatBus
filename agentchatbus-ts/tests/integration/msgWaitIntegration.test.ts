import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";

/**
 * Integration tests for msg_wait timeout and fast-return behavior, matching Python semantics.
 */

describe("msg_wait integration parity", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("returns immediately when agent is behind (fast-return)", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();

    // Register agent and create thread
    const agent = store.registerAgent({ ide: "VSCode", model: "Test" });
    const thread = (await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "fast-return-thread" }
    })).json();

    // Post a message so agent is behind
    await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: "human",
        content: "initial message",
        expected_last_seq: thread.current_seq,
        reply_token: thread.reply_token
      }
    });

    // Agent calls msg_wait with after_seq=0 (behind)
    const waitRes = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "msg_wait",
          arguments: {
            thread_id: thread.id,
            after_seq: 0,
            agent_id: agent.id,
            token: agent.token,
            timeout_ms: 5000,
            return_format: "json"
          }
        }
      }
    });

    expect(waitRes.statusCode).toBe(200);
    const result = waitRes.json().result;
    const payload = JSON.parse(result[0].text);
    expect(payload.error).toBeUndefined();
    
    // Should return immediately with messages
    expect(payload.messages.length).toBeGreaterThan(0);
    expect(payload.reply_token).toBeDefined();

    await server.close();
  });

  it("waits for new messages when agent is up-to-date", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();

    // Use bus_connect to create agent and thread together
    const connectRes = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: {
            thread_name: "wait-thread",
            ide: "VSCode",
            model: "Test"
          }
        }
      }
    });
    const connected = JSON.parse(connectRes.json().result[0].text);
    const agentId = connected.agent.agent_id;
    const agentToken = connected.agent.token;

    // Start msg_wait in background (should block)
    const waitPromise = server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "msg_wait",
          arguments: {
            thread_id: connected.thread.id,
            after_seq: connected.current_seq,
            agent_id: agentId,
            token: agentToken,
            timeout_ms: 2000,
            return_format: "json"
          }
        }
      }
    });

    // Wait a bit then post a message
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Need to get a valid sync context for posting
    const syncContext = store.issueSyncContext(connected.thread.id, "human");
    await server.inject({
      method: "POST",
      url: `/api/threads/${connected.thread.id}/messages`,
      payload: {
        author: "human",
        content: "trigger message",
        expected_last_seq: syncContext.current_seq,
        reply_token: syncContext.reply_token
      }
    });

    // msg_wait should now complete
    const waitRes = await waitPromise;
    expect(waitRes.statusCode).toBe(200);
    const payload = JSON.parse(waitRes.json().result[0].text);
    expect(payload.messages.length).toBeGreaterThan(0);

    await server.close();
  });

  it("returns timeout after specified duration", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();

    const agent = store.registerAgent({ ide: "VSCode", model: "Test" });
    const thread = (await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "timeout-thread" }
    })).json();

    const startTime = Date.now();
    
    const waitRes = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "msg_wait",
          arguments: {
            thread_id: thread.id,
            after_seq: thread.current_seq,
            agent_id: agent.id,
            token: agent.token,
            timeout_ms: 500,
            return_format: "json"
          }
        }
      }
    });

    const elapsed = Date.now() - startTime;
    
    expect(waitRes.statusCode).toBe(200);
    const payload = JSON.parse(waitRes.json().result[0].text);
    expect(payload.error).toBeUndefined();
    // Should timeout with empty messages
    expect(payload.messages.length).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(400); // Allow some tolerance

    await server.close();
  });
});
