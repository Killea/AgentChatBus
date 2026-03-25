import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callTool } from "../../src/adapters/mcp/tools.js";
import { registerStore } from "../../src/core/services/storeSingleton.js";
import { memoryStore } from "../../src/core/services/memoryStore.js";
import {
  createHttpServer,
  getMemoryStore,
  memoryStoreInstance,
} from "../../src/transports/http/server.js";

describe("close_meeting MCP integration", () => {
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

  it("allows creator admin to close a meeting without a registered session clearer", async () => {
    registerStore(memoryStore);
    const admin = memoryStore.registerAgent({ ide: "CLI", model: "creator-admin" });
    const created = memoryStore.createThread("close-meeting-no-clearer", undefined, undefined, {
      creatorAdminId: admin.id,
      creatorAdminName: admin.display_name || admin.name,
      applySystemPromptContentFilter: false,
    });

    const result = await callTool("close_meeting", {
      thread_id: created.thread.id,
      agent_id: admin.id,
      token: admin.token,
      summary: "finished",
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      thread_id: created.thread.id,
      status: "closed",
      already_closed: false,
      closed_sessions_count: 0,
    });
    expect(memoryStore.getThread(created.thread.id)?.status).toBe("closed");
    expect(memoryStore.getThread(created.thread.id)?.summary).toBe("finished");
    const messages = memoryStore.getMessages(created.thread.id, 0);
    expect(messages.at(-1)).toMatchObject({
      role: "system",
      author: "system",
      metadata: {
        event: "meeting_closed",
        closed_by_agent_id: admin.id,
        closed_by_name: admin.name,
      },
    });
    expect(String(messages.at(-1)?.content || "")).toContain(`administrator ${admin.name}`);
  });

  it("rejects participants who are not thread administrators", async () => {
    registerStore(memoryStore);
    const admin = memoryStore.registerAgent({ ide: "CLI", model: "creator-admin" });
    const participant = memoryStore.registerAgent({ ide: "CLI", model: "participant" });
    const created = memoryStore.createThread("close-meeting-forbidden", undefined, undefined, {
      creatorAdminId: admin.id,
      creatorAdminName: admin.display_name || admin.name,
      applySystemPromptContentFilter: false,
    });
    memoryStore.addThreadParticipant(created.thread.id, participant.id);

    const result = await callTool("close_meeting", {
      thread_id: created.thread.id,
      agent_id: participant.id,
      token: participant.token,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      error: "FORBIDDEN",
    });
    expect(memoryStore.getThread(created.thread.id)?.status).toBe("discuss");
  });

  it("allows both creator admin and auto-assigned admin to close when they differ", async () => {
    registerStore(memoryStore);
    const creator = memoryStore.registerAgent({ ide: "CLI", model: "creator-admin" });
    const autoAdmin = memoryStore.registerAgent({ ide: "CLI", model: "auto-admin" });
    const created = memoryStore.createThread("close-meeting-admin-union", undefined, undefined, {
      creatorAdminId: creator.id,
      creatorAdminName: creator.display_name || creator.name,
      applySystemPromptContentFilter: false,
    });
    memoryStore.assignAdmin(
      created.thread.id,
      autoAdmin.id,
      autoAdmin.display_name || autoAdmin.name || autoAdmin.id,
    );

    const creatorClose = await callTool("close_meeting", {
      thread_id: created.thread.id,
      agent_id: creator.id,
      token: creator.token,
    }) as Record<string, unknown>;

    expect(creatorClose).toMatchObject({
      ok: true,
      already_closed: false,
    });

    const autoAdminClose = await callTool("close_meeting", {
      thread_id: created.thread.id,
      agent_id: autoAdmin.id,
      token: autoAdmin.token,
    }) as Record<string, unknown>;

    expect(autoAdminClose).toMatchObject({
      ok: true,
      already_closed: true,
    });
  });

  it("returns authentication and not-found errors from close_meeting", async () => {
    registerStore(memoryStore);
    const admin = memoryStore.registerAgent({ ide: "CLI", model: "creator-admin" });
    const created = memoryStore.createThread("close-meeting-errors", undefined, undefined, {
      creatorAdminId: admin.id,
      creatorAdminName: admin.display_name || admin.name,
      applySystemPromptContentFilter: false,
    });

    const missingCreds = await callTool("close_meeting", {
      thread_id: created.thread.id,
      agent_id: admin.id,
    }) as Record<string, unknown>;
    expect(missingCreds).toMatchObject({ error: "AUTHENTICATION_REQUIRED" });

    const invalidCreds = await callTool("close_meeting", {
      thread_id: created.thread.id,
      agent_id: admin.id,
      token: "bad-token",
    }) as Record<string, unknown>;
    expect(invalidCreds).toMatchObject({ error: "AUTHENTICATION_REQUIRED" });

    const notFound = await callTool("close_meeting", {
      thread_id: "missing-thread",
      agent_id: admin.id,
      token: admin.token,
    }) as Record<string, unknown>;
    expect(notFound).toMatchObject({ error: "THREAD_NOT_FOUND" });
  });

  it("shares the human close path for HTTP and MCP by clearing thread CLI sessions first", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();

    const owner = (await server.inject({
      method: "POST",
      url: "/api/agents/register",
      payload: { ide: "browser", model: "owner" },
    })).json() as any;
    const participant = (await server.inject({
      method: "POST",
      url: "/api/agents/register",
      payload: { ide: "CLI", model: "participant", display_name: "Participant" },
    })).json() as any;

    const threadResponse = await server.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "x-agent-token": owner.token },
      payload: { topic: "close-meeting-http-path", creator_agent_id: owner.agent_id },
    });
    expect(threadResponse.statusCode).toBe(201);
    const thread = threadResponse.json() as any;

    const createSessionResponse = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/cli-sessions`,
      headers: { "x-agent-token": owner.token },
      payload: {
        adapter: "cursor",
        mode: "headless",
        prompt: "session to be closed",
        requested_by_agent_id: owner.agent_id,
        participant_agent_id: participant.agent_id,
        participant_display_name: "Participant",
      },
    });
    expect(createSessionResponse.statusCode).toBe(201);

    let sessionsResponse = await server.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/cli-sessions`,
    });
    expect(sessionsResponse.statusCode).toBe(200);
    expect((sessionsResponse.json() as any).sessions).toHaveLength(1);

    const mcpClose = await callTool("close_meeting", {
      thread_id: thread.id,
      agent_id: owner.agent_id,
      token: owner.token,
      summary: "closed from MCP",
    }) as Record<string, unknown>;

    expect(mcpClose).toMatchObject({
      ok: true,
      thread_id: thread.id,
      status: "closed",
      closed_sessions_count: 1,
    });
    const messagesAfterClose = store.getMessages(thread.id, 0);
    expect(messagesAfterClose.at(-1)).toMatchObject({
      role: "system",
      author: "system",
      metadata: {
        event: "meeting_closed",
        closed_by_agent_id: owner.agent_id,
      },
    });

    sessionsResponse = await server.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/cli-sessions`,
    });
    expect(sessionsResponse.statusCode).toBe(200);
    expect((sessionsResponse.json() as any).sessions).toHaveLength(0);

    const httpClose = await server.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/close`,
      payload: { summary: "closed again from HTTP" },
    });
    expect(httpClose.statusCode).toBe(200);
    expect(httpClose.json()).toMatchObject({
      ok: true,
      thread_id: thread.id,
      status: "closed",
      already_closed: true,
      closed_sessions_count: 0,
    });

    expect(store.getThread(thread.id)?.summary).toBe("closed again from HTTP");
    await server.close();
  });
});
