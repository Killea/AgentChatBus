import { afterEach, describe, expect, it, vi } from "vitest";
import { CliMeetingOrchestrator } from "../../src/core/services/cliMeetingOrchestrator.js";
import type { CliSessionSnapshot } from "../../src/core/services/cliSessionManager.js";
import type { CliSessionManager } from "../../src/core/services/cliSessionManager.js";
import { MemoryStore } from "../../src/core/services/memoryStore.js";

function makeInteractiveSession(
  overrides: Partial<CliSessionSnapshot>,
): CliSessionSnapshot {
  return {
    id: overrides.id || "session",
    thread_id: overrides.thread_id || "thread",
    thread_display_name: overrides.thread_display_name,
    reentry_prompt_override: overrides.reentry_prompt_override,
    adapter: overrides.adapter || "copilot",
    mode: "interactive",
    state: overrides.state || "running",
    prompt: overrides.prompt || "",
    prompt_history: overrides.prompt_history,
    initial_instruction: overrides.initial_instruction,
    workspace: overrides.workspace || "C:\\workspace",
    requested_by_agent_id: overrides.requested_by_agent_id || "human-owner",
    participant_agent_id: overrides.participant_agent_id,
    participant_display_name: overrides.participant_display_name,
    participant_role: overrides.participant_role || "participant",
    meeting_transport: overrides.meeting_transport || "agent_mcp",
    created_at: overrides.created_at || "2026-03-23T12:00:00.000Z",
    updated_at: overrides.updated_at || "2026-03-23T12:00:00.000Z",
    run_count: overrides.run_count || 1,
    supports_input: overrides.supports_input ?? true,
    supports_restart: overrides.supports_restart ?? true,
    supports_resize: overrides.supports_resize ?? true,
    pid: overrides.pid,
    last_error: overrides.last_error,
    last_result: overrides.last_result,
    raw_result: overrides.raw_result ?? null,
    external_session_id: overrides.external_session_id,
    external_request_id: overrides.external_request_id,
    exit_code: overrides.exit_code,
    stdout_excerpt: overrides.stdout_excerpt,
    stderr_excerpt: overrides.stderr_excerpt,
    output_cursor: overrides.output_cursor || 0,
    cols: overrides.cols || 140,
    rows: overrides.rows || 40,
    shell: overrides.shell || "powershell",
    screen_excerpt: overrides.screen_excerpt || "Describe a task to get started\n❯ ",
    screen_cursor_x: overrides.screen_cursor_x,
    screen_cursor_y: overrides.screen_cursor_y,
    screen_buffer: overrides.screen_buffer || "normal",
    automation_state: overrides.automation_state,
    reply_capture_state: overrides.reply_capture_state,
    reply_capture_excerpt: overrides.reply_capture_excerpt,
    reply_capture_error: overrides.reply_capture_error,
    context_delivery_mode: overrides.context_delivery_mode || "join",
    last_delivered_seq: overrides.last_delivered_seq || 0,
    last_acknowledged_seq: overrides.last_acknowledged_seq,
    last_posted_seq: overrides.last_posted_seq,
    meeting_post_state: overrides.meeting_post_state || "pending",
    meeting_post_error: overrides.meeting_post_error,
    last_posted_message_id: overrides.last_posted_message_id,
    launch_started_at: overrides.launch_started_at,
    process_started_at: overrides.process_started_at,
    first_output_at: overrides.first_output_at,
    last_output_at: overrides.last_output_at,
    connected_at: overrides.connected_at,
    last_tool_call_at: overrides.last_tool_call_at,
    recent_tool_events: overrides.recent_tool_events,
    recent_stream_events: overrides.recent_stream_events,
    recent_activity_events: overrides.recent_activity_events,
    native_activity_card: overrides.native_activity_card,
  };
}

function makeHeadlessSession(
  overrides: Partial<CliSessionSnapshot>,
): CliSessionSnapshot {
  return {
    ...makeInteractiveSession(overrides),
    adapter: overrides.adapter || "codex",
    mode: "headless",
    supports_input: overrides.supports_input ?? false,
    supports_resize: overrides.supports_resize ?? false,
    cols: undefined,
    rows: undefined,
    screen_excerpt: overrides.screen_excerpt,
    shell: overrides.shell,
  };
}

