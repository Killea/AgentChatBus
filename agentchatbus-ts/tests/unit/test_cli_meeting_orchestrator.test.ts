import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eventBus } from "../../src/shared/eventBus.js";
import { CliMeetingOrchestrator } from "../../src/core/services/cliMeetingOrchestrator.js";
import type { CliSessionSnapshot } from "../../src/core/services/cliSessionManager.js";
import { MemoryStore } from "../../src/core/services/memoryStore.js";

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition."));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

class FakeCliSessionManager {
  readonly sessions = new Map<string, CliSessionSnapshot>();
  readonly deliveredPrompts: Array<{
    sessionId: string;
    prompt: string;
    deliveryMode?: "join" | "resume" | "incremental";
    deliveredSeq?: number;
  }> = [];

  getSession(sessionId: string): CliSessionSnapshot | null {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  listSessionsForThread(threadId: string): CliSessionSnapshot[] {
    return Array.from(this.sessions.values())
      .filter((session) => session.thread_id === threadId)
      .map((session) => ({ ...session }));
  }

  updateMeetingState(
    sessionId: string,
    patch: Partial<
      Pick<
        CliSessionSnapshot,
        | "participant_role"
        | "context_delivery_mode"
        | "last_delivered_seq"
        | "last_posted_seq"
        | "meeting_post_state"
        | "meeting_post_error"
        | "last_posted_message_id"
      >
    >,
  ): CliSessionSnapshot | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    Object.entries(patch).forEach(([key, value]) => {
      if (value !== undefined) {
        (session as Record<string, unknown>)[key] = value;
      }
    });
    return { ...session };
  }

  updateSessionPrompt(sessionId: string, patch: { prompt: string }): CliSessionSnapshot | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    session.prompt = patch.prompt;
    return { ...session };
  }

  async deliverPrompt(
    sessionId: string,
    prompt: string,
    options?: {
      deliveryMode?: "join" | "resume" | "incremental";
      deliveredSeq?: number;
    },
  ): Promise<{ ok: boolean; session?: CliSessionSnapshot; error?: string } | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    session.prompt = prompt;
    if (options?.deliveryMode) {
      session.context_delivery_mode = options.deliveryMode;
    }
    if (Number.isFinite(Number(options?.deliveredSeq))) {
      session.last_delivered_seq = Number(options?.deliveredSeq);
    }
    session.reply_capture_state = "waiting_for_reply";
    session.reply_capture_excerpt = undefined;
    session.reply_capture_error = undefined;
    session.meeting_post_state = "pending";
    session.last_posted_seq = undefined;
    session.last_posted_message_id = undefined;
    this.deliveredPrompts.push({
      sessionId,
      prompt,
      deliveryMode: options?.deliveryMode,
      deliveredSeq: options?.deliveredSeq,
    });
    return { ok: true, session: { ...session } };
  }
}

function buildSessionSnapshot(
  overrides: Partial<CliSessionSnapshot> = {},
): CliSessionSnapshot {
  return {
    id: randomUUID(),
    thread_id: "thread-1",
    adapter: "codex",
    mode: "interactive",
    state: "running",
    prompt: "prompt",
    initial_instruction: "Introduce yourself",
    workspace: process.cwd(),
    requested_by_agent_id: "owner-1",
    participant_agent_id: "participant-1",
    participant_display_name: "Participant One",
    participant_role: "participant",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    run_count: 1,
    supports_input: true,
    supports_restart: true,
    supports_resize: true,
    output_cursor: 0,
    raw_result: null,
    context_delivery_mode: "join",
    last_delivered_seq: 0,
    meeting_post_state: "pending",
    ...overrides,
  };
}

