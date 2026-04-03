import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/core/services/memoryStore.js";

describe("MemoryStore", () => {
  it("creates a thread and returns initial sync context", () => {
    const store = new MemoryStore(':memory:');
    const result = store.createThread("demo-thread");

    expect(result.thread.topic).toBe("demo-thread");
    expect(result.sync.current_seq).toBe(0);
    expect(result.sync.reply_token).toBeTruthy();
  });

  it("prefers explicit AGENTCHATBUS_DB over vitest worker fallback", () => {
    const previousDb = process.env.AGENTCHATBUS_DB;
    try {
      process.env.AGENTCHATBUS_DB = ":memory:";
      const store = new MemoryStore();
      expect((store as any).persistencePath).toBe(":memory:");
    } finally {
      if (previousDb === undefined) {
        delete process.env.AGENTCHATBUS_DB;
      } else {
        process.env.AGENTCHATBUS_DB = previousDb;
      }
    }
  });

  it("reset clears relational persistence for reused databases", () => {
    const dbPath = join(process.cwd(), "data", `memory-store-reset-${randomUUID()}.db`);
    let store: MemoryStore | undefined;
    let reopened: MemoryStore | undefined;
    try {
      store = new MemoryStore(dbPath);
      const agent = store.registerAgent({ ide: "VS Code", model: "GPT" });
      const { thread } = store.createThread("reset-me");
      store.createTemplate({
        id: "custom-template",
        name: "Custom Template",
        description: "for reset regression",
        system_prompt: "hello",
      });

      expect(store.getMetrics().agents.total).toBe(1);
      expect(store.listThreads().threads.length).toBe(1);
      expect(store.getTemplates().some((template) => template.id === "custom-template")).toBe(true);

      store.reset();

      reopened = new MemoryStore(dbPath);
      expect(reopened.getMetrics().agents.total).toBe(0);
      expect(reopened.listThreads().threads.length).toBe(0);
      expect(reopened.getTemplates().some((template) => template.id === "custom-template")).toBe(false);
      expect(reopened.getAgent(agent.id)).toBeUndefined();
      expect(reopened.getThread(thread.id)).toBeUndefined();
    } finally {
      (reopened as any)?.persistenceDb?.close?.();
      (store as any)?.persistenceDb?.close?.();
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    }
  });

  it("includes explicitly added thread participants before they post messages", () => {
    const store = new MemoryStore(":memory:");
    const creator = store.registerAgent({ ide: "CLI", model: "creator" });
    const participant = store.registerAgent({ ide: "CLI", model: "participant" });
    const { thread } = store.createThread("participant-thread", undefined, undefined, {
      creatorAdminId: creator.id,
      creatorAdminName: creator.display_name || creator.name,
    });

    expect(store.addThreadParticipant(thread.id, participant.id)).toBe(true);

    const agents = store.getThreadAgents(thread.id);
    const agentIds = new Set(agents.map((agent) => agent.id));
    expect(agentIds.has(creator.id)).toBe(true);
    expect(agentIds.has(participant.id)).toBe(true);
  });

  it("deleteThread removes related edit, reaction, and refresh-request records", () => {
    const store = new MemoryStore(":memory:");
    const agent = store.registerAgent({ ide: "CLI", model: "cleanup-check" });
    const { thread, sync } = store.createThread("delete-cleanup");

    const message = store.postMessage({
      threadId: thread.id,
      author: agent.id,
      content: "first draft",
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
      role: "assistant",
    });

    store.editMessage(message.id, "second draft", agent.id);
    store.addReaction(message.id, agent.id, "thumbs-up");
    store.setRefreshRequest(thread.id, agent.id, "cleanup-check");

    const db = (store as any).persistenceDb;
    expect((db.prepare("SELECT COUNT(*) as count FROM message_edits WHERE message_id = ?").get(message.id) as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) as count FROM reactions WHERE message_id = ?").get(message.id) as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) as count FROM msg_wait_refresh_requests WHERE thread_id = ?").get(thread.id) as { count: number }).count).toBe(1);

    expect(store.deleteThread(thread.id)).toBe(true);

    expect((db.prepare("SELECT COUNT(*) as count FROM message_edits WHERE message_id = ?").get(message.id) as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) as count FROM reactions WHERE message_id = ?").get(message.id) as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) as count FROM msg_wait_refresh_requests WHERE thread_id = ?").get(thread.id) as { count: number }).count).toBe(0);
  });

  it("stores human_only messages outside the visible message stream and restores them in transcript order", () => {
    const store = new MemoryStore(":memory:");
    const { thread, sync } = store.createThread("human-transcript");

    const visible = store.postMessage({
      threadId: thread.id,
      author: "human",
      content: "visible kickoff",
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
    });

    const hidden = store.postSystemMessage(
      thread.id,
      "human-only note",
      JSON.stringify({
        visibility: "human_only",
        ui_type: "admin_switch_confirmation_required",
        private_body: "do not show to agents",
      }),
    );

    const syncAfterHidden = store.issueSyncContext(thread.id);
    expect(syncAfterHidden.current_seq).toBe(1);

    const visibleMessages = store.getMessages(thread.id, 0, false);
    expect(visibleMessages.map((message) => message.content)).toEqual(["visible kickoff"]);

    const transcript = store.getHumanTranscript(thread.id, 0, false);
    expect(transcript.map((entry) => ({
      kind: entry.entry_kind,
      content: entry.content,
      seq: entry.seq ?? null,
      anchor_seq: entry.anchor_seq ?? null,
    }))).toEqual([
      { kind: "message", content: "visible kickoff", seq: 1, anchor_seq: null },
      { kind: "human_only", content: "human-only note", seq: null, anchor_seq: 1 },
    ]);
    expect((hidden as any)?.id).toBeDefined();
  });

  it("migrates legacy hidden messages into the dedicated transcript table and renumbers visible seq values", () => {
    const dbPath = join(process.cwd(), "data", `memory-store-human-only-${randomUUID()}.db`);
    let store: MemoryStore | undefined;
    let reopened: MemoryStore | undefined;

    try {
      store = new MemoryStore(dbPath);
      const { thread, sync } = store.createThread("legacy-hidden-migration");
      const firstVisible = store.postMessage({
        threadId: thread.id,
        author: "human",
        content: "visible one",
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
      });

      const db = (store as any).persistenceDb;
      const hiddenId = randomUUID();
      const visibleTwoId = randomUUID();
      db.prepare(
        `
          INSERT INTO messages (
            id, thread_id, seq, priority, author, author_id, author_name, author_emoji,
            role, content, metadata, reply_to_msg_id, created_at, edited_at, edit_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        hiddenId,
        thread.id,
        2,
        "system",
        "system",
        "system",
        "System",
        "⚙️",
        "system",
        "legacy hidden",
        JSON.stringify({ visibility: "human_only", ui_type: "admin_takeover_confirmation_required" }),
        null,
        new Date().toISOString(),
        null,
        0,
      );
      db.prepare(
        `
          INSERT INTO messages (
            id, thread_id, seq, priority, author, author_id, author_name, author_emoji,
            role, content, metadata, reply_to_msg_id, created_at, edited_at, edit_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        visibleTwoId,
        thread.id,
        3,
        "normal",
        "human",
        null,
        null,
        null,
        "user",
        "visible two",
        null,
        null,
        new Date().toISOString(),
        null,
        0,
      );
      (store as any).persistenceDb.close();
      store = undefined;

      reopened = new MemoryStore(dbPath);
      const visibleMessages = reopened.getMessages(thread.id, 0, false);
      expect(visibleMessages.map((message) => ({ seq: message.seq, content: message.content }))).toEqual([
        { seq: 1, content: "visible one" },
        { seq: 2, content: "visible two" },
      ]);

      const transcript = reopened.getHumanTranscript(thread.id, 0, false);
      expect(transcript.map((entry) => ({
        kind: entry.entry_kind,
        content: entry.content,
        seq: entry.seq ?? null,
        anchor_seq: entry.anchor_seq ?? null,
      }))).toEqual([
        { kind: "message", content: "visible one", seq: 1, anchor_seq: null },
        { kind: "human_only", content: "legacy hidden", seq: null, anchor_seq: 1 },
        { kind: "message", content: "visible two", seq: 2, anchor_seq: null },
      ]);

      const migratedHidden = reopened.getHumanOnlyMessage(hiddenId);
      expect(migratedHidden?.anchor_seq).toBe(1);
      expect(reopened.issueSyncContext(thread.id).current_seq).toBe(2);
      expect(firstVisible.seq).toBe(1);
    } finally {
      (reopened as any)?.persistenceDb?.close?.();
      (store as any)?.persistenceDb?.close?.();
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    }
  });
});
