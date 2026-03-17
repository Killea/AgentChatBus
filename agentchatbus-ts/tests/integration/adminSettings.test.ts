import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";

/**
 * Integration coverage for admin settings endpoints, aligned with Python thread admin defaults.
 */

describe("thread admin endpoints parity", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("returns default admin payload with null admin_agent_id", async () => {
    const server = createHttpServer();
    const threadRes = await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "admin-thread" }
    });
    const thread = threadRes.json();

    const adminRes = await server.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/admin`
    });

    expect(adminRes.statusCode).toBe(200);
    const body = adminRes.json();
    expect(body.thread_id).toBe(thread.id);
    expect(body.admin_agent_id).toBeNull();
    expect(body.auto_administrator_enabled).toBe(true);

    await server.close();
  });
});