describe("CliMeetingOrchestrator", () => {
  it("prepares a join session and marks the first participant as administrator when needed", () => {
    const store = new MemoryStore(":memory:");
    const participant = store.registerAgent({
      ide: "Codex",
      model: "Interactive CLI",
      display_name: "Codex Planner",
    });
    const { thread } = store.createThread("meeting-thread");
    const manager = new FakeCliSessionManager();
    const orchestrator = new CliMeetingOrchestrator(store, manager as unknown as any);

    try {
      const prepared = orchestrator.prepareSession({
        threadId: thread.id,
        participantAgentId: participant.id,
        participantDisplayName: "Codex Planner",
        initialInstruction: "",
      });

      expect(prepared.participantRole).toBe("administrator");
      expect(prepared.contextDeliveryMode).toBe("join");
      expect(prepared.prompt).toContain("Current administrator: Codex Planner");
      expect(prepared.prompt).toContain("[seq 0] System (system)");

      const threadAgents = store.getThreadAgents(thread.id);
      expect(threadAgents.some((agent) => agent.id === participant.id)).toBe(true);
    } finally {
      orchestrator.close();
    }
  });

  it("uses resume delivery when the participant has already posted in the thread", () => {
    const store = new MemoryStore(":memory:");
    const creator = store.registerAgent({ ide: "CLI", model: "creator" });
    const participant = store.registerAgent({
      ide: "Codex",
      model: "Interactive CLI",
      display_name: "Codex Reviewer",
    });
    const { thread } = store.createThread("resume-thread", undefined, undefined, {
      creatorAdminId: creator.id,
      creatorAdminName: creator.display_name || creator.name,
    });
    store.addThreadParticipant(thread.id, participant.id);
    const participantSync = store.issueSyncContext(thread.id, participant.id, "test");
    store.postMessage({
      threadId: thread.id,
      author: participant.id,
      role: "assistant",
      content: "Earlier reply",
      expectedLastSeq: participantSync.current_seq,
      replyToken: participantSync.reply_token,
    });

    const manager = new FakeCliSessionManager();
    const orchestrator = new CliMeetingOrchestrator(store, manager as unknown as any);

    try {
      const prepared = orchestrator.prepareSession({
        threadId: thread.id,
        participantAgentId: participant.id,
        participantDisplayName: "Codex Reviewer",
        initialInstruction: "Continue from the latest state.",
      });

      expect(prepared.participantRole).toBe("participant");
      expect(prepared.contextDeliveryMode).toBe("resume");
      expect(prepared.lastDeliveredSeq).toBe(1);
    } finally {
      orchestrator.close();
    }
  });

  it("relays a completed participant reply back into the canonical thread", async () => {
    const store = new MemoryStore(":memory:");
    const owner = store.registerAgent({ ide: "browser", model: "human-owner" });
    const participant = store.registerAgent({
      ide: "Codex",
      model: "Interactive CLI",
      display_name: "Codex Worker",
    });
    const { thread } = store.createThread("relay-thread", undefined, undefined, {
      creatorAdminId: owner.id,
      creatorAdminName: owner.display_name || owner.name,
    });
    store.addThreadParticipant(thread.id, participant.id);

    const manager = new FakeCliSessionManager();
    const orchestrator = new CliMeetingOrchestrator(store, manager as unknown as any);
    const session = buildSessionSnapshot({
      thread_id: thread.id,
      participant_agent_id: participant.id,
      participant_display_name: "Codex Worker",
      participant_role: "participant",
      last_delivered_seq: 0,
      reply_capture_state: "completed",
      reply_capture_excerpt: "I can help with implementation.",
    });
    manager.sessions.set(session.id, session);

    try {
      eventBus.emit({
        type: "cli.session.state",
        payload: {
          thread_id: thread.id,
          session_id: session.id,
          session: { ...session },
        },
      });

      await waitFor(() => manager.sessions.get(session.id)?.meeting_post_state === "posted");

      const messages = store.getMessages(thread.id, 0, false);
      const relayed = messages.find((message) => message.author_id === participant.id);
      expect(relayed?.content).toBe("I can help with implementation.");
      expect(manager.sessions.get(session.id)?.last_posted_seq).toBe(relayed?.seq);
    } finally {
      orchestrator.close();
    }
  });

  it("creates one live relay message and keeps editing it as the captured reply grows", async () => {
    const store = new MemoryStore(":memory:");
    const owner = store.registerAgent({ ide: "browser", model: "human-owner" });
    const participant = store.registerAgent({
      ide: "Codex",
      model: "Interactive CLI",
      display_name: "Codex Worker",
    });
    const { thread } = store.createThread("streaming-relay-thread", undefined, undefined, {
      creatorAdminId: owner.id,
      creatorAdminName: owner.display_name || owner.name,
    });
    store.addThreadParticipant(thread.id, participant.id);

    const manager = new FakeCliSessionManager();
    const orchestrator = new CliMeetingOrchestrator(store, manager as unknown as any);
    const session = buildSessionSnapshot({
      thread_id: thread.id,
      participant_agent_id: participant.id,
      participant_display_name: "Codex Worker",
      participant_role: "participant",
      state: "running",
      reply_capture_state: "waiting_for_reply",
      reply_capture_excerpt: undefined,
      meeting_post_state: "pending",
    });
    manager.sessions.set(session.id, session);

    try {
      eventBus.emit({
        type: "cli.session.state",
        payload: {
          thread_id: thread.id,
          session_id: session.id,
          session: { ...session },
        },
      });

      await waitFor(() => manager.sessions.get(session.id)?.last_posted_message_id !== undefined);
      const placeholderMessageId = manager.sessions.get(session.id)?.last_posted_message_id;
      const placeholderMessage = placeholderMessageId ? store.getMessage(placeholderMessageId) : undefined;
      expect(placeholderMessage?.content).toBe("Thinking...");

      const streamingSession = manager.sessions.get(session.id);
      if (!streamingSession) {
        throw new Error("Missing streaming session snapshot");
      }
      streamingSession.reply_capture_state = "streaming";
      streamingSession.reply_capture_excerpt = "First line.\nSecond line.";

      eventBus.emit({
        type: "cli.session.state",
        payload: {
          thread_id: thread.id,
          session_id: session.id,
          session: { ...streamingSession },
        },
      });

      await waitFor(() => {
        const updated = placeholderMessageId ? store.getMessage(placeholderMessageId) : undefined;
        return updated?.content === "First line.\nSecond line.";
      });

      const completedSession = manager.sessions.get(session.id);
      if (!completedSession) {
        throw new Error("Missing completed session snapshot");
      }
      completedSession.reply_capture_state = "completed";
      completedSession.reply_capture_excerpt = "First line.\nSecond line.\nFinal line.";

      eventBus.emit({
        type: "cli.session.state",
        payload: {
          thread_id: thread.id,
          session_id: session.id,
          session: { ...completedSession },
        },
      });

      await waitFor(() => {
        const updated = placeholderMessageId ? store.getMessage(placeholderMessageId) : undefined;
        return updated?.content === "First line.\nSecond line.\nFinal line.";
      });

      const participantMessages = store
        .getMessages(thread.id, 0, false)
        .filter((message) => message.author_id === participant.id);
      expect(participantMessages).toHaveLength(1);
      expect(participantMessages[0]?.id).toBe(placeholderMessageId);
      expect(participantMessages[0]?.content).toBe("First line.\nSecond line.\nFinal line.");
    } finally {
      orchestrator.close();
    }
  });

  it("marks the relay as stale when the thread advanced after context delivery", async () => {
    const store = new MemoryStore(":memory:");
    const owner = store.registerAgent({ ide: "browser", model: "human-owner" });
    const participant = store.registerAgent({
      ide: "Codex",
      model: "Interactive CLI",
      display_name: "Codex Worker",
    });
    const { thread } = store.createThread("stale-thread", undefined, undefined, {
      creatorAdminId: owner.id,
      creatorAdminName: owner.display_name || owner.name,
    });
    store.addThreadParticipant(thread.id, participant.id);

    const humanSync = store.issueSyncContext(thread.id, owner.id, "test-human");
    store.postMessage({
      threadId: thread.id,
      author: owner.id,
      role: "user",
      content: "New message after context delivery",
      expectedLastSeq: humanSync.current_seq,
      replyToken: humanSync.reply_token,
    });

    const manager = new FakeCliSessionManager();
    const orchestrator = new CliMeetingOrchestrator(store, manager as unknown as any);
    const session = buildSessionSnapshot({
      thread_id: thread.id,
      participant_agent_id: participant.id,
      participant_display_name: "Codex Worker",
      participant_role: "participant",
      last_delivered_seq: 0,
      reply_capture_state: "completed",
      reply_capture_excerpt: "I saw the earlier thread state.",
    });
    manager.sessions.set(session.id, session);

    try {
      eventBus.emit({
        type: "cli.session.state",
        payload: {
          thread_id: thread.id,
          session_id: session.id,
          session: { ...session },
        },
      });

      await waitFor(() => manager.sessions.get(session.id)?.meeting_post_state === "stale");

      const messages = store
        .getMessages(thread.id, 0, false)
        .filter((message) => message.author_id === participant.id);
      expect(messages).toHaveLength(0);
      expect(manager.sessions.get(session.id)?.meeting_post_error).toContain("Thread advanced");
    } finally {
      orchestrator.close();
    }
  });

  it("delivers incremental context to an idle interactive participant after a human posts a new message", async () => {
    const store = new MemoryStore(":memory:");
    const owner = store.registerAgent({ ide: "browser", model: "human-owner", display_name: "Human Owner" });
    const participant = store.registerAgent({
      ide: "Codex",
      model: "Interactive CLI",
      display_name: "Codex Worker",
    });
    const { thread } = store.createThread("incremental-thread", undefined, undefined, {
      creatorAdminId: owner.id,
      creatorAdminName: owner.display_name || owner.name,
    });
    store.addThreadParticipant(thread.id, participant.id);

    const manager = new FakeCliSessionManager();
    const orchestrator = new CliMeetingOrchestrator(store, manager as unknown as any);
    const session = buildSessionSnapshot({
      thread_id: thread.id,
      participant_agent_id: participant.id,
      participant_display_name: "Codex Worker",
      participant_role: "participant",
      state: "running",
      mode: "interactive",
      context_delivery_mode: "join",
      last_delivered_seq: 0,
      last_acknowledged_seq: 0,
      reply_capture_state: "completed",
      reply_capture_excerpt: "Hello, I am Codex Worker.",
      meeting_post_state: "posted",
    });
    manager.sessions.set(session.id, session);

    try {
      const humanSync = store.issueSyncContext(thread.id, owner.id, "test-human");
      const message = store.postMessage({
        threadId: thread.id,
        author: owner.id,
        role: "user",
        content: "Can you review the latest approach and respond?",
        expectedLastSeq: humanSync.current_seq,
        replyToken: humanSync.reply_token,
      });

      await waitFor(() => manager.deliveredPrompts.length === 1);
      const delivery = manager.deliveredPrompts[0];
      expect(delivery?.sessionId).toBe(session.id);
      expect(delivery?.deliveryMode).toBe("incremental");
      expect(delivery?.deliveredSeq).toBe(message.seq);
      expect(delivery?.prompt).toContain("incremental delivery");
      expect(delivery?.prompt).toContain("Can you review the latest approach and respond?");
      expect(manager.sessions.get(session.id)?.last_delivered_seq).toBe(message.seq);
    } finally {
      orchestrator.close();
    }
  });

  it("queues incremental delivery while the interactive participant is busy and flushes it once the participant becomes idle", async () => {
    const store = new MemoryStore(":memory:");
    const owner = store.registerAgent({ ide: "browser", model: "human-owner", display_name: "Human Owner" });
    const participant = store.registerAgent({
      ide: "Codex",
      model: "Interactive CLI",
      display_name: "Codex Worker",
    });
    const { thread } = store.createThread("queued-incremental-thread", undefined, undefined, {
      creatorAdminId: owner.id,
      creatorAdminName: owner.display_name || owner.name,
    });
    store.addThreadParticipant(thread.id, participant.id);

    const manager = new FakeCliSessionManager();
    const orchestrator = new CliMeetingOrchestrator(store, manager as unknown as any);
    const session = buildSessionSnapshot({
      thread_id: thread.id,
      participant_agent_id: participant.id,
      participant_display_name: "Codex Worker",
      participant_role: "participant",
      state: "running",
      mode: "interactive",
      context_delivery_mode: "join",
      last_delivered_seq: 0,
      last_acknowledged_seq: 0,
      reply_capture_state: "working",
      meeting_post_state: "posting",
      automation_state: "codex_working",
    });
    manager.sessions.set(session.id, session);

    try {
      const humanSync = store.issueSyncContext(thread.id, owner.id, "test-human");
      const message = store.postMessage({
        threadId: thread.id,
        author: owner.id,
        role: "user",
        content: "Please continue after you finish the current work.",
        expectedLastSeq: humanSync.current_seq,
        replyToken: humanSync.reply_token,
      });

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(manager.deliveredPrompts).toHaveLength(0);

      const updatedSession = manager.sessions.get(session.id);
      if (!updatedSession) {
        throw new Error("Missing updated session snapshot");
      }
      updatedSession.reply_capture_state = "completed";
      updatedSession.reply_capture_excerpt = "Done with the previous task.";
      updatedSession.meeting_post_state = "posted";
      updatedSession.automation_state = "meeting_delivery_complete";

      eventBus.emit({
        type: "cli.session.state",
        payload: {
          thread_id: thread.id,
          session_id: session.id,
          session: { ...updatedSession },
        },
      });

      await waitFor(() => manager.deliveredPrompts.length === 1);
      expect(manager.deliveredPrompts[0]?.deliveredSeq).toBe(message.seq);
      expect(manager.sessions.get(session.id)?.last_delivered_seq).toBe(message.seq);
    } finally {
      orchestrator.close();
    }
  });

  it("delivers the same human message to every other idle interactive participant in the thread", async () => {
    const store = new MemoryStore(":memory:");
    const owner = store.registerAgent({ ide: "browser", model: "human-owner", display_name: "Human Owner" });
    const participantA = store.registerAgent({
      ide: "Codex",
      model: "Interactive CLI",
      display_name: "Codex Alpha",
    });
    const participantB = store.registerAgent({
      ide: "Codex",
      model: "Interactive CLI",
      display_name: "Codex Beta",
    });
    const { thread } = store.createThread("two-participant-incremental-thread", undefined, undefined, {
      creatorAdminId: owner.id,
      creatorAdminName: owner.display_name || owner.name,
    });
    store.addThreadParticipant(thread.id, participantA.id);
    store.addThreadParticipant(thread.id, participantB.id);

    const manager = new FakeCliSessionManager();
    const orchestrator = new CliMeetingOrchestrator(store, manager as unknown as any);
    const createdAt = new Date().toISOString();
    const sessionA = buildSessionSnapshot({
      id: randomUUID(),
      thread_id: thread.id,
      participant_agent_id: participantA.id,
      participant_display_name: "Codex Alpha",
      participant_role: "participant",
      created_at: createdAt,
      updated_at: createdAt,
      state: "running",
      mode: "interactive",
      context_delivery_mode: "join",
      last_delivered_seq: 0,
      reply_capture_state: "completed",
      reply_capture_excerpt: "Alpha is ready.",
      meeting_post_state: "posted",
    });
    const sessionB = buildSessionSnapshot({
      id: randomUUID(),
      thread_id: thread.id,
      participant_agent_id: participantB.id,
      participant_display_name: "Codex Beta",
      participant_role: "participant",
      created_at: createdAt,
      updated_at: createdAt,
      state: "running",
      mode: "interactive",
      context_delivery_mode: "join",
      last_delivered_seq: 0,
      reply_capture_state: "completed",
      reply_capture_excerpt: "Beta is ready.",
      meeting_post_state: "posted",
    });
    manager.sessions.set(sessionA.id, sessionA);
    manager.sessions.set(sessionB.id, sessionB);

    try {
      const humanSync = store.issueSyncContext(thread.id, owner.id, "test-human");
      const message = store.postMessage({
        threadId: thread.id,
        author: owner.id,
        role: "user",
        content: "Both of you please react to this new requirement.",
        expectedLastSeq: humanSync.current_seq,
        replyToken: humanSync.reply_token,
      });

      await waitFor(() => manager.deliveredPrompts.length === 2);
      expect(manager.deliveredPrompts.map((entry) => entry.sessionId).sort()).toEqual(
        [sessionA.id, sessionB.id].sort(),
      );
      expect(manager.deliveredPrompts.every((entry) => entry.deliveredSeq === message.seq)).toBe(true);
      expect(
        manager.deliveredPrompts.every((entry) =>
          entry.prompt.includes("Both of you please react to this new requirement.")),
      ).toBe(true);
    } finally {
      orchestrator.close();
    }
  });
});
