import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";

describe("thread restart integration", () => {
  async function registerAgent(
    server: ReturnType<typeof createHttpServer>,
    payload: Record<string, unknown>,
  ) {
    const response = await server.inject({
      method: "POST",
      url: "/api/agents/register",
      payload,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Record<string, any>;
  }

  async function createThread(
    server: ReturnType<typeof createHttpServer>,
    owner: Record<string, any>,
    topic: string,
    workspace: string,
  ) {
    const response = await server.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "x-agent-token": owner.token },
      payload: {
        topic,
        creator_agent_id: owner.agent_id,
        workspace,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as Record<string, any>;
  }

  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("restarts a thread with new agent identities and removes old thread records", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();
    const workspace = await mkdtemp(join(tmpdir(), "acb-restart-success-"));

    try {
      await mkdir(join(workspace, ".git"));
      await writeFile(join(workspace, "stale.txt"), "stale");

      const owner = await registerAgent(server, { ide: "browser", model: "owner" });
      const participant = await registerAgent(server, {
        ide: "CLI",
        model: "restart-worker",
        display_name: "Restart Worker",
        emoji: "🦊",
      });

      const thread = await createThread(server, owner, "restart-success", workspace);
      const settingsResponse = await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/settings`,
        payload: {
          timeout_seconds: 95,
          switch_timeout_seconds: 130,
        },
      });
      expect(settingsResponse.statusCode).toBe(200);

      const createSessionResponse = await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/cli-sessions`,
        headers: { "x-agent-token": owner.token },
        payload: {
          adapter: "cursor",
          mode: "headless",
          prompt: "EXACT RESTART PROMPT",
          initial_instruction: "Investigate the repo and rebuild cleanly.",
          reentry_prompt_override: "Wake back into the restarted thread.",
          requested_by_agent_id: owner.agent_id,
          participant_agent_id: participant.agent_id,
          participant_display_name: "Restart Worker",
        },
      });
      expect(createSessionResponse.statusCode).toBe(201);

      const messageResponse = await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/messages`,
        payload: {
          author: "human",
          content: "this run was not good enough",
          expected_last_seq: thread.current_seq,
          reply_token: thread.reply_token,
        },
      });
      expect(messageResponse.statusCode).toBe(201);
      const message = messageResponse.json() as Record<string, any>;

      const editResponse = await server.inject({
        method: "PUT",
        url: `/api/messages/${message.id}`,
        payload: {
          new_content: "this run was definitely not good enough",
          edited_by: "human",
        },
      });
      expect(editResponse.statusCode).toBe(200);

      const reactionResponse = await server.inject({
        method: "POST",
        url: `/api/messages/${message.id}/reactions`,
        payload: {
          agent_id: owner.agent_id,
          reaction: "thumbs-up",
        },
      });
      expect(reactionResponse.statusCode).toBe(201);

      store.setRefreshRequest(thread.id, participant.agent_id, "restart-check");

      const restartResponse = await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/restart`,
        headers: { "x-agent-token": owner.token },
        payload: {
          requested_by_agent_id: owner.agent_id,
          clear_workspace: false,
        },
      });

      expect(restartResponse.statusCode).toBe(200);
      const restartBody = restartResponse.json() as Record<string, any>;
      expect(restartBody.ok).toBe(true);
      expect(restartBody.old_thread_id).toBe(thread.id);
      expect(restartBody.restarted_agents_count).toBe(1);
      expect(restartBody.new_thread.id).not.toBe(thread.id);
      expect(restartBody.new_thread.topic).toBe("restart-success");
      expect(restartBody.workspace_cleanup.mode).toBe("skipped");

      const newThreadId = String(restartBody.new_thread.id);
      expect(store.getThread(thread.id)).toBeUndefined();
      expect(store.getAgent(participant.agent_id)).toBeUndefined();
      expect(existsSync(join(workspace, "stale.txt"))).toBe(true);

      const newSettings = store.getThreadSettings(newThreadId);
      expect(newSettings?.timeout_seconds).toBe(95);
      expect(newSettings?.switch_timeout_seconds).toBe(130);

      const newAgentsResponse = await server.inject({
        method: "GET",
        url: `/api/threads/${newThreadId}/agents`,
      });
      expect(newAgentsResponse.statusCode).toBe(200);
      const newAgents = newAgentsResponse.json() as Array<Record<string, any>>;
      expect(newAgents).toHaveLength(1);
      expect(newAgents[0].id).not.toBe(participant.agent_id);
      expect(newAgents[0].display_name).toBe("Restart Worker");

      const newSessionsResponse = await server.inject({
        method: "GET",
        url: `/api/threads/${newThreadId}/cli-sessions`,
      });
      expect(newSessionsResponse.statusCode).toBe(200);
      const newSessions = (newSessionsResponse.json() as { sessions: Array<Record<string, any>> }).sessions;
      expect(newSessions).toHaveLength(1);
      expect(newSessions[0].prompt).toBe("EXACT RESTART PROMPT");
      expect(newSessions[0].reentry_prompt_override).toBe("Wake back into the restarted thread.");

      const db = (store as any).persistenceDb;
      const editCount = db.prepare("SELECT COUNT(*) as count FROM message_edits WHERE message_id = ?").get(message.id) as { count: number };
      const reactionCount = db.prepare("SELECT COUNT(*) as count FROM reactions WHERE message_id = ?").get(message.id) as { count: number };
      const refreshCount = db.prepare("SELECT COUNT(*) as count FROM msg_wait_refresh_requests WHERE thread_id = ?").get(thread.id) as { count: number };
      expect(editCount.count).toBe(0);
      expect(reactionCount.count).toBe(0);
      expect(refreshCount.count).toBe(0);
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("clears repo-root workspace contents but preserves .git when requested", async () => {
    const server = createHttpServer();
    const workspace = await mkdtemp(join(tmpdir(), "acb-restart-clear-"));

    try {
      await mkdir(join(workspace, ".git"));
      await writeFile(join(workspace, "old.txt"), "old");
      await mkdir(join(workspace, "nested"));
      await writeFile(join(workspace, "nested", "child.txt"), "child");

      const owner = await registerAgent(server, { ide: "browser", model: "owner" });
      const thread = await createThread(server, owner, "restart-clear-workspace", workspace);

      const restartResponse = await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/restart`,
        headers: { "x-agent-token": owner.token },
        payload: {
          requested_by_agent_id: owner.agent_id,
          clear_workspace: true,
        },
      });

      expect(restartResponse.statusCode).toBe(200);
      const restartBody = restartResponse.json() as Record<string, any>;
      expect(restartBody.ok).toBe(true);
      expect(restartBody.restarted_agents_count).toBe(0);
      expect(restartBody.workspace_cleanup.target).toBe(workspace);
      expect(existsSync(join(workspace, ".git"))).toBe(true);
      expect(existsSync(join(workspace, "old.txt"))).toBe(false);
      expect(existsSync(join(workspace, "nested"))).toBe(false);
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects workspace clearing when the thread workspace is not a git repo root", async () => {
    const server = createHttpServer();
    const workspace = await mkdtemp(join(tmpdir(), "acb-restart-nongit-"));

    try {
      await writeFile(join(workspace, "orphan.txt"), "orphan");

      const owner = await registerAgent(server, { ide: "browser", model: "owner" });
      const thread = await createThread(server, owner, "restart-non-git", workspace);

      const restartResponse = await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/restart`,
        headers: { "x-agent-token": owner.token },
        payload: {
          requested_by_agent_id: owner.agent_id,
          clear_workspace: true,
        },
      });

      expect(restartResponse.statusCode).toBe(400);
      expect(restartResponse.json().detail).toContain("git repository root");
      expect(getMemoryStore().getThread(thread.id)?.topic).toBe("restart-non-git");
      expect(existsSync(join(workspace, "orphan.txt"))).toBe(true);
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
