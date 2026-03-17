import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";

/**
 * Integration tests for error handling and edge cases, matching Python behavior.
 */

describe("error handling and edge cases parity", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("returns 404 for non-existent thread", async () => {
    const server = createHttpServer();

    const res = await server.inject({
      method: "GET",
      url: "/api/threads/non-existent-id/messages"
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().detail).toContain("not found");

    await server.close();
  });

  it("returns 404 for non-existent agent", async () => {
    const server = createHttpServer();

    const res = await server.inject({
      method: "GET",
      url: "/api/agents/non-existent-agent-id"
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().detail).toContain("not found");

    await server.close();
  });

  it("returns 400 for missing required fields", async () => {
    const server = createHttpServer();

    // Create thread first
    const thread = (await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "validation-thread" }
    })).json();

    // Try to post with invalid reply_to_msg_id (should return 400)
    const res = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: "human",
        content: "test",
        expected_last_seq: thread.current_seq,
        reply_token: thread.reply_token,
        reply_to_msg_id: "non-existent-msg-id"
      }
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    await server.close();
  });

  it("handles concurrent message posts correctly", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();

    const thread = (await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "concurrent-thread" }
    })).json();

    // Create multiple agents
    const agent1 = store.registerAgent({ ide: "IDE1", model: "M1" });
    const agent2 = store.registerAgent({ ide: "IDE2", model: "M2" });
    const agent3 = store.registerAgent({ ide: "IDE3", model: "M3" });

    // Each agent gets a sync context
    const sync1 = store.issueSyncContext(thread.id, agent1.id);
    const sync2 = store.issueSyncContext(thread.id, agent2.id);
    const sync3 = store.issueSyncContext(thread.id, agent3.id);

    // Post concurrently
    const posts = [
      server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/messages`,
        payload: {
          author: agent1.id,
          content: "Message from agent 1",
          expected_last_seq: sync1.current_seq,
          reply_token: sync1.reply_token
        }
      }),
      server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/messages`,
        payload: {
          author: agent2.id,
          content: "Message from agent 2",
          expected_last_seq: sync2.current_seq,
          reply_token: sync2.reply_token
        }
      }),
      server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/messages`,
        payload: {
          author: agent3.id,
          content: "Message from agent 3",
          expected_last_seq: sync3.current_seq,
          reply_token: sync3.reply_token
        }
      })
    ];

    const results = await Promise.all(posts);
    
    // At least one should succeed
    const successCount = results.filter(r => r.statusCode === 201).length;
    expect(successCount).toBeGreaterThanOrEqual(1);

    // Others should fail with seq mismatch or token replay
    const failures = results.filter(r => r.statusCode !== 201);
    for (const fail of failures) {
      expect([400, 409]).toContain(fail.statusCode);
    }

    await server.close();
  });

  it("validates reply_to_msg_id exists", async () => {
    const server = createHttpServer();

    const thread = (await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "reply-validation" }
    })).json();

    // Try to reply to non-existent message
    const res = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: "human",
        content: "reply to ghost",
        expected_last_seq: thread.current_seq,
        reply_token: thread.reply_token,
        reply_to_msg_id: "non-existent-msg-id"
      }
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    await server.close();
  });
});
