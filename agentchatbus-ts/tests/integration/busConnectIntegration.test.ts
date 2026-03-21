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
      url: `/api/threads/${payload1.thread.thread_id}/messages`,
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

  it("returns built-in and custom thread system prompt when creating a thread", async () => {
    const server = createHttpServer();
    const customPrompt = "Coordinate carefully and ask for human confirmation before risky changes.";

    const res = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: {
            thread_name: "Custom System Prompt Thread",
            ide: "TestIDE",
            model: "TestModel",
            system_prompt: customPrompt
          }
        }
      }
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.json().result[0].text);
    expect(payload.thread.created).toBe(true);
    expect(payload.thread.system_prompt).toBe(customPrompt);
    expect(payload.messages.length).toBeGreaterThan(0);

    const firstMsg = payload.messages[0];
    expect(firstMsg.role).toBe("system");
    expect(firstMsg.content).toContain("## Section: System (Built-in)");
    expect(firstMsg.content).toContain("## Section: Thread Create (Provided By Creator)");
    expect(firstMsg.content).toContain(customPrompt);

    await server.close();
  });

  it("persists creator admin when bus_connect creates a new thread", async () => {
    const server = createHttpServer();

    const res = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: {
            thread_name: "Bus Connect Creator Admin",
            ide: "TestIDE",
            model: "TestModel"
          }
        }
      }
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.json().result[0].text);

    const adminRes = await server.inject({
      method: "GET",
      url: `/api/threads/${payload.thread.thread_id}/admin`
    });

    expect(adminRes.statusCode).toBe(200);
    const adminPayload = adminRes.json();
    expect(adminPayload.admin_id).toBe(payload.agent.agent_id);
    expect(adminPayload.admin_type).toBe("creator");

    await server.close();
  });

  it("returns at most 100 persisted messages plus the synthetic system prompt", async () => {
    const server = createHttpServer();
    const store = memoryStoreInstance!;
    const author = store.registerAgent({ ide: "SeederIDE", model: "SeederModel" });
    const created = store.createThread("Bus Connect History Limit", undefined, undefined, {
      creatorAdminId: author.id,
      creatorAdminName: author.display_name || author.name,
      applySystemPromptContentFilter: false
    });

    const originalRateLimitEnabled = process.env.AGENTCHATBUS_RATE_LIMIT_ENABLED;
    process.env.AGENTCHATBUS_RATE_LIMIT_ENABLED = "false";
    try {
      for (let i = 1; i <= 105; i++) {
        const sync = store.issueSyncContext(created.thread.id, author.id, "msg_wait");
        store.postMessage({
          threadId: created.thread.id,
          author: author.id,
          content: `seed message ${i}`,
          expectedLastSeq: sync.current_seq,
          replyToken: sync.reply_token,
          role: "assistant"
        });
      }
    } finally {
      if (originalRateLimitEnabled === undefined) {
        delete process.env.AGENTCHATBUS_RATE_LIMIT_ENABLED;
      } else {
        process.env.AGENTCHATBUS_RATE_LIMIT_ENABLED = originalRateLimitEnabled;
      }
    }

    const res = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: {
            thread_name: "Bus Connect History Limit",
            ide: "JoinerIDE",
            model: "JoinerModel"
          }
        }
      }
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.json().result[0].text);
    expect(payload.current_seq).toBe(105);
    expect(payload.messages).toHaveLength(101);
    expect(payload.messages[0].seq).toBe(0);
    expect(payload.messages[1].seq).toBe(1);
    expect(payload.messages[100].seq).toBe(100);
    expect(payload.messages.some((msg: { seq: number }) => msg.seq === 101)).toBe(false);

    await server.close();
  });

  it("passes explicit emoji to new agent on bus_connect", async () => {
    const server = createHttpServer();

    const res = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: {
            thread_name: "Emoji Bus Connect",
            ide: "EmojiIDE",
            model: "EmojiModel",
            emoji: "🦊"
          }
        }
      }
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.json().result[0].text);
    expect(payload.agent.registered).toBe(true);

    const agentRes = await server.inject({
      method: "GET",
      url: `/api/agents/${payload.agent.agent_id}`
    });
    expect(agentRes.statusCode).toBe(200);
    expect(agentRes.json().emoji).toBe("🦊");

    await server.close();
  });

  it("ignores emoji on bus_connect resume path", async () => {
    const server = createHttpServer();

    const regRes = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: {
            thread_name: "Emoji Resume Test",
            ide: "TestIDE",
            model: "TestModel",
            emoji: "🦊"
          }
        }
      }
    });
    const first = JSON.parse(regRes.json().result[0].text);
    expect(first.agent.registered).toBe(true);

    const resumeRes = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: {
            thread_name: "Emoji Resume Test",
            agent_id: first.agent.agent_id,
            token: first.agent.token,
            emoji: "🎉"
          }
        }
      }
    });
    const resumed = JSON.parse(resumeRes.json().result[0].text);

    const agentRes = await server.inject({
      method: "GET",
      url: `/api/agents/${first.agent.agent_id}`
    });
    expect(agentRes.json().emoji).toBe("🦊");

    await server.close();
  });
});
