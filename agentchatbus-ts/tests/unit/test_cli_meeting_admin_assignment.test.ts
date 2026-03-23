import { describe, expect, it } from "vitest";
import { CliMeetingOrchestrator } from "../../src/core/services/cliMeetingOrchestrator.js";
import { CliSessionManager } from "../../src/core/services/cliSessionManager.js";
import { MemoryStore } from "../../src/core/services/memoryStore.js";

describe("CliMeetingOrchestrator admin assignment", () => {
  it("persists the first CLI participant as creator admin when a thread has no administrator", () => {
    const store = new MemoryStore(":memory:");
    const cliSessionManager = new CliSessionManager();
    const orchestrator = new CliMeetingOrchestrator(store, cliSessionManager);

    const participant = store.registerAgent({
      ide: "Codex",
      model: "Interactive CLI",
      display_name: "Codex Interactive",
    });
    const { thread } = store.createThread("cli-admin-thread", undefined, undefined, {
      creatorAdminId: undefined,
      creatorAdminName: undefined,
    });

    const prepared = orchestrator.prepareSession({
      threadId: thread.id,
      participantAgentId: participant.id,
      participantDisplayName: participant.display_name,
      initialInstruction: "Introduce yourself briefly.",
    });

    const settings = store.getThreadSettings(thread.id);
    const threadAgents = store.getThreadAgents(thread.id);

    expect(prepared.participantRole).toBe("administrator");
    expect(settings?.creator_admin_id).toBe(participant.id);
    expect(settings?.creator_admin_name).toBe(participant.display_name);
    expect(settings?.auto_assigned_admin_id).toBeUndefined();
    expect(threadAgents.some((agent) => agent.id === participant.id)).toBe(true);

    orchestrator.close();
  });
});
