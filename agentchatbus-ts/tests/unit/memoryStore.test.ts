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
});
