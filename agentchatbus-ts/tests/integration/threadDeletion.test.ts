import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";

/**
 * Integration tests for thread deletion with dependent cleanup, matching Python parity.
 */

describe("thread deletion parity", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("deletes thread and cleans up messages and reactions", async () => {
    const server = createHttpServer();
    
    // Create thread
    const threadRes = await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "delete-thread" }
    });
    const thread = threadRes.json();

    // Post a message
    const msgRes = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: "human",
        content: "test message",
        expected_last_seq: thread.current_seq,
        reply_token: thread.reply_token
      }
    });
    const msg = msgRes.json();

    // Add reaction - Python REST parity uses id
    const messageId = msg.id;
    expect(messageId).toBeDefined();
    const reactionRes = await server.inject({
      method: "POST",
      url: `/api/messages/${messageId}/reactions`,
      payload: { agent_id: "tester", reaction: "like" }
    });
    expect(reactionRes.statusCode).toBe(201);

    // Delete thread
    const deleteRes = await server.inject({
      method: "DELETE",
      url: `/api/threads/${thread.id}`
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json().ok).toBe(true);

    // Verify thread is gone
    const getRes = await server.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/messages`
    });
    expect(getRes.statusCode).toBe(404);

    await server.close();
  });

  it("returns 404 for non-existent thread deletion", async () => {
    const server = createHttpServer();
    
    const res = await server.inject({
      method: "DELETE",
      url: "/api/threads/non-existent-thread-id"
    });
    
    expect(res.statusCode).toBe(404);
    
    await server.close();
  });
});
