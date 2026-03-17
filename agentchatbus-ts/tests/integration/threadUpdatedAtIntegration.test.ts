import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";

/**
 * Integration check for thread.updated_at parity with Python. TS schema currently lacks updated_at;
 * this test will begin asserting once the column is available.
 */

describe("thread updated_at integration parity", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("sets created_at and (future) updated_at on thread create", async () => {
    const server = createHttpServer();
    const res = await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "updated-at-http" }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.created_at).toBeDefined();
    // When updated_at is implemented in TS schema, assert here:
    // expect(body.updated_at).toBeDefined();
    await server.close();
  });
});
