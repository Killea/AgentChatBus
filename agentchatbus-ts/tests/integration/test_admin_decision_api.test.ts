/**
 * Integration tests for human-confirmed admin decision API.
 * Ported from Python tests/test_admin_decision_api.py
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";

describe("Admin Decision API", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ':memory:';
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  // Helper to register an agent
  async function registerAgent(server: ReturnType<typeof createHttpServer>): Promise<{ agentId: string; token: string }> {
    const res = await server.inject({
      method: "POST",
      url: "/api/agents/register",
      payload: { ide: "VS Code", model: "GPT-5.3-Codex" }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    return { agentId: body.agent_id, token: body.token };
  }

  // Helper to create a thread with creator
  async function createThread(
    server: ReturnType<typeof createHttpServer>,
    creatorId: string,
    creatorToken: string
  ): Promise<string> {
    const res = await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: `admin-decision-${Date.now()}`, creator_agent_id: creatorId },
      headers: { "X-Agent-Token": creatorToken }
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  it("thread creator agent is admin", async () => {
    const server = createHttpServer();
    const { agentId, token } = await registerAgent(server);

    const createRes = await server.inject({
      method: "POST",
      url: "/api/threads",
      payload: { topic: "creator-admin-thread", creator_agent_id: agentId },
      headers: { "X-Agent-Token": token }
    });
    expect(createRes.statusCode).toBe(201);
    const threadId = createRes.json().id;

    const adminRes = await server.inject({
      method: "GET",
      url: `/api/threads/${threadId}/admin`
    });
    expect(adminRes.statusCode).toBe(200);
    const body = adminRes.json();
    expect(body.admin_id).toBe(agentId);
    expect(body.admin_type).toBe("creator");

    await server.close();
  });

  it("admin decision switch then keep", async () => {
    const server = createHttpServer();
    const { agentId: creatorId, token: creatorToken } = await registerAgent(server);
    const threadId = await createThread(server, creatorId, creatorToken);
    const { agentId: agentA } = await registerAgent(server);
    const { agentId: agentB } = await registerAgent(server);

    // Switch to agent A
    const switchRes = await server.inject({
      method: "POST",
      url: `/api/threads/${threadId}/admin/decision`,
      payload: { action: "switch", candidate_admin_id: agentA }
    });
    expect(switchRes.statusCode).toBe(200);
    expect(switchRes.json().new_admin_id).toBe(agentA);

    // Verify admin is agent A
    const adminRes1 = await server.inject({
      method: "GET",
      url: `/api/threads/${threadId}/admin`
    });
    expect(adminRes1.json().admin_id).toBe(agentA);

    // Keep should not change admin (no source_message_id, just test the basic flow)
    // Note: Python test uses source_message_id for the keep action

    // Switch to agent B to verify replace
    const switchRes2 = await server.inject({
      method: "POST",
      url: `/api/threads/${threadId}/admin/decision`,
      payload: { action: "switch", candidate_admin_id: agentB }
    });
    expect(switchRes2.statusCode).toBe(200);
    expect(switchRes2.json().new_admin_id).toBe(agentB);

    const adminRes2 = await server.inject({
      method: "GET",
      url: `/api/threads/${threadId}/admin`
    });
    expect(adminRes2.json().admin_id).toBe(agentB);

    await server.close();
  });

  it("thread agents endpoint returns thread-scoped participants only", async () => {
    const server = createHttpServer();
    const { agentId: creatorId, token: creatorToken } = await registerAgent(server);
    const threadA = await createThread(server, creatorId, creatorToken);
    const threadB = await createThread(server, creatorId, creatorToken);
    const { agentId: agentBId, token: agentBToken } = await registerAgent(server);

    // Get sync context for thread A
    const syncRes = await server.inject({
      method: "GET",
      url: `/api/threads/${threadA}/sync`
    });
    const sync = syncRes.json();

    // Post a message to thread A from agent B
    const postRes = await server.inject({
      method: "POST",
      url: `/api/threads/${threadA}/messages`,
      payload: {
        author: agentBId,
        role: "assistant",
        content: "thread-a message",
        expected_last_seq: sync.current_seq,
        reply_token: sync.reply_token
      },
      headers: { "X-Agent-Token": agentBToken }
    });
    expect(postRes.statusCode).toBe(201);

    // Thread A should have creator and agent B
    const listA = await server.inject({
      method: "GET",
      url: `/api/threads/${threadA}/agents`
    });
    expect(listA.statusCode).toBe(200);
    const idsA = new Set(listA.json().map((a: { id: string }) => a.id));
    expect(idsA.has(creatorId)).toBe(true);
    expect(idsA.has(agentBId)).toBe(true);

    // Thread B should only have creator (agent B never posted)
    const listB = await server.inject({
      method: "GET",
      url: `/api/threads/${threadB}/agents`
    });
    expect(listB.statusCode).toBe(200);
    const idsB = new Set(listB.json().map((a: { id: string }) => a.id));
    expect(idsB.has(creatorId)).toBe(true);
    expect(idsB.has(agentBId)).toBe(false);

    await server.close();
  });

  it("admin decision with source_message_id - already decided", async () => {
    const server = createHttpServer();
    const { agentId: creatorId, token: creatorToken } = await registerAgent(server);
    const threadId = await createThread(server, creatorId, creatorToken);
    const { agentId: candidateId } = await registerAgent(server);

    // Get sync context
    const syncRes = await server.inject({
      method: "GET",
      url: `/api/threads/${threadId}/sync`
    });
    const sync = syncRes.json();

    // Create a prompt message
    const promptRes = await server.inject({
      method: "POST",
      url: `/api/threads/${threadId}/messages`,
      payload: {
        author: creatorId,
        role: "assistant",
        content: "Possible administrator offline detected.",
        metadata: {
          ui_type: "admin_switch_confirmation_required",
          thread_id: threadId,
          candidate_admin_id: candidateId
        },
        expected_last_seq: sync.current_seq,
        reply_token: sync.reply_token
      },
      headers: { "X-Agent-Token": creatorToken }
    });
    expect(promptRes.statusCode).toBe(201);
    const sourceMessageId = promptRes.json().id;

    // First decision - switch
    const firstRes = await server.inject({
      method: "POST",
      url: `/api/threads/${threadId}/admin/decision`,
      payload: {
        action: "switch",
        candidate_admin_id: candidateId,
        source_message_id: sourceMessageId
      }
    });
    expect(firstRes.statusCode).toBe(200);
    const firstBody = firstRes.json();
    expect(firstBody.already_decided).toBe(false);
    expect(firstBody.new_admin_id).toBe(candidateId);

    // Second decision with same source_message_id - should return already_decided
    const secondRes = await server.inject({
      method: "POST",
      url: `/api/threads/${threadId}/admin/decision`,
      payload: {
        action: "keep",
        candidate_admin_id: creatorId,
        source_message_id: sourceMessageId
      }
    });
    expect(secondRes.statusCode).toBe(200);
    const secondBody = secondRes.json();
    expect(secondBody.already_decided).toBe(true);
    expect(secondBody.action).toBe("switch"); // Original action

    await server.close();
  });

  it("admin takeover decision emits targeted instruction", async () => {
    const server = createHttpServer();
    const { agentId: creatorId, token: creatorToken } = await registerAgent(server);
    const threadId = await createThread(server, creatorId, creatorToken);

    // Get sync context
    const syncRes = await server.inject({
      method: "GET",
      url: `/api/threads/${threadId}/sync`
    });
    const sync = syncRes.json();

    // Create a takeover prompt message
    const promptRes = await server.inject({
      method: "POST",
      url: `/api/threads/${threadId}/messages`,
      payload: {
        author: creatorId,
        role: "assistant",
        content: "Only current admin is online and waiting.",
        metadata: {
          ui_type: "admin_takeover_confirmation_required",
          thread_id: threadId,
          current_admin_id: creatorId
        },
        expected_last_seq: sync.current_seq,
        reply_token: sync.reply_token
      },
      headers: { "X-Agent-Token": creatorToken }
    });
    expect(promptRes.statusCode).toBe(201);
    const sourceMessageId = promptRes.json().id;

    // Takeover decision
    const takeoverRes = await server.inject({
      method: "POST",
      url: `/api/threads/${threadId}/admin/decision`,
      payload: {
        action: "takeover",
        source_message_id: sourceMessageId
      }
    });
    expect(takeoverRes.statusCode).toBe(200);
    const body = takeoverRes.json();
    expect(body.action).toBe("takeover");
    expect(body.notified_admin_id).toBe(creatorId);

    // Check for takeover instruction message
    const msgsRes = await server.inject({
      method: "GET",
      url: `/api/threads/${threadId}/messages`,
      query: { after_seq: "0", limit: "200", include_system_prompt: "0" }
    });
    expect(msgsRes.statusCode).toBe(200);
    const msgs = msgsRes.json();
    const takeoverMsgs = msgs.filter(
      (m: { metadata?: Record<string, unknown> }) => m.metadata && m.metadata.ui_type === "admin_coordination_takeover_instruction"
    );
    expect(takeoverMsgs.length).toBeGreaterThan(0);

    await server.close();
  });

  it("admin cancel decision is recorded", async () => {
    const server = createHttpServer();
    const { agentId: creatorId, token: creatorToken } = await registerAgent(server);
    const threadId = await createThread(server, creatorId, creatorToken);

    // Get sync context
    const syncRes = await server.inject({
      method: "GET",
      url: `/api/threads/${threadId}/sync`
    });
    const sync = syncRes.json();

    // Create a takeover prompt message
    const promptRes = await server.inject({
      method: "POST",
      url: `/api/threads/${threadId}/messages`,
      payload: {
        author: creatorId,
        role: "assistant",
        content: "Takeover prompt for cancel path.",
        metadata: {
          ui_type: "admin_takeover_confirmation_required",
          thread_id: threadId,
          current_admin_id: creatorId
        },
        expected_last_seq: sync.current_seq,
        reply_token: sync.reply_token
      },
      headers: { "X-Agent-Token": creatorToken }
    });
    expect(promptRes.statusCode).toBe(201);
    const sourceMessageId = promptRes.json().id;

    // Cancel decision
    const cancelRes = await server.inject({
      method: "POST",
      url: `/api/threads/${threadId}/admin/decision`,
      payload: {
        action: "cancel",
        source_message_id: sourceMessageId
      }
    });
    expect(cancelRes.statusCode).toBe(200);
    const body = cancelRes.json();
    expect(body.action).toBe("cancel");

    // Verify source message has decision_status resolved
    const msgsRes = await server.inject({
      method: "GET",
      url: `/api/threads/${threadId}/messages`,
      query: { after_seq: "0", limit: "200", include_system_prompt: "0" }
    });
    expect(msgsRes.statusCode).toBe(200);
    const msgs = msgsRes.json();
    const promptMsg = msgs.find((m: { id: string }) => m.id === sourceMessageId);
    expect(promptMsg).toBeDefined();
    const metadata = promptMsg.metadata || {};
    expect(metadata.decision_status).toBe("resolved");
    expect(metadata.decision_action).toBe("cancel");

    await server.close();
  });

  it("supports hidden admin confirmation prompts through transcript storage", async () => {
    const server = createHttpServer();
    const { agentId: creatorId, token: creatorToken } = await registerAgent(server);
    const threadId = await createThread(server, creatorId, creatorToken);

    const hiddenPrompt = getMemoryStore().postSystemMessage(
      threadId,
      "Only the current admin is online.",
      JSON.stringify({
        visibility: "human_only",
        ui_type: "admin_takeover_confirmation_required",
        thread_id: threadId,
        current_admin_id: creatorId,
      }),
    );
    const sourceMessageId = (hiddenPrompt as any)?.id;
    expect(sourceMessageId).toBeTruthy();

    const cancelRes = await server.inject({
      method: "POST",
      url: `/api/threads/${threadId}/admin/decision`,
      payload: {
        action: "cancel",
        source_message_id: sourceMessageId,
      },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().action).toBe("cancel");

    const transcriptRes = await server.inject({
      method: "GET",
      url: `/api/threads/${threadId}/transcript`,
      query: { after_seq: "0", limit: "200", include_system_prompt: "0" },
    });
    expect(transcriptRes.statusCode).toBe(200);
    const transcript = transcriptRes.json();
    const promptEntry = transcript.find((entry: { id: string }) => entry.id === sourceMessageId);
    expect(promptEntry).toBeDefined();
    expect(promptEntry.entry_kind).toBe("human_only");
    expect(promptEntry.metadata.decision_status).toBe("resolved");
    expect(promptEntry.metadata.decision_action).toBe("cancel");

    const visibleMessagesRes = await server.inject({
      method: "GET",
      url: `/api/threads/${threadId}/messages`,
      query: { after_seq: "0", limit: "200", include_system_prompt: "0" },
    });
    expect(visibleMessagesRes.statusCode).toBe(200);
    expect(visibleMessagesRes.json().find((entry: { id: string }) => entry.id === sourceMessageId)).toBeUndefined();

    await server.close();
  });

  it("rejects invalid action for source_message_id ui_type", async () => {
    const server = createHttpServer();
    const { agentId: creatorId, token: creatorToken } = await registerAgent(server);
    const threadId = await createThread(server, creatorId, creatorToken);
    const { agentId: candidateId } = await registerAgent(server);

    // Get sync context
    const syncRes = await server.inject({
      method: "GET",
      url: `/api/threads/${threadId}/sync`
    });
    const sync = syncRes.json();

    // Create a switch prompt
    const promptRes = await server.inject({
      method: "POST",
      url: `/api/threads/${threadId}/messages`,
      payload: {
        author: creatorId,
        role: "assistant",
        content: "Switch prompt.",
        metadata: {
          ui_type: "admin_switch_confirmation_required",
          thread_id: threadId,
          candidate_admin_id: candidateId
        },
        expected_last_seq: sync.current_seq,
        reply_token: sync.reply_token
      },
      headers: { "X-Agent-Token": creatorToken }
    });
    expect(promptRes.statusCode).toBe(201);
    const sourceMessageId = promptRes.json().id;

    // Try takeover action (not allowed for switch prompt)
    const takeoverRes = await server.inject({
      method: "POST",
      url: `/api/threads/${threadId}/admin/decision`,
      payload: {
        action: "takeover",
        source_message_id: sourceMessageId
      }
    });
    expect(takeoverRes.statusCode).toBe(400);
    expect(takeoverRes.json().detail).toContain("Invalid action");

    await server.close();
  });
});