function makeDirectSession(
  overrides: Partial<CliSessionSnapshot>,
): CliSessionSnapshot {
  return {
    ...makeHeadlessSession(overrides),
    mode: "direct",
    supports_restart: overrides.supports_restart ?? true,
    supports_input: overrides.supports_input ?? false,
  };
}

function postWithSync(
  store: MemoryStore,
  threadId: string,
  author: string,
  content: string,
  role: "user" | "assistant" | "system" = "user",
): void {
  const sync = store.issueSyncContext(threadId, role === "assistant" ? author : undefined);
  store.postMessage({
    threadId,
    author,
    content,
    role,
    expectedLastSeq: sync.current_seq,
    replyToken: sync.reply_token,
  });
}

class FakeCliSessionManager {
  readonly wakeCalls: Array<{ sessionId: string; prompt: string }> = [];
  readonly restartCalls: string[] = [];
  readonly restartRequests: Array<{
    sessionId: string;
    prompt?: string;
    promptHistoryKind?: string;
    contextDeliveryMode?: string;
  }> = [];
  readonly stopCalls: string[] = [];
  private readonly sessions = new Map<string, CliSessionSnapshot>();

  constructor(initialSessions: CliSessionSnapshot[]) {
    for (const session of initialSessions) {
      this.sessions.set(session.id, { ...session });
    }
  }

  listSessionsForThread(threadId: string): CliSessionSnapshot[] {
    return Array.from(this.sessions.values())
      .filter((session) => session.thread_id === threadId)
      .map((session) => ({ ...session }));
  }

  getSession(sessionId: string): CliSessionSnapshot | null {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  clearWakePromptState(): CliSessionSnapshot | null {
    return null;
  }

  async restartSession(
    sessionId: string,
    options?: {
      prompt?: string;
      promptHistoryKind?: "initial" | "update" | "wake" | "delivery";
      contextDeliveryMode?: CliSessionSnapshot["context_delivery_mode"];
    },
  ): Promise<CliSessionSnapshot | null> {
    this.restartCalls.push(sessionId);
    this.restartRequests.push({
      sessionId,
      prompt: options?.prompt,
      promptHistoryKind: options?.promptHistoryKind,
      contextDeliveryMode: options?.contextDeliveryMode,
    });
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    const next = {
      ...session,
      prompt: String(options?.prompt || "").trim() || session.prompt,
      context_delivery_mode: options?.contextDeliveryMode || session.context_delivery_mode,
      state: "running",
      run_count: (session.run_count || 0) + 1,
      updated_at: "2026-03-23T12:00:01.000Z",
    } as CliSessionSnapshot;
    this.sessions.set(sessionId, next);
    return { ...next };
  }

  async stopSession(sessionId: string): Promise<CliSessionSnapshot | null> {
    this.stopCalls.push(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    const next = {
      ...session,
      state: "stopped",
      pid: undefined,
      updated_at: "2026-03-23T12:00:00.500Z",
    } as CliSessionSnapshot;
    this.sessions.set(sessionId, next);
    return { ...next };
  }

  updateMeetingState(sessionId: string, patch: Record<string, unknown>): CliSessionSnapshot | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    const next = { ...session, ...patch } as CliSessionSnapshot;
    this.sessions.set(sessionId, next);
    return { ...next };
  }

  async deliverWakePrompt(
    sessionId: string,
    prompt: string,
  ): Promise<{ ok: boolean; session?: CliSessionSnapshot; error?: string }> {
    this.wakeCalls.push({ sessionId, prompt });
    const session = this.getSession(sessionId);
    return { ok: true, session: session || undefined };
  }

  async deliverPrompt(): Promise<{ ok: boolean; session?: CliSessionSnapshot; error?: string }> {
    return { ok: true };
  }
}

describe("CliMeetingOrchestrator agent_mcp wake handling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not wake an agent_mcp session while the MCP backend still reports an active msg_wait", async () => {
    const store = new MemoryStore(":memory:");
    const agentA = store.registerAgent({ ide: "Copilot", model: "interactive", display_name: "Copilot A" });
    const agentB = store.registerAgent({ ide: "Copilot", model: "interactive", display_name: "Copilot B" });
    const { thread } = store.createThread("copilot-stale-wait", undefined, undefined, {
      creatorAdminId: agentA.id,
      creatorAdminName: agentA.display_name,
    });

    const fakeManager = new FakeCliSessionManager([
      makeInteractiveSession({
        id: "session-a",
        thread_id: thread.id,
        adapter: "cursor",
        participant_agent_id: agentA.id,
        participant_display_name: agentA.display_name,
        participant_role: "administrator",
        last_delivered_seq: 0,
        screen_excerpt: "Describe a task to get started\n❯ ",
      }),
      makeInteractiveSession({
        id: "session-b",
        thread_id: thread.id,
        participant_agent_id: agentB.id,
        participant_display_name: agentB.display_name,
        participant_role: "participant",
        last_delivered_seq: 0,
        screen_excerpt: "Describe a task to get started\n❯ ",
      }),
    ]);

    const orchestrator = new CliMeetingOrchestrator(
      store,
      fakeManager as unknown as CliSessionManager,
    );

    (store as any).enterWaitState(thread.id, agentA.id, 600_000);

    await (orchestrator as any).maybeDeliverIncrementalContext(
      fakeManager.getSession("session-a"),
      1,
    );

    expect(store.getAgentWaitStatus(thread.id, agentA.id).is_waiting).toBe(true);
    expect(fakeManager.wakeCalls).toHaveLength(0);
    expect((orchestrator as any).pendingDeliverySeqBySession.get("session-a")).toBe(1);

    orchestrator.close();
  });

