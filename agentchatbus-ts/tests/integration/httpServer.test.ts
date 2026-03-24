import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";

describe("HTTP compatibility shell", () => {
  async function createAuthedThread(server: ReturnType<typeof createHttpServer>, topic: string) {
    const auth = (await server.inject({
      method: "POST",
      url: "/api/agents/register",
      payload: { ide: "VSCode", model: "test-thread-creator" }
    })).json();
    const threadResponse = await server.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "x-agent-token": auth.token },
      payload: { topic, creator_agent_id: auth.agent_id }
    });
    expect(threadResponse.statusCode).toBe(201);
    return threadResponse.json();
  }

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
    const body = await createAuthedThread(server, "integration-thread");
    expect(body.id).toBeTruthy();
    expect(body.topic).toBe("integration-thread");
    expect(body.current_seq).toBe(0);
    expect(body.reply_token).toBeTruthy();

    await server.close();
  });

  it("posts a message with sync fields", async () => {
    const server = createHttpServer();
    const thread = await createAuthedThread(server, "message-thread");

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
    // Python REST parity: message response uses id/seq fields
    expect(body.id).toBeDefined();
    expect(body.seq).toBeGreaterThan(0);

    await server.close();
  });

  it("includes synthetic system prompt when requested via REST", async () => {
    const server = createHttpServer();
    const auth = (await server.inject({
      method: "POST",
      url: "/api/agents/register",
      payload: { ide: "VSCode", model: "system-prompt-check" }
    })).json();

    const threadResponse = await server.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "x-agent-token": auth.token },
      payload: {
        topic: "rest-system-prompt-thread",
        creator_agent_id: auth.agent_id,
        system_prompt: "Custom prompt from REST test."
      }
    });
    expect(threadResponse.statusCode).toBe(201);
    const thread = threadResponse.json();

    const messagesResponse = await server.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/messages`,
      query: {
        after_seq: "0",
        limit: "50",
        include_system_prompt: "1"
      }
    });

    expect(messagesResponse.statusCode).toBe(200);
    const messages = messagesResponse.json();
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].seq).toBe(0);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("## Section: Thread Create (Provided By Creator)");
    expect(messages[0].content).toContain("Custom prompt from REST test.");

    await server.close();
  });

  it("rejects replayed reply tokens", async () => {
    const server = createHttpServer();
    const thread = await createAuthedThread(server, "replay-thread");

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

  it("rejects cross-agent reply token misuse (Python parity)", async () => {
    const server = createHttpServer();
    // Create thread via HTTP to keep state consistent with the store instance
    const thread = await createAuthedThread(server, "cross-agent-thread");

    // Use the same in-process store instance
    const store = getMemoryStore();
    const agentA = store.registerAgent({ ide: "VSCode", model: "GPT-A" });
    const agentB = store.registerAgent({ ide: "VSCode", model: "GPT-B" });
    const sync = store.issueSyncContext(thread.id, agentA.id, "test");

    // Attempt to use agentA's token with agentB as author -> should be rejected
    const misuse = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: agentB.id,
        content: "cross-agent misuse",
        expected_last_seq: sync.current_seq,
        reply_token: sync.reply_token,
      }
    });

    expect(misuse.statusCode).toBe(400);
    expect(misuse.json().detail.error).toBe("TOKEN_INVALID");

    // Sanity: correct agent should still succeed
    const ok = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: agentA.id,
        content: "legit",
        expected_last_seq: sync.current_seq,
        reply_token: sync.reply_token,
        role: "assistant"
      }
    });
    expect(ok.statusCode).toBe(201);

    await server.close();
  });

  it("auto-issues sync context on REST message post when sync fields are omitted", async () => {
    const server = createHttpServer();
    const thread = await createAuthedThread(server, "rest-auto-sync-thread");

    const response = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: "human",
        content: "rest fallback send"
      }
    });

    expect(response.statusCode).toBe(201);
    // Python REST parity: message response uses id/seq fields
    const body = response.json();
    expect(body.id).toBeDefined();
    expect(body.msg_id).toBeUndefined();
    expect(body.seq).toBeGreaterThan(0);

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

  it("binds CLI sessions to target agents without pre-registering thread participants and restricts stop control to the session owner", async () => {
    const server = createHttpServer();
    const owner = (await server.inject({
      method: "POST",
      url: "/api/agents/register",
      payload: { ide: "browser", model: "human-owner" }
    })).json();
    const participant = (await server.inject({
      method: "POST",
      url: "/api/agents/register",
      payload: { ide: "CLI", model: "codex-worker", display_name: "Codex Worker" }
    })).json();
    const intruder = (await server.inject({
      method: "POST",
      url: "/api/agents/register",
      payload: { ide: "browser", model: "human-intruder" }
    })).json();

    const threadResponse = await server.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "x-agent-token": owner.token },
      payload: { topic: "cli-participant-thread", creator_agent_id: owner.agent_id }
    });
    expect(threadResponse.statusCode).toBe(201);
    const thread = threadResponse.json();

    const createSessionResponse = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/cli-sessions`,
      headers: { "x-agent-token": owner.token },
      payload: {
        adapter: "cursor",
        mode: "headless",
        prompt: "hello from participant",
        requested_by_agent_id: owner.agent_id,
        participant_agent_id: participant.agent_id,
        participant_display_name: "Codex Worker",
      }
    });

    expect(createSessionResponse.statusCode).toBe(201);
    const createSessionBody = createSessionResponse.json();
    expect(createSessionBody.session.participant_agent_id).toBe(participant.agent_id);
    expect(createSessionBody.session.participant_display_name).toBe("Codex Worker");
    expect(createSessionBody.session.mode).toBe("headless");

    const threadAgentsResponse = await server.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/agents`,
    });
    expect(threadAgentsResponse.statusCode).toBe(200);
    const threadAgents = threadAgentsResponse.json();
    expect(Array.isArray(threadAgents)).toBe(true);
    // CLI-invited agents are now automatically added to thread participants
    // to mirror bus_connect semantics and keep thread membership durable
    expect(threadAgents.some((agent: any) => agent.id === participant.agent_id)).toBe(true);

    const forbiddenControl = await server.inject({
      method: "POST",
      url: `/api/cli-sessions/${createSessionBody.session.id}/stop`,
      headers: { "x-agent-token": intruder.token },
      payload: {
        requested_by_agent_id: intruder.agent_id,
      }
    });
    expect(forbiddenControl.statusCode).toBe(403);
    expect(forbiddenControl.json().detail).toContain("session owner");

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

  it("handles MCP resources/list through the HTTP MCP message endpoint", async () => {
    const server = createHttpServer();
    const response = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "resources/list",
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.result.resources)).toBe(true);
    expect(body.result.resources.some((r: { uri: string }) => r.uri === "chat://bus/config")).toBe(true);

    await server.close();
  });

  it("handles MCP prompts/list and prompts/get through the HTTP MCP message endpoint", async () => {
    const server = createHttpServer();
    const listRes = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "prompts/list",
      }
    });

    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    expect(Array.isArray(listBody.result.prompts)).toBe(true);
    expect(listBody.result.prompts.some((p: { name: string }) => p.name === "summarize_thread")).toBe(true);

    const getRes = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "prompts/get",
        params: {
          name: "summarize_thread",
          arguments: { topic: "t1", transcript: "hello world" }
        }
      }
    });

    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json();
    expect(Array.isArray(getBody.result.messages)).toBe(true);
    expect(String(getBody.result.messages[0].content.text)).toContain("hello world");

    await server.close();
  });

  it("handles MCP resources/read through the HTTP MCP message endpoint", async () => {
    const server = createHttpServer();
    const response = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "resources/read",
        params: {
          uri: "chat://bus/config",
        }
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.result.contents)).toBe(true);
    const text = String(body.result.contents[0].text || "");
    expect(text).toContain("AgentChatBus");

    await server.close();
  });

  it("supports msg_wait fast-return through the MCP adapter", async () => {
    const server = createHttpServer();
    const connectResponse = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: { thread_name: "wait-thread", ide: "VSCode", model: "GPT-5.4" }
        }
      }
    });
    
    // Parse MCP response structure: { result: [{ type: "text", text: "{payload}" }] }
    const connectResult = connectResponse.json().result;
    expect(Array.isArray(connectResult)).toBe(true);
    expect(connectResult[0].type).toBe("text");
    const connected = JSON.parse(connectResult[0].text);

    await server.inject({
      method: "POST",
      url: `/api/threads/${connected.thread.thread_id}/messages`,
      payload: {
        author: connected.agent.agent_id,
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
            thread_id: connected.thread.thread_id,
            after_seq: connected.current_seq,  // Use current_seq to check if agent is behind
            agent_id: connected.agent.agent_id,
            token: connected.agent.token,
            timeout_ms: 1000,
            return_format: "json"  // Match Python: use json format for test assertions
          }
        }
      }
    });

    expect(waitResponse.statusCode).toBe(200);
    const waitResult = waitResponse.json().result;
    expect(Array.isArray(waitResult)).toBe(true);
    expect(waitResult[0].type).toBe("text");
    const waitBody = JSON.parse(waitResult[0].text);
    expect(Array.isArray(waitBody.messages)).toBe(true);
    expect(waitBody.messages.length).toBeGreaterThan(0);
    expect(waitBody.reply_token).toBeTruthy();
    expect(connected.agent.is_administrator).toBe(true);

    await server.close();
  });

  it("msg_wait rejects partial explicit credentials", async () => {
    const server = createHttpServer();
    const connectResponse = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: { thread_name: "wait-creds-thread", ide: "VSCode", model: "GPT-5.4" }
        }
      }
    });
    const connected = JSON.parse(connectResponse.json().result[0].text);

    const waitResponse = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "msg_wait",
          arguments: {
            thread_id: connected.thread.thread_id,
            after_seq: connected.current_seq,
            agent_id: connected.agent.agent_id,
            timeout_ms: 1000,
            return_format: "json"
          }
        }
      }
    });

    expect(waitResponse.statusCode).toBe(200);
    const waitResult = waitResponse.json().result;
    expect(Array.isArray(waitResult)).toBe(true);
    const payload = JSON.parse(waitResult[0].text);
    expect(payload.error).toBe("InvalidCredentials");
    expect(String(payload.detail)).toContain("requires both agent_id and token");

    await server.close();
  });

  it("msg_post omits attention fields by default when feature flags are disabled", async () => {
    const server = createHttpServer();
    const connectResponse = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: { thread_name: "attention-default-thread", ide: "VSCode", model: "GPT-5.4" }
        }
      }
    });
    const connected = JSON.parse(connectResponse.json().result[0].text);

    const postResponse = await server.inject({
      method: "POST",
      url: "/api/mcp/tool/msg_post",
      payload: {
        thread_id: connected.thread.thread_id,
        author: connected.agent.agent_id,
        content: "attention test",
        expected_last_seq: connected.current_seq,
        reply_token: connected.reply_token,
        priority: "urgent",
        metadata: {
          handoff_target: "agent-xyz",
          stop_reason: "timeout"
        }
      }
    });

    expect(postResponse.statusCode).toBe(200);
    const body = postResponse.json();
    const payload = JSON.parse(body[0].text);
    expect(payload.priority).toBeUndefined();
    expect(payload.handoff_target).toBeUndefined();
    expect(payload.stop_reason).toBeUndefined();

    await server.close();
  });

  it("surfaces waiting agents in thread listing", async () => {
    const server = createHttpServer();
    const connectResponse = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: { thread_name: "waiting-thread", ide: "VSCode", model: "GPT-5.4" }
        }
      }
    });
    
    // Parse MCP response structure: { result: [{ type: "text", text: "{payload}" }] }
    const connectResult = connectResponse.json().result;
    expect(Array.isArray(connectResult)).toBe(true);
    expect(connectResult[0].type).toBe("text");
    const connected = JSON.parse(connectResult[0].text);

    // Start msg_wait in background (don't await it) so we can check waiting_agents during the wait
    const waitPromise = server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "msg_wait",
          arguments: {
            thread_id: connected.thread.thread_id,
            after_seq: connected.current_seq,
            agent_id: connected.agent.agent_id,
            token: connected.agent.token,
            timeout_ms: 2000  // Reasonable timeout
          }
        }
      }
    });

    // Give msg_wait time to register the waiting state
    await new Promise(resolve => setTimeout(resolve, 50));

    // Check waiting_agents while msg_wait is still running
    // Give more time for msg_wait to actually enter the waiting state
    await new Promise(resolve => setTimeout(resolve, 200));

    const threadsResponse = await server.inject({
      method: "GET",
      url: "/api/threads"
    });
    expect(threadsResponse.statusCode).toBe(200);
    const list = threadsResponse.json().threads;
    const thread = list.find((item: { id: string }) => item.id === connected.thread.thread_id);
    expect(Array.isArray(thread.waiting_agents)).toBe(true);
    expect(thread.waiting_agents.length).toBe(1);

    // Wait for the background msg_wait to complete before closing server
    await waitPromise;
    await server.close();
  });

  it("clears expired waiting agents from thread listing", async () => {
    const server = createHttpServer();
    const connectResponse = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: { thread_name: "expired-wait-thread", ide: "VSCode", model: "GPT-5.4" }
        }
      }
    });
    
    // Parse MCP response structure: { result: [{ type: "text", text: "{payload}" }] }
    const connectResult = connectResponse.json().result;
    expect(Array.isArray(connectResult)).toBe(true);
    expect(connectResult[0].type).toBe("text");
    const connected = JSON.parse(connectResult[0].text);

    await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "msg_wait",
          arguments: {
            thread_id: connected.thread.thread_id,
            after_seq: connected.current_seq,
            agent_id: connected.agent.agent_id,
            token: connected.agent.token,
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
    const thread = list.find((item: { id: string }) => item.id === connected.thread.thread_id);
    expect(thread.waiting_agents.length).toBe(0);

    await server.close();
  });

  it("supports message edit history and reactions", async () => {
    const server = createHttpServer();
    const thread = await createAuthedThread(server, "reaction-thread");

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

    // Python REST parity: message response uses id
    const messageId = message.id;
    expect(messageId).toBeDefined();

    const editResponse = await server.inject({
      method: "PUT",
      url: `/api/messages/${messageId}`,
      payload: { new_content: "edited" }
    });
    expect(editResponse.statusCode).toBe(200);

    const reactResponse = await server.inject({
      method: "POST",
      url: `/api/messages/${messageId}/reactions`,
      payload: { agent_id: "tester", reaction: "agree" }
    });
    expect(reactResponse.statusCode).toBe(201);

    const historyResponse = await server.inject({
      method: "GET",
      url: `/api/messages/${messageId}/history`
    });
    expect(historyResponse.statusCode).toBe(200);
    expect(Array.isArray(historyResponse.json().edits)).toBe(true);
    expect(historyResponse.json().edits.length).toBe(1);

    const getReactionsResponse = await server.inject({
      method: "GET",
      url: `/api/messages/${messageId}/reactions`
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
    // is_owner is only true when AGENTCHATBUS_OWNER_BOOT_TOKEN is set and claimed
    // Without boot token, ownership_assignable is false, so no one becomes owner
    expect(statusResponse.json().is_owner).toBe(false);

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

    const thread = await createAuthedThread(server, "sse-thread");

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

  it("serves the standard Streamable HTTP MCP endpoint on /mcp", async () => {
    const server = createHttpServer();
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.addresses()[0];
    const baseUrl = `http://${address.address}:${address.port}`;

    const initializeResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "vitest", version: "1.0.0" },
        },
      }),
    });

    expect(initializeResponse.ok).toBe(true);
    expect(initializeResponse.headers.get("content-type")).toContain("text/event-stream");
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const initReader = initializeResponse.body?.getReader();
    const initChunk = await initReader!.read();
    const initText = new TextDecoder().decode(initChunk.value);
    expect(initText).toContain('"protocolVersion":"2025-03-26"');
    await initReader?.cancel();

    const streamResponse = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "mcp-session-id": sessionId!,
      },
    });

    expect(streamResponse.ok).toBe(true);
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
    await streamResponse.body?.cancel();
    await server.close();
  });

  it("serves the deprecated SSE fallback transport on /sse and /messages", async () => {
    const server = createHttpServer();
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.addresses()[0];
    const baseUrl = `http://${address.address}:${address.port}`;

    const sseResponse = await fetch(`${baseUrl}/sse`, {
      headers: {
        accept: "text/event-stream",
      },
    });

    expect(sseResponse.ok).toBe(true);
    expect(sseResponse.headers.get("content-type")).toContain("text/event-stream");

    const reader = sseResponse.body?.getReader();
    const firstChunk = await reader!.read();
    const firstText = new TextDecoder().decode(firstChunk.value);
    expect(firstText).toContain("event: endpoint");
    expect(firstText).toContain("/messages?sessionId=");

    await reader?.cancel();
    await server.close();
  });
});
