import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";

describe("HTTP compatibility shell", () => {
  // Set test database to use in-memory database
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ':memory:';
  });

  beforeEach(() => {
    // Reset the global memory store instance for each test
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("creates a thread and returns initial sync context", async () => {
    const server = createHttpServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "integration-thread" }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBeTruthy();
    expect(body.topic).toBe("integration-thread");
    expect(body.current_seq).toBe(0);
    expect(body.reply_token).toBeTruthy();

    await server.close();
  });

  it("posts a message with sync fields", async () => {
    const server = createHttpServer();
    const threadResponse = await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "message-thread" }
    });
    const thread = threadResponse.json();

    const messageResponse = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: "human",
        content: "hello",
        expected_last_seq: thread.current_seq,
        reply_token: thread.reply_token
      }
    });

    expect(messageResponse.statusCode).toBe(201);
    const body = messageResponse.json();
    expect(body.thread_id).toBe(thread.id);
    expect(body.content).toBe("hello");
    expect(body.seq).toBeGreaterThan(0);

    await server.close();
  });

  it("rejects replayed reply tokens", async () => {
    const server = createHttpServer();
    const thread = (await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "replay-thread" }
    })).json();

    const first = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: "human",
        content: "first",
        expected_last_seq: thread.current_seq,
        reply_token: thread.reply_token
      }
    });
    expect(first.statusCode).toBe(201);

    const second = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: "human",
        content: "second",
        expected_last_seq: first.json().seq,
        reply_token: thread.reply_token
      }
    });

    expect(second.statusCode).toBe(400);
    expect(second.json().detail.error).toBe("TOKEN_REPLAY");

    await server.close();
  });

  it("auto-issues sync context on REST message post when sync fields are omitted", async () => {
    const server = createHttpServer();
    const thread = (await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "rest-auto-sync-thread" }
    })).json();

    const response = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: "human",
        content: "rest fallback send"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().content).toBe("rest fallback send");

    await server.close();
  });

  it("registers and lists agents", async () => {
    const server = createHttpServer();
    const registerResponse = await server.inject({
      method: "POST",
      url: "/api/agents/register",
      payload: { ide: "VSCode", model: "GPT-5.4" }
    });

    expect(registerResponse.statusCode).toBe(200);
    const registerBody = registerResponse.json();
    expect(registerBody.agent_id).toBeTruthy();
    expect(registerBody.token).toBeTruthy();

    const listResponse = await server.inject({
      method: "GET",
      url: "/api/agents"
    });

    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json();
    expect(Array.isArray(listBody)).toBe(true);
    expect(listBody.length).toBeGreaterThan(0);

    await server.close();
  });

  it("uploads an image and returns a data URL", async () => {
    const server = createHttpServer();
    const boundary = "----agentchatbus-boundary";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="file"; filename="demo.txt"\r\n'),
      Buffer.from('Content-Type: text/plain\r\n\r\n'),
      Buffer.from("demo-data"),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const response = await server.inject({
      method: "POST",
      url: "/api/upload/image",
      payload,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.name).toBe("demo.txt");
    expect(String(body.url)).toContain("data:text/plain;base64,");

    await server.close();
  });

  it("lists MCP tools through the HTTP MCP message endpoint", async () => {
    const server = createHttpServer();
    const response = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/list"
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.result)).toBe(true);
    expect(body.result.some((tool: { name: string }) => tool.name === "bus_connect")).toBe(true);

    await server.close();
  });

  it("calls an MCP tool through the HTTP MCP message endpoint", async () => {
    const server = createHttpServer();
    const response = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_get_config",
          arguments: {}
        }
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.result.preferred_language).toBe("English");

    await server.close();
  });

  it("supports msg_wait fast-return through the MCP adapter", async () => {
    const server = createHttpServer();
    const connected = (await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: { thread_name: "wait-thread", ide: "VSCode", model: "GPT-5.4" }
        }
      }
    })).json().result;

    await server.inject({
      method: "POST",
      url: `/api/threads/${connected.thread.id}/messages`,
      payload: {
        author: connected.agent.id,
        content: "message before wait",
        expected_last_seq: connected.current_seq,
        reply_token: connected.reply_token
      }
    });

    const waitResponse = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "msg_wait",
          arguments: {
            thread_id: connected.thread.id,
            after_seq: 0,
            agent_id: connected.agent.id,
            timeout_ms: 1000
          }
        }
      }
    });

    expect(waitResponse.statusCode).toBe(200);
    const waitBody = waitResponse.json().result;
    expect(Array.isArray(waitBody.messages)).toBe(true);
    expect(waitBody.messages.length).toBeGreaterThan(0);
    expect(waitBody.reply_token).toBeTruthy();
    expect(connected.agent.is_administrator).toBe(true);

    await server.close();
  });

  it("surfaces waiting agents in thread listing", async () => {
    const server = createHttpServer();
    const connected = (await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: { thread_name: "waiting-thread", ide: "VSCode", model: "GPT-5.4" }
        }
      }
    })).json().result;

    await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "msg_wait",
          arguments: {
            thread_id: connected.thread.id,
            after_seq: connected.current_seq,
            agent_id: connected.agent.id,
            timeout_ms: 1000
          }
        }
      }
    });

    const threadsResponse = await server.inject({
      method: "GET",
      url: "/api/threads"
    });
    expect(threadsResponse.statusCode).toBe(200);
    const list = threadsResponse.json().threads;
    const thread = list.find((item: { id: string }) => item.id === connected.thread.id);
    expect(Array.isArray(thread.waiting_agents)).toBe(true);
    expect(thread.waiting_agents.length).toBe(1);

    await server.close();
  });

  it("clears expired waiting agents from thread listing", async () => {
    const server = createHttpServer();
    const connected = (await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: { thread_name: "expired-wait-thread", ide: "VSCode", model: "GPT-5.4" }
        }
      }
    })).json().result;

    await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "msg_wait",
          arguments: {
            thread_id: connected.thread.id,
            after_seq: connected.current_seq,
            agent_id: connected.agent.id,
            timeout_ms: 1
          }
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const threadsResponse = await server.inject({
      method: "GET",
      url: "/api/threads"
    });
    const list = threadsResponse.json().threads;
    const thread = list.find((item: { id: string }) => item.id === connected.thread.id);
    expect(thread.waiting_agents.length).toBe(0);

    await server.close();
  });

  it("supports message edit history and reactions", async () => {
    const server = createHttpServer();
    const thread = (await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "reaction-thread" }
    })).json();

    const message = (await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: "human",
        content: "initial",
        expected_last_seq: thread.current_seq,
        reply_token: thread.reply_token
      }
    })).json();

    const editResponse = await server.inject({
      method: "PUT",
      url: `/api/messages/${message.id}`,
      payload: { new_content: "edited" }
    });
    expect(editResponse.statusCode).toBe(200);
    expect(editResponse.json().content).toBe("edited");

    const reactResponse = await server.inject({
      method: "POST",
      url: `/api/messages/${message.id}/reactions`,
      payload: { agent_id: "tester", reaction: "agree" }
    });
    expect(reactResponse.statusCode).toBe(201);

    const historyResponse = await server.inject({
      method: "GET",
      url: `/api/messages/${message.id}/history`
    });
    expect(historyResponse.statusCode).toBe(200);
    expect(Array.isArray(historyResponse.json().edits)).toBe(true);
    expect(historyResponse.json().edits.length).toBe(1);

    const getReactionsResponse = await server.inject({
      method: "GET",
      url: `/api/messages/${message.id}/reactions`
    });
    expect(getReactionsResponse.statusCode).toBe(200);
    expect(getReactionsResponse.json().reactions.length).toBe(1);

    await server.close();
  });

  it("supports agent register, resume, update, and kick flows", async () => {
    const server = createHttpServer();

    const register = (await server.inject({
      method: "POST",
      url: "/api/agents/register",
      payload: { ide: "VSCode", model: "GPT-5.4", description: "demo" }
    })).json();

    const resumeResponse = await server.inject({
      method: "POST",
      url: "/api/agents/resume",
      payload: { agent_id: register.agent_id, token: register.token }
    });
    expect(resumeResponse.statusCode).toBe(200);
    expect(resumeResponse.json().ok).toBe(true);

    const updateResponse = await server.inject({
      method: "PUT",
      url: `/api/agents/${register.agent_id}`,
      payload: { token: register.token, display_name: "Renamed Agent" }
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().display_name).toBe("Renamed Agent");

    const kickResponse = await server.inject({
      method: "POST",
      url: `/api/agents/${register.agent_id}/kick`
    });
    expect(kickResponse.statusCode).toBe(200);
    expect(kickResponse.json().ok).toBe(true);

    await server.close();
  });

  it("supports IDE register, status, heartbeat, and unregister flows", async () => {
    const server = createHttpServer();

    const register = (await server.inject({
      method: "POST",
      url: "/api/ide/register",
      payload: { instance_id: "ide-1", ide_label: "VSCode" }
    })).json();

    expect(register.registered).toBe(true);
    expect(register.session_token).toBeTruthy();

    const statusResponse = await server.inject({
      method: "GET",
      url: `/api/ide/status?instance_id=ide-1&session_token=${register.session_token}`
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json().is_owner).toBe(true);

    const heartbeatResponse = await server.inject({
      method: "POST",
      url: "/api/ide/heartbeat",
      payload: { instance_id: "ide-1", session_token: register.session_token }
    });
    expect(heartbeatResponse.statusCode).toBe(200);
    expect(heartbeatResponse.json().registered).toBe(true);

    const unregisterResponse = await server.inject({
      method: "POST",
      url: "/api/ide/unregister",
      payload: { instance_id: "ide-1", session_token: register.session_token }
    });
    expect(unregisterResponse.statusCode).toBe(200);
    expect(unregisterResponse.json().registered).toBe(false);

    await server.close();
  });

  it("streams msg.new events over /events", async () => {
    const server = createHttpServer();
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.addresses()[0];
    const baseUrl = `http://${address.address}:${address.port}`;

    const response = await fetch(`${baseUrl}/events`);
    expect(response.ok).toBe(true);
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();

    const firstChunk = await reader!.read();
    const firstText = new TextDecoder().decode(firstChunk.value);
    expect(firstText).toContain("connected");

    const thread = (await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "sse-thread" }
    })).json();

    await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: "human",
        content: "sse message",
        expected_last_seq: thread.current_seq,
        reply_token: thread.reply_token
      }
    });

    let sawMsgNew = false;
    for (let index = 0; index < 5; index += 1) {
      const nextChunk = await reader!.read();
      const nextText = new TextDecoder().decode(nextChunk.value);
      if (nextText.includes("msg.new")) {
        sawMsgNew = true;
        break;
      }
    }
    expect(sawMsgNew).toBe(true);

    await reader?.cancel();
    await server.close();
  });
});