  it("keeps retrying pending delivery after msg_wait drops and wakes copilot once the wait truly ends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:00:00.000Z"));

    const store = new MemoryStore(":memory:");
    const agentA = store.registerAgent({ ide: "Copilot", model: "interactive", display_name: "Copilot A" });
    const { thread } = store.createThread("copilot-drop-tail-retry", undefined, undefined, {
      creatorAdminId: agentA.id,
      creatorAdminName: agentA.display_name,
    });

    const fakeManager = new FakeCliSessionManager([
      makeInteractiveSession({
        id: "session-a",
        thread_id: thread.id,
        participant_agent_id: agentA.id,
        participant_display_name: agentA.display_name,
        participant_role: "administrator",
        last_delivered_seq: 0,
        screen_excerpt: "Thinking (Esc to cancel)",
      }),
    ]);

    const orchestrator = new CliMeetingOrchestrator(
      store,
      fakeManager as unknown as CliSessionManager,
    );

    const waitCallId = (store as any).enterWaitState(thread.id, agentA.id, 600_000);

    await (orchestrator as any).maybeDeliverIncrementalContext(
      fakeManager.getSession("session-a"),
      1,
    );

    expect(fakeManager.wakeCalls).toHaveLength(0);
    expect((orchestrator as any).pendingDeliverySeqBySession.get("session-a")).toBe(1);

    store.exitWaitState(thread.id, agentA.id, waitCallId, "client_abort");
    fakeManager.updateMeetingState("session-a", {
      screen_excerpt: "Describe a task to get started\n❯ ",
      automation_state: undefined,
      reply_capture_state: undefined,
    });

    await vi.advanceTimersByTimeAsync(1_500);

    expect(store.getAgentWaitStatus(thread.id, agentA.id).is_waiting).toBe(false);
    expect(fakeManager.wakeCalls).toHaveLength(1);
    expect(fakeManager.wakeCalls[0]?.prompt).toContain("Please use msg_wait");

    orchestrator.close();
  });

  it("treats a fresh msg_wait message-return exit as busy and avoids waking too early", async () => {
    const store = new MemoryStore(":memory:");
    const agentA = store.registerAgent({ ide: "Copilot", model: "interactive", display_name: "Copilot A" });
    const { thread } = store.createThread("copilot-message-exit-grace", undefined, undefined, {
      creatorAdminId: agentA.id,
      creatorAdminName: agentA.display_name,
    });

    const fakeManager = new FakeCliSessionManager([
      makeInteractiveSession({
        id: "session-a",
        thread_id: thread.id,
        participant_agent_id: agentA.id,
        participant_display_name: agentA.display_name,
        participant_role: "administrator",
        last_delivered_seq: 0,
        screen_excerpt: "Describe a task to get started\n❯ ",
      }),
    ]);

    const orchestrator = new CliMeetingOrchestrator(
      store,
      fakeManager as unknown as CliSessionManager,
    );

    const waitCallId = (store as any).enterWaitState(thread.id, agentA.id, 600_000);
    store.exitWaitState(thread.id, agentA.id, waitCallId, "message");

    await (orchestrator as any).maybeDeliverIncrementalContext(
      fakeManager.getSession("session-a"),
      1,
    );

    expect(fakeManager.wakeCalls).toHaveLength(0);

    orchestrator.close();
  });

  it("wakes an agent_mcp session again once the MCP backend reports that msg_wait ended", async () => {
    const store = new MemoryStore(":memory:");
    const agentA = store.registerAgent({ ide: "Copilot", model: "interactive", display_name: "Copilot A" });
    const { thread } = store.createThread("copilot-ended-wait", undefined, undefined, {
      creatorAdminId: agentA.id,
      creatorAdminName: agentA.display_name,
    });

    const fakeManager = new FakeCliSessionManager([
      makeInteractiveSession({
        id: "session-a",
        thread_id: thread.id,
        participant_agent_id: agentA.id,
        participant_display_name: agentA.display_name,
        participant_role: "administrator",
        last_delivered_seq: 0,
        screen_excerpt: "Describe a task to get started\n❯ ",
      }),
    ]);

    const orchestrator = new CliMeetingOrchestrator(
      store,
      fakeManager as unknown as CliSessionManager,
    );

    const waitCallId = (store as any).enterWaitState(thread.id, agentA.id, 600_000);
    store.exitWaitState(thread.id, agentA.id, waitCallId, "client_abort");

    await (orchestrator as any).maybeDeliverIncrementalContext(
      fakeManager.getSession("session-a"),
      1,
    );

    expect(store.getAgentWaitStatus(thread.id, agentA.id).is_waiting).toBe(false);
    expect(fakeManager.wakeCalls).toHaveLength(1);
    expect(fakeManager.wakeCalls[0]?.sessionId).toBe("session-a");
    expect(fakeManager.wakeCalls[0]?.prompt).toContain("Please use msg_wait");

    orchestrator.close();
  });

  it("retries a suppressed wake after the cooldown expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:00:00.000Z"));

    const store = new MemoryStore(":memory:");
    const agentA = store.registerAgent({ ide: "Copilot", model: "interactive", display_name: "Copilot A" });
    const { thread } = store.createThread("copilot-wake-cooldown", undefined, undefined, {
      creatorAdminId: agentA.id,
      creatorAdminName: agentA.display_name,
    });

    const fakeManager = new FakeCliSessionManager([
      makeInteractiveSession({
        id: "session-a",
        thread_id: thread.id,
        participant_agent_id: agentA.id,
        participant_display_name: agentA.display_name,
        participant_role: "administrator",
        last_delivered_seq: 0,
        screen_excerpt: "Describe a task to get started\n❯ ",
      }),
    ]);

    const orchestrator = new CliMeetingOrchestrator(
      store,
      fakeManager as unknown as CliSessionManager,
    );

    (orchestrator as any).lastWakePromptBySession.set("session-a", {
      seq: 1,
      sentAt: Date.now(),
    });

    await (orchestrator as any).maybeDeliverIncrementalContext(
      fakeManager.getSession("session-a"),
      2,
    );

    expect(fakeManager.wakeCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(fakeManager.wakeCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_200);
    expect(fakeManager.wakeCalls).toHaveLength(1);
    expect(fakeManager.wakeCalls[0]?.prompt).toContain("prefer to use msg_post");

    orchestrator.close();
  });

  it("marks an agent_mcp session as delivered once its participant posts in the thread", async () => {
    const store = new MemoryStore(":memory:");
    const agentA = store.registerAgent({ ide: "Copilot", model: "interactive", display_name: "Copilot A" });
    const agentB = store.registerAgent({ ide: "Copilot", model: "interactive", display_name: "Copilot B" });
    const { thread } = store.createThread("copilot-delivery-ack", undefined, undefined, {
      creatorAdminId: agentA.id,
      creatorAdminName: agentA.display_name,
    });

    const fakeManager = new FakeCliSessionManager([
      makeInteractiveSession({
        id: "session-a",
        thread_id: thread.id,
        participant_agent_id: agentA.id,
        participant_display_name: agentA.display_name,
        participant_role: "administrator",
        last_delivered_seq: 0,
        last_acknowledged_seq: 0,
        meeting_post_state: "pending",
      }),
      makeInteractiveSession({
        id: "session-b",
        thread_id: thread.id,
        participant_agent_id: agentB.id,
        participant_display_name: agentB.display_name,
        participant_role: "participant",
        last_delivered_seq: 0,
        last_acknowledged_seq: 0,
        meeting_post_state: "pending",
      }),
    ]);

    const orchestrator = new CliMeetingOrchestrator(
      store,
      fakeManager as unknown as CliSessionManager,
    );

    postWithSync(store, thread.id, "Hank", "Please answer.", "user");
    postWithSync(store, thread.id, agentA.id, "I can take this one.", "assistant");

    // Wait for event handlers to process
    await new Promise(resolve => setTimeout(resolve, 10));

    const updatedAuthorSession = fakeManager.getSession("session-a");
    const untouchedPeerSession = fakeManager.getSession("session-b");

    expect(updatedAuthorSession?.last_delivered_seq).toBe(1);
    expect(updatedAuthorSession?.last_acknowledged_seq).toBe(1);
    expect(updatedAuthorSession?.meeting_post_state).toBe("posted");
    expect(updatedAuthorSession?.last_posted_seq).toBe(2);
    expect(updatedAuthorSession?.last_posted_message_id).toBeTruthy();
    expect(untouchedPeerSession?.last_delivered_seq).toBe(0);

    orchestrator.close();
  });

  it("does not wake an agent_mcp session again when the visible screen already shows a newer current_seq", async () => {
    const store = new MemoryStore(":memory:");
    const agentA = store.registerAgent({ ide: "Copilot", model: "interactive", display_name: "Copilot A" });
    const { thread } = store.createThread("copilot-screen-seq-watermark", undefined, undefined, {
      creatorAdminId: agentA.id,
      creatorAdminName: agentA.display_name,
    });

    const fakeManager = new FakeCliSessionManager([
      makeInteractiveSession({
        id: "session-a",
        thread_id: thread.id,
        participant_agent_id: agentA.id,
        participant_display_name: agentA.display_name,
        participant_role: "administrator",
        last_delivered_seq: 1,
        last_acknowledged_seq: 1,
        screen_excerpt: [
          "Listening with msg_wait (current_seq=5).",
          "",
          "❯ Type @ to mention files",
        ].join("\n"),
      }),
    ]);

    const orchestrator = new CliMeetingOrchestrator(
      store,
      fakeManager as unknown as CliSessionManager,
    );

    await (orchestrator as any).maybeDeliverIncrementalContext(
      fakeManager.getSession("session-a"),
      5,
    );

    expect(fakeManager.wakeCalls).toHaveLength(0);

    orchestrator.close();
  });

  it("restarts a headless codex agent_mcp session when a new thread message arrives", async () => {
    const store = new MemoryStore(":memory:");
    const agentA = store.registerAgent({ ide: "Codex", model: "Headless CLI", display_name: "Codex A" });
    const { thread } = store.createThread("codex-headless-restart", undefined, undefined, {
      creatorAdminId: agentA.id,
      creatorAdminName: agentA.display_name,
    });

    const fakeManager = new FakeCliSessionManager([
      makeHeadlessSession({
        id: "session-a",
        thread_id: thread.id,
        thread_display_name: thread.topic,
        reentry_prompt_override: "Resume quietly and process new thread messages with msg_wait before replying.",
        participant_agent_id: agentA.id,
        participant_display_name: agentA.display_name,
        participant_role: "administrator",
        state: "completed",
        last_delivered_seq: 0,
        last_acknowledged_seq: 0,
        external_session_id: "019d1d3a-611f-7e91-b1f1-b5a9d8079942",
      }),
    ]);

    const orchestrator = new CliMeetingOrchestrator(
      store,
      fakeManager as unknown as CliSessionManager,
    );

    postWithSync(store, thread.id, "Hank", "Please pick this up in MCP mode.", "user");

    // Wait for event handlers to process
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(fakeManager.restartCalls).toEqual(["session-a"]);
    expect(fakeManager.restartRequests[0]?.prompt).toBe(
      "Resume quietly and process new thread messages with msg_wait before replying.",
    );
    expect(fakeManager.restartRequests[0]?.promptHistoryKind).toBe("wake");
    expect(fakeManager.restartRequests[0]?.contextDeliveryMode).toBe("resume");
    expect(fakeManager.wakeCalls).toHaveLength(0);
    expect(fakeManager.getSession("session-a")?.state).toBe("running");

    orchestrator.close();
  });

  it("does not restart a direct codex agent_mcp session while it still shows recent activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:00:00.000Z"));

    const store = new MemoryStore(":memory:");
    const agentA = store.registerAgent({ ide: "Codex", model: "Direct CLI", display_name: "Codex A" });
    const { thread } = store.createThread("codex-direct-recent-activity", undefined, undefined, {
      creatorAdminId: agentA.id,
      creatorAdminName: agentA.display_name,
    });

    const fakeManager = new FakeCliSessionManager([
      makeDirectSession({
        id: "session-a",
        thread_id: thread.id,
        thread_display_name: thread.topic,
        reentry_prompt_override: "Resume this existing meeting directly. Do not bus_connect again.",
        participant_agent_id: agentA.id,
        participant_display_name: agentA.display_name,
        participant_role: "administrator",
        state: "running",
        last_delivered_seq: 0,
        last_acknowledged_seq: 0,
        updated_at: "2026-03-23T12:00:00.000Z",
        last_output_at: "2026-03-23T12:00:00.000Z",
      }),
    ]);

    const orchestrator = new CliMeetingOrchestrator(
      store,
      fakeManager as unknown as CliSessionManager,
    );

    await (orchestrator as any).maybeDeliverIncrementalContext(
      fakeManager.getSession("session-a"),
      1,
    );

    expect(fakeManager.stopCalls).toHaveLength(0);
    expect(fakeManager.restartCalls).toHaveLength(0);
    expect((orchestrator as any).pendingDeliverySeqBySession.get("session-a")).toBe(1);

    orchestrator.close();
  });

  it("stops and restarts a stale direct codex agent_mcp session when a new thread message arrives", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:00:20.000Z"));

    const store = new MemoryStore(":memory:");
    const agentA = store.registerAgent({ ide: "Codex", model: "Direct CLI", display_name: "Codex A" });
    const { thread } = store.createThread("codex-direct-stale-restart", undefined, undefined, {
      creatorAdminId: agentA.id,
      creatorAdminName: agentA.display_name,
    });

    const fakeManager = new FakeCliSessionManager([
      makeDirectSession({
        id: "session-a",
        thread_id: thread.id,
        participant_agent_id: agentA.id,
        participant_display_name: agentA.display_name,
        participant_role: "administrator",
        state: "running",
        last_delivered_seq: 0,
        last_acknowledged_seq: 0,
        updated_at: "2026-03-23T12:00:00.000Z",
        last_output_at: "2026-03-23T12:00:00.000Z",
        external_session_id: "019d1d3a-611f-7e91-b1f1-b5a9d8079942",
      }),
    ]);

    const orchestrator = new CliMeetingOrchestrator(
      store,
      fakeManager as unknown as CliSessionManager,
    );

    postWithSync(store, thread.id, "Hank", "Please resume this thread now.", "user");

    // Advance fake timers to allow event handlers to process
    await vi.advanceTimersByTimeAsync(100);

    expect(fakeManager.stopCalls).toEqual(["session-a"]);
    expect(fakeManager.restartCalls).toEqual(["session-a"]);
    expect(fakeManager.restartRequests[0]?.prompt).toBe(
      "Resume this existing meeting directly. Do not bus_connect again.",
    );
    expect(fakeManager.restartRequests[0]?.promptHistoryKind).toBe("wake");
    expect(fakeManager.restartRequests[0]?.contextDeliveryMode).toBe("resume");
    expect(fakeManager.wakeCalls).toHaveLength(0);
    expect(fakeManager.getSession("session-a")?.state).toBe("running");

    orchestrator.close();
  });
});
