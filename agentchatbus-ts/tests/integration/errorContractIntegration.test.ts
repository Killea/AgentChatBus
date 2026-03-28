import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, memoryStoreInstance } from "../../src/transports/http/server.js";

function parseToolPayload(response: any) {
  const body = response.json();
  return JSON.parse(body[0].text);
}

describe("error contract parity", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("thread_settings_get returns Thread not found for missing thread", async () => {
    const server = createHttpServer();
    const res = await server.inject({
      method: "POST",
      url: "/api/mcp/tool/thread_settings_get",
      payload: { thread_id: "missing-thread-id" }
    });
    const payload = parseToolPayload(res);
    expect(payload.error).toBe("Thread not found");
    await server.close();
  });

  it("agent_heartbeat returns ok=false on invalid credentials", async () => {
    const server = createHttpServer();
    const res = await server.inject({
      method: "POST",
      url: "/api/mcp/tool/agent_heartbeat",
      payload: { agent_id: "missing", token: "bad" }
    });
    const payload = parseToolPayload(res);
    expect(payload.ok).toBe(false);
    await server.close();
  });

  it("agent_unregister returns ok=false on invalid credentials", async () => {
    const server = createHttpServer();
    const res = await server.inject({
      method: "POST",
      url: "/api/mcp/tool/agent_unregister",
      payload: { agent_id: "missing", token: "bad" }
    });
    const payload = parseToolPayload(res);
    expect(payload.ok).toBe(false);
    await server.close();
  });

  it("msg_react returns MESSAGE_NOT_FOUND payload", async () => {
    const server = createHttpServer();
    const res = await server.inject({
      method: "POST",
      url: "/api/mcp/tool/msg_react",
      payload: { message_id: "missing-msg", agent_id: "a1", reaction: "thumbs_up" }
    });
    const payload = parseToolPayload(res);
    expect(payload.error).toBe("MESSAGE_NOT_FOUND");
    expect(payload.message_id).toBe("missing-msg");
    await server.close();
  });

  it("msg_unreact returns removed=false when message is missing", async () => {
    const server = createHttpServer();
    const res = await server.inject({
      method: "POST",
      url: "/api/mcp/tool/msg_unreact",
      payload: { message_id: "missing-msg", agent_id: "a1", reaction: "thumbs_up" }
    });
    const payload = parseToolPayload(res);
    expect(payload.removed).toBe(false);
    expect(payload.message_id).toBe("missing-msg");
    await server.close();
  });

  it("template_create validates id and name with structured error", async () => {
    const server = createHttpServer();
    const res = await server.inject({
      method: "POST",
      url: "/api/mcp/tool/template_create",
      payload: { id: "", name: "" }
    });
    const payload = parseToolPayload(res);
    expect(payload.error).toBe("id and name are required");
    await server.close();
  });

  it("msg_edit requires authenticated agent connection", async () => {
    const authorSessionId = "edit-auth-contract-author";
    const unauthSessionId = "edit-auth-contract-unauth";
    const server = createHttpServer();
    const connect = await server.inject({
      method: "POST",
      url: "/api/mcp/tool/bus_connect",
      headers: { "mcp-session-id": authorSessionId },
      payload: { thread_name: "edit-auth-contract", ide: "VSCode", model: "Test" }
    });
    const connected = parseToolPayload(connect);
    const post = await server.inject({
      method: "POST",
      url: "/api/mcp/tool/msg_post",
      headers: { "mcp-session-id": authorSessionId },
      payload: {
        thread_id: connected.thread.thread_id,
        author: connected.agent.agent_id,
        content: "editable",
        expected_last_seq: connected.current_seq,
        reply_token: connected.reply_token,
        role: "assistant"
      }
    });
    const posted = parseToolPayload(post);

    const edit = await server.inject({
      method: "POST",
      url: "/api/mcp/tool/msg_edit",
      headers: { "mcp-session-id": unauthSessionId },
      payload: { message_id: posted.msg_id, new_content: "tampered" }
    });
    const payload = parseToolPayload(edit);
    expect(payload.error).toBe("AUTHENTICATION_REQUIRED");
    expect(String(payload.detail)).toContain("authenticated agent connection");

    await server.close();
  });
});
