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
    expect(body.admin_id).toBeNull();
    expect(body.admin_name).toBeNull();
    expect(body.admin_emoji).toBeNull();
    expect(body.admin_type).toBeNull();
    expect(body.assigned_at).toBeNull();

    await server.close();
  });
});
