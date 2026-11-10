import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";
import { callMcpTool, listMessagesJson } from "./helpers/mcpIntegration.js";

describe("agent display_name integration", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("uses user display_name for author_name on posts when emoji auto name exists", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();

    const connected = await callMcpTool(server, "bus_connect", {
      thread_name: "display-name-post",
      ide: "TestIDE",
      model: "TestModel",
      display_name: "Atlas",
    });
    const threadId = String(connected.thread.thread_id);
    const agentId = String(connected.agent.agent_id);
    const token = String(connected.agent.token);

    const agent = store.getAgent(agentId);
    expect(agent?.display_name).toBe("Atlas");
    expect(agent?.alias_source).toBe("user");
    expect(String(agent?.emoji || "").length).toBeGreaterThan(0);

    const post = await callMcpTool(server, "msg_post", {
      thread_id: threadId,
      author: agentId,
      content: "hello from atlas",
      expected_last_seq: Number(connected.current_seq),
      reply_token: String(connected.reply_token),
    });
    const msgId = String(post.msg_id);

    const listed = await listMessagesJson(server, threadId);
    const row = listed.find((m) => m.msg_id === msgId);
    expect(row?.author_name).toBe("Atlas");

    const stored = store.getMessage(msgId);
    expect(stored?.author_name).toBe("Atlas");

    const getRes = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "msg_get",
          arguments: { message_id: msgId },
        },
      },
    });
    expect(getRes.statusCode).toBe(200);
    const getPayload = getRes.json().result as { found: boolean; message?: { author_name?: string } };
    expect(getPayload?.found).toBe(true);
    expect(getPayload.message?.author_name).toBe("Atlas");

    await server.close();
  });

  it("keeps auto display name when no user display_name is supplied", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();

    const connected = await callMcpTool(server, "bus_connect", {
      thread_name: "auto-display-name",
      ide: "TestIDE",
      model: "AutoModel",
    });
    const threadId = String(connected.thread.thread_id);
    const agentId = String(connected.agent.agent_id);
    const autoDisplayName = String(store.getAgent(agentId)?.display_name || "");

    expect(autoDisplayName).toBeTruthy();
    expect(store.getAgent(agentId)?.alias_source).toBe("auto");

    const post = await callMcpTool(server, "msg_post", {
      thread_id: threadId,
      author: agentId,
      content: "auto name post",
      expected_last_seq: Number(connected.current_seq),
      reply_token: String(connected.reply_token),
    });

    const listed = await listMessagesJson(server, threadId);
    const row = listed.find((m) => m.msg_id === String(post.msg_id));
    expect(row?.author_name).toBe(autoDisplayName);

    const getRes = await server.inject({
      method: "POST",
      url: "/mcp/messages/",
      payload: {
        method: "tools/call",
        params: {
          name: "msg_get",
          arguments: { message_id: String(post.msg_id) },
        },
      },
    });
    expect(getRes.statusCode).toBe(200);
    const getPayload = getRes.json().result as { found: boolean; message?: { author_name?: string } };
    expect(getPayload?.found).toBe(true);
    expect(getPayload.message?.author_name).toBe(autoDisplayName);

    await server.close();
  });

  it("bus_connect resume updates display_name and returns it on the agent payload", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();

    const first = await callMcpTool(server, "bus_connect", {
      thread_name: "resume-rename",
      ide: "TestIDE",
      model: "ResumeModel",
      display_name: "Atlas",
    });
    const threadId = String(first.thread.thread_id);
    const agentId = String(first.agent.agent_id);
    const token = String(first.agent.token);
    const beforeRename = await callMcpTool(server, "msg_post", {
      thread_id: threadId,
      author: agentId,
      content: "before rename",
      expected_last_seq: Number(first.current_seq),
      reply_token: String(first.reply_token),
    });
    const beforeMsgId = String(beforeRename.msg_id);
    const beforeAuthorName = String(store.getMessage(beforeMsgId)?.author_name);

    const resumed = await callMcpTool(server, "bus_connect", {
      thread_name: "resume-rename",
      agent_id: agentId,
      token,
      display_name: "Atlas 2",
    });

    expect(resumed.agent.display_name).toBe("Atlas 2");
    expect(store.getAgent(agentId)?.display_name).toBe("Atlas 2");
    expect(store.getAgent(agentId)?.alias_source).toBe("user");

    const sync = await callMcpTool(server, "msg_post", {
      thread_id: threadId,
      author: agentId,
      content: "after rename",
      expected_last_seq: Number(resumed.current_seq),
      reply_token: String(resumed.reply_token),
    });

    const listed = await listMessagesJson(server, threadId);
    const afterRow = listed.find((m) => m.msg_id === String(sync.msg_id));
    expect(afterRow?.author_name).toBe("Atlas 2");

    const beforeRow = listed.find((m) => m.msg_id === beforeMsgId);
    expect(beforeRow?.author_name).toBe(beforeAuthorName);
    expect(beforeRow?.author_name).not.toBe("Atlas 2");

    await server.close();
  });

  it("ignores whitespace-only display_name on bus_connect resume", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();

    const first = await callMcpTool(server, "bus_connect", {
      thread_name: "whitespace-resume",
      ide: "TestIDE",
      model: "WsModel",
      display_name: "Atlas",
    });
    const agentId = String(first.agent.agent_id);
    const token = String(first.agent.token);
    const before = String(store.getAgent(agentId)?.display_name);

    const resumed = await callMcpTool(server, "bus_connect", {
      thread_name: "whitespace-resume",
      agent_id: agentId,
      token,
      display_name: "   ",
    });

    expect(resumed.agent.display_name).toBe(before);
    expect(store.getAgent(agentId)?.display_name).toBe(before);

    await server.close();
  });
});
