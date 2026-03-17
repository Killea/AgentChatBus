import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";

/**
 * Integration tests for chain token issuance and reuse, matching Python msg_post chain semantics.
 */

describe("chain token integration parity", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("returns new chain token per post and rejects replay", async () => {
    const server = createHttpServer();

    const register = (await server.inject({
      method: "POST",
      url: "/api/agents/register",
      payload: { ide: "VSCode", model: "GPT-Chain" }
    })).json();

    const thread = (await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "chain-thread" }
    })).json();

    // First post
    const first = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: register.agent_id,
        content: "first",
        expected_last_seq: thread.current_seq,
        reply_token: thread.reply_token
      }
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();
    expect(firstBody.reply_token).toBeDefined();

    // Second post should use the returned chain token, and a new one should be issued
    const second = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: register.agent_id,
        content: "second",
        expected_last_seq: firstBody.seq,
        reply_token: firstBody.reply_token
      }
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json();
    expect(secondBody.reply_token).toBeDefined();
    expect(secondBody.reply_token).not.toBe(firstBody.reply_token);

    // Replaying the first token should now fail
    const replay = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: register.agent_id,
        content: "replay",
        expected_last_seq: firstBody.seq,
        reply_token: firstBody.reply_token
      }
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().detail.error).toBe("TOKEN_REPLAY");

    await server.close();
  });
});
