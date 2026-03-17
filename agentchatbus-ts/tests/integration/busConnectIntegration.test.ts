import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, memoryStoreInstance } from "../../src/transports/http/server.js";

/**
 * Integration tests for bus_connect MCP tool, matching Python test_bus_connect.py semantics.
 */

describe("bus_connect integration parity", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("creates new agent and thread on first call", async () => {
    const server = createHttpServer();

    const res = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: {
            thread_name: "Test Auto Create",
            ide: "TestIDE",
            model: "TestModel"
          }
        }
      }
    });

    expect(res.statusCode).toBe(200);
    const result = res.json().result;
    const payload = JSON.parse(result[0].text);

    // Check agent
    expect(payload.agent.registered).toBe(true);
    expect(payload.agent.agent_id).toBeDefined();
    expect(payload.agent.token).toBeDefined();
    expect(payload.agent.name).toContain("TestIDE");

    // Check thread
    expect(payload.thread.topic).toBe("Test Auto Create");
    expect(payload.thread.created).toBe(true);
    expect(payload.thread.status).toBe("discuss");

    // Check sync context
    expect(payload.current_seq).toBe(0);
    expect(payload.reply_token).toBeDefined();
    expect(payload.reply_window).toBeDefined();

    await server.close();
  });

  it("reuses existing thread with same name", async () => {
    const server = createHttpServer();

    // First call creates thread
    const res1 = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: {
            thread_name: "Existing Thread",
            ide: "FirstIDE",
            model: "Model1"
          }
        }
      }
    });
    const payload1 = JSON.parse(res1.json().result[0].text);
    expect(payload1.thread.created).toBe(true);

    // Post a message
    await server.inject({
      method: "POST",
      url: `/api/threads/${payload1.thread.id}/messages`,
      payload: {
        author: payload1.agent.agent_id,
        content: "First message",
        expected_last_seq: payload1.current_seq,
        reply_token: payload1.reply_token
      }
    });

    // Second call should reuse thread
    const res2 = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: {
            thread_name: "Existing Thread",
            ide: "SecondIDE",
            model: "Model2"
          }
        }
      }
    });
    const payload2 = JSON.parse(res2.json().result[0].text);

    expect(payload2.thread.created).toBe(false);
    expect(payload2.thread.topic).toBe("Existing Thread");
    expect(payload2.current_seq).toBeGreaterThan(0);
    expect(payload2.messages.length).toBeGreaterThan(0);

    await server.close();
  });

  it("returns system prompt in initial messages", async () => {
    const server = createHttpServer();

    const res = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: {
            thread_name: "System Prompt Thread",
            ide: "TestIDE",
            model: "TestModel"
          }
        }
      }
    });

    const payload = JSON.parse(res.json().result[0].text);
    expect(payload.messages.length).toBeGreaterThan(0);
    
    // First message should be system prompt
    const firstMsg = payload.messages[0];
    expect(firstMsg.role).toBe("system");

    await server.close();
  });
});
