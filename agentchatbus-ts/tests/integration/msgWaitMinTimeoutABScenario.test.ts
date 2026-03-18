import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";

function parseMcpTextPayload(response: { json: () => any }) {
  const result = response.json().result;
  expect(Array.isArray(result)).toBe(true);
  expect(result[0]?.type).toBe("text");
  return JSON.parse(String(result[0].text || "{}"));
}

async function callMcpTool(server: ReturnType<typeof createHttpServer>, name: string, args: Record<string, unknown>) {
  const response = await server.inject({
    method: "POST",
    url: "/mcp/messages/",
    payload: {
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    },
  });
  expect(response.statusCode).toBe(200);
  return parseMcpTextPayload(response);
}

describe("msg_wait minimum timeout (TS-only) with quick-return preserved", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
    // TS-only improvement under test: clamp blocking msg_wait timeout.
    // We use 60ms in tests to model the production 60s policy without slowing CI.
    process.env.AGENTCHATBUS_WAIT_MIN_TIMEOUT_MS = "60";
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("Agent A waits longer than requested short timeout and receives Agent B message posted later", async () => {
    const server = createHttpServer();

    const aConnected = await callMcpTool(server, "bus_connect", {
      thread_name: "ab-min-wait-scenario",
      ide: "VSCode",
      model: "Agent-A",
    });

    const bConnected = await callMcpTool(server, "bus_connect", {
      thread_name: "ab-min-wait-scenario",
      ide: "VSCode",
      model: "Agent-B",
    });

    const threadId = String(aConnected.thread.thread_id);

    const startedAt = Date.now();
    const aWaitPromise = callMcpTool(server, "msg_wait", {
      thread_id: threadId,
      after_seq: Number(aConnected.current_seq),
      agent_id: String(aConnected.agent.agent_id),
      token: String(aConnected.agent.token),
      timeout_ms: 10,
      return_format: "json",
    });

    await new Promise((resolve) => setTimeout(resolve, 40));

    const bPostPayload = await callMcpTool(server, "msg_post", {
      thread_id: threadId,
      author: String(bConnected.agent.agent_id),
      content: "message from agent b after 40ms",
      expected_last_seq: Number(bConnected.current_seq),
      reply_token: String(bConnected.reply_token),
    });
    expect(typeof bPostPayload.msg_id).toBe("string");
    expect(typeof bPostPayload.seq).toBe("number");

    const aWaitPayload = await aWaitPromise;
    const elapsedMs = Date.now() - startedAt;

    expect(Array.isArray(aWaitPayload.messages)).toBe(true);
    expect(aWaitPayload.messages.length).toBeGreaterThan(0);
    expect(String(aWaitPayload.messages[0].content)).toContain("agent b");
    expect(elapsedMs).toBeGreaterThanOrEqual(30);

    await server.close();
  });

  it("keeps quick-return behavior for behind-agent recovery even with short timeout", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();

    const waitingAgent = store.registerAgent({ ide: "VSCode", model: "Wait-Agent" });

    const creator = store.registerAgent({ ide: "VSCode", model: "Creator-Agent" });
    const threadResponse = await server.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "x-agent-token": creator.token },
      payload: { topic: "behind-fast-return", creator_agent_id: creator.id },
    });
    expect(threadResponse.statusCode).toBe(201);
    const thread = threadResponse.json();

    const humanSync = store.issueSyncContext(thread.id, "human");
    const postResponse = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: {
        author: "human",
        content: "seed message",
        expected_last_seq: humanSync.current_seq,
        reply_token: humanSync.reply_token,
      },
    });
    expect(postResponse.statusCode).toBe(201);

    const startedAt = Date.now();
    const waitPayload = await callMcpTool(server, "msg_wait", {
      thread_id: thread.id,
      after_seq: 0,
      agent_id: waitingAgent.id,
      token: waitingAgent.token,
      timeout_ms: 10,
      return_format: "json",
    });
    const elapsedMs = Date.now() - startedAt;

    expect(Array.isArray(waitPayload.messages)).toBe(true);
    expect(waitPayload.messages.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(60);

    await server.close();
  });
});
