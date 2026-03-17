import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";

/**
 * Integration tests for message search functionality, matching Python search semantics.
 */

describe("message search parity", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("searches messages by content", async () => {
    const server = createHttpServer();
    
    // Create thread and post messages
    const thread = (await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "search-thread" }
    })).json();

    await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: "human",
        content: "This is a test message about Python",
        expected_last_seq: thread.current_seq,
        reply_token: thread.reply_token
      }
    });

    const msg2 = (await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: "assistant",
        content: "This is about TypeScript and JavaScript",
        expected_last_seq: 1,
        reply_token: (await server.inject({
          method: "POST",
          url: `/api/threads/${thread.id}/sync-context`
        })).json().reply_token
      }
    })).json();

    // Search for Python
    const search1 = await server.inject({
      method: "GET",
      url: "/api/search?q=Python"
    });
    expect(search1.statusCode).toBe(200);
    expect(search1.json().results.length).toBeGreaterThan(0);
    expect(search1.json().results[0].content).toContain("Python");

    // Search for TypeScript
    const search2 = await server.inject({
      method: "GET",
      url: "/api/search?q=TypeScript"
    });
    expect(search2.statusCode).toBe(200);
    expect(search2.json().results.length).toBeGreaterThan(0);
    expect(search2.json().results[0].content).toContain("TypeScript");

    await server.close();
  });

  it("returns empty results for non-matching query", async () => {
    const server = createHttpServer();
    
    const search = await server.inject({
      method: "GET",
      url: "/api/search?q=nonexistentterm12345"
    });
    
    expect(search.statusCode).toBe(200);
    expect(search.json().results).toEqual([]);
    expect(search.json().total).toBe(0);

    await server.close();
  });

  it("rejects empty query", async () => {
    const server = createHttpServer();
    
    const res = await server.inject({
      method: "GET",
      url: "/api/search?q="
    });
    
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("must not be empty");

    await server.close();
  });

  it("limits search results", async () => {
    const server = createHttpServer();
    
    // Create thread with many messages
    const thread = (await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "limit-thread" }
    })).json();

    // Post 10 messages
    let currentSeq = thread.current_seq;
    let currentToken = thread.reply_token;
    
    for (let i = 0; i < 10; i++) {
      const msg = (await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/messages`,
        payload: {
          author: "human",
          content: `Test message ${i}`,
          expected_last_seq: currentSeq,
          reply_token: currentToken
        }
      })).json();
      currentSeq = msg.seq;
      currentToken = msg.reply_token;
    }

    // Search with limit
    const search = await server.inject({
      method: "GET",
      url: "/api/search?q=Test&limit=5"
    });
    
    expect(search.statusCode).toBe(200);
    expect(search.json().results.length).toBeLessThanOrEqual(5);

    await server.close();
  });
});
