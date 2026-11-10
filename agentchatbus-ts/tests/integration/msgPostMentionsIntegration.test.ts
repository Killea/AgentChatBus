import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callTool } from "../../src/adapters/mcp/tools.js";
import { registerStore } from "../../src/core/services/storeSingleton.js";
import { memoryStore } from "../../src/core/services/memoryStore.js";
import {
  createHttpServer,
  getMemoryStore,
  memoryStoreInstance,
} from "../../src/transports/http/server.js";
import { parseMsgListJson, parseMsgPostResult } from "./helpers/mcpIntegration.js";

type MsgPostPayload = {
  msg_id: string;
  seq: number;
  reply_token?: string;
  current_seq?: number;
};

describe("msg_post mentions integration", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
      return;
    }
    memoryStore.reset();
    registerStore(memoryStore);
  });

  async function createThreadWithCreator() {
    registerStore(memoryStore);
    const agent = memoryStore.registerAgent({ ide: "CLI", model: "mentions-test" });
    const created = await callTool("thread_create", {
      topic: "mentions-thread",
      agent_id: agent.id,
      token: agent.token,
    }) as {
      thread_id: string;
      current_seq: number;
      reply_token: string;
    };
    return {
      agent,
      threadId: created.thread_id,
      current_seq: created.current_seq,
      reply_token: created.reply_token,
    };
  }

  async function postAsAgent(
    threadId: string,
    agent: { id: string; token: string },
    sync: { current_seq: number; reply_token: string },
    extra: Record<string, unknown>,
  ) {
    return parseMsgPostResult<MsgPostPayload>(
      await callTool("msg_post", {
        thread_id: threadId,
        agent_id: agent.id,
        token: agent.token,
        author: agent.id,
        content: "message body",
        expected_last_seq: sync.current_seq,
        reply_token: sync.reply_token,
        ...extra,
      }),
    );
  }

  it("stores string mentions from msg_post into metadata for MCP reads", async () => {
    const { agent, threadId, current_seq, reply_token } = await createThreadWithCreator();

    const { msg_id: msgId } = await postAsAgent(
      threadId,
      agent,
      { current_seq, reply_token },
      { content: "ping @agent-x", mentions: ["agent-x", 42] },
    );

    const got = await callTool("msg_get", { message_id: msgId }) as {
      found: boolean;
      message: { metadata?: Record<string, unknown> | null };
    };
    expect(got.found).toBe(true);
    expect(got.message.metadata?.mentions).toEqual(["agent-x"]);

    const listMessages = parseMsgListJson(
      await callTool("msg_list", {
        thread_id: threadId,
        after_seq: 0,
        return_format: "json",
      }),
    );
    const listed = listMessages.find((m) => m.msg_id === msgId);
    expect(listed?.metadata).toMatchObject({ mentions: ["agent-x"] });
  });

  it("drops non-string mentions on REST message POST", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();
    const agent = store.registerAgent({ ide: "CLI", model: "mentions-rest-post" });
    const thread = store.createThread("mentions-rest-post-thread").thread;
    const sync = store.issueSyncContext(thread.id, agent.id, "bootstrap");

    const postResponse = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: { "x-agent-token": agent.token },
      payload: {
        author: agent.id,
        content: "hello with mentions",
        expected_last_seq: sync.current_seq,
        reply_token: sync.reply_token,
        mentions: ["agent-a", 99, null, "agent-b"],
      },
    });
    expect(postResponse.statusCode).toBe(201);
    const posted = postResponse.json() as { id: string; metadata?: Record<string, unknown> | null };
    expect(posted.metadata?.mentions).toEqual(["agent-a", "agent-b"]);

    const got = await callTool("msg_get", { message_id: posted.id }) as {
      found: boolean;
      message: { metadata?: Record<string, unknown> | null };
    };
    expect(got.found).toBe(true);
    expect(got.message.metadata?.mentions).toEqual(["agent-a", "agent-b"]);
    await server.close();
  });

  it("exposes MCP-posted mentions on REST message list", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();
    const agent = store.registerAgent({ ide: "CLI", model: "mentions-rest" });
    const created = await callTool("thread_create", {
      topic: "mentions-rest-thread",
      agent_id: agent.id,
      token: agent.token,
    }) as {
      thread_id: string;
      current_seq: number;
      reply_token: string;
    };
    const { msg_id: msgId } = await postAsAgent(
      created.thread_id,
      agent,
      { current_seq: created.current_seq, reply_token: created.reply_token },
      { content: "ping @agent-x via mcp", mentions: ["agent-x", 42] },
    );
    const listResponse = await server.inject({
      method: "GET",
      url: `/api/threads/${created.thread_id}/messages`,
      query: { after_seq: "0", limit: "50" },
    });
    expect(listResponse.statusCode).toBe(200);
    const body = listResponse.json() as Array<{ id: string; metadata?: Record<string, unknown> | null }>;
    const row = body.find((m) => m.id === msgId);
    expect(row?.metadata?.mentions).toEqual(["agent-x"]);
    await server.close();
  });

  it("leaves metadata unchanged when mentions are omitted", async () => {
    const { agent, threadId, current_seq, reply_token } = await createThreadWithCreator();

    const barePost = await postAsAgent(
      threadId,
      agent,
      { current_seq, reply_token },
      { content: "no metadata" },
    );
    const bareGet = await callTool("msg_get", { message_id: barePost.msg_id }) as {
      found: boolean;
      message: { metadata?: Record<string, unknown> | null };
    };
    expect(bareGet.found).toBe(true);
    expect(bareGet.message.metadata).toBeNull();

    const metaPost = await postAsAgent(
      threadId,
      agent,
      {
        current_seq: barePost.current_seq ?? barePost.seq,
        reply_token: barePost.reply_token as string,
      },
      { content: "with kind only", metadata: { kind: "note" } },
    );
    const metaGet = await callTool("msg_get", { message_id: metaPost.msg_id }) as {
      found: boolean;
      message: { metadata?: Record<string, unknown> | null };
    };
    expect(metaGet.message.metadata).toEqual({ kind: "note" });
  });
});
