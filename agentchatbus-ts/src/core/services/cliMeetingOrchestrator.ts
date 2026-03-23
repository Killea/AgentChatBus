import { eventBus } from "../../shared/eventBus.js";
import { logError, logInfo } from "../../shared/logger.js";
import {
  buildCliIncrementalPrompt,
  buildCliMeetingPrompt,
  getThreadAdministratorInfo,
  type CliMeetingDeliveryMode,
  type CliMeetingParticipantRole,
} from "./cliMeetingContextBuilder.js";
import type { CliSessionManager, CliSessionSnapshot } from "./cliSessionManager.js";
import type { MemoryStore } from "./memoryStore.js";

const PARTICIPANT_HEARTBEAT_INTERVAL_MS = 10_000;
const MCP_WAKE_PROMPT_COOLDOWN_MS = 30_000;
const ONLINE_SESSION_STATES = new Set(["created", "starting", "running"]);
const RESTARTABLE_SESSION_STATES = new Set(["completed", "failed", "stopped"]);
const RELAY_BLOCKED_STATES = new Set(["stale", "error"]);
const DELIVERY_BUSY_REPLY_STATES = new Set(["waiting_for_reply", "working", "streaming"]);
const MEETING_CONTROL_MARKER = "agentchatbus_meeting_control";

function usesLegacyPtyRelay(session: CliSessionSnapshot): boolean {
  // The PTY relay path remains in-tree as a compatibility layer for non-MCP CLI flows.
  // Newer "agent_mcp" sessions bypass relay entirely and let the agent talk to the bus directly.
  return String(session.meeting_transport || "pty_relay") === "pty_relay";
}

function normalizeScreenText(value: string | undefined): string {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .toLowerCase();
}

function hasCodexPromptInScreen(screenExcerpt: string | undefined): boolean {
  const lines = String(screenExcerpt || "")
    .split("\n")
    .map((line) => line.trim());
  return lines.some((line) => /^(>|›)\s+/.test(line) || line === ">" || line === "›");
}

function looksLikeClaudeIdleScreen(screenExcerpt: string | undefined): boolean {
  const normalized = normalizeScreenText(screenExcerpt);
  if (!normalized) {
    return false;
  }
  // Claude shows simple prompts when ready
  return (
    normalized.includes("how can i help")
    || normalized.includes("what would you like")
    || normalized.includes("anything else")
    || /^[>\$#]\s*$/.test(normalized.trim())
  );
}

function looksLikeClaudeWorkingScreen(screenExcerpt: string | undefined): boolean {
  const normalized = normalizeScreenText(screenExcerpt);
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("thinking")
    || normalized.includes("working")
    || normalized.includes("processing")
  );
}

function looksLikeCodexIdleScreen(screenExcerpt: string | undefined): boolean {
  const normalized = normalizeScreenText(screenExcerpt);
  if (!normalized) {
    return false;
  }
  if (normalized.includes("working") && normalized.includes("esc to interrupt")) {
    return false;
  }
  if (normalized.includes("use /skills to list available skills")) {
    return true;
  }
  return hasCodexPromptInScreen(screenExcerpt);
}

function extractInteractiveWorkingStatus(screenExcerpt: string | undefined): string | undefined {
  const lines = String(screenExcerpt || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const normalizedLine = line.replace(/^[•·●◦]\s*/, "");
    const match = /^working\s*\((\d+s)(?:\s*[•·]\s*esc to interrupt)?\)$/i.exec(normalizedLine);
    if (match?.[1]) {
      return `Working... (${match[1]})`;
    }
    if (/^working\b/i.test(normalizedLine)) {
      return "Working...";
    }
  }
  return undefined;
}

function isInteractivePlaceholderContent(content: string | undefined): boolean {
  const normalized = String(content || "").trim();
  return /^Working\.\.\.(?: \(\d+s\))?$/.test(normalized) || normalized === "Thinking...";
}

type MeetingRoutingState = "online" | "offline";

interface MeetingControlDirective {
  action: "leave" | "summon";
  target_agent_id?: string;
  reason?: string;
}

interface RelayCandidate {
  content?: string;
  control?: MeetingControlDirective;
  rawReply?: string;
}

export interface PrepareCliMeetingSessionInput {
  threadId: string;
  participantAgentId: string;
  participantDisplayName?: string;
  initialInstruction?: string;
}

export interface PreparedCliMeetingSession {
  participantRole: CliMeetingParticipantRole;
  participantDisplayName: string;
  prompt: string;
  contextDeliveryMode: CliMeetingDeliveryMode;
  lastDeliveredSeq: number;
}

function getParticipantName(store: MemoryStore, participantAgentId: string, fallback?: string): string {
  const participant = store.getAgent(participantAgentId);
  return String(
    fallback || participant?.display_name || participant?.name || participantAgentId,
  ).trim() || participantAgentId;
}

function hasParticipantPosted(store: MemoryStore, threadId: string, participantAgentId: string): boolean {
  return store.getMessages(threadId, 0, false).some((message) => message.author_id === participantAgentId);
}

function getPostableReply(session: CliSessionSnapshot): string | undefined {
  const preferred = String(session.reply_capture_excerpt || "").trim();
  if (preferred) {
    return preferred;
  }
  if (session.mode === "interactive") {
    return undefined;
  }
  const fallback = String(session.last_result || "").trim();
  return fallback || undefined;
}

function getDesiredRelayContent(session: CliSessionSnapshot): string | undefined {
  const reply = getPostableReply(session);
  if (reply) {
    return reply;
  }
  if (session.mode === "interactive" && ONLINE_SESSION_STATES.has(session.state)) {
    return extractInteractiveWorkingStatus(session.screen_excerpt) || "Working...";
  }
  return undefined;
}

function normalizeMergeText(value: string | undefined): string {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function findLongestSuffixPrefixOverlap(left: string, right: string): number {
  const maxLength = Math.min(left.length, right.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (left.slice(-length) === right.slice(0, length)) {
      return length;
    }
  }
  return 0;
}

function findLongestLineSuffixPrefixOverlap(leftLines: string[], rightLines: string[]): number {
  const maxLength = Math.min(leftLines.length, rightLines.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (leftLines.slice(-length).join("\n") === rightLines.slice(0, length).join("\n")) {
      return length;
    }
  }
  return 0;
}

function mergeStreamingRelayContent(existingContent: string, nextContent: string): string {
  const existing = normalizeMergeText(existingContent);
  const next = normalizeMergeText(nextContent);
  if (!existing) {
    return next;
  }
  if (!next) {
    return existing;
  }
  if (existing === next) {
    return existing;
  }
  if (next.includes(existing)) {
    return next;
  }
  if (existing.includes(next)) {
    return existing;
  }

  const charOverlap = findLongestSuffixPrefixOverlap(existing, next);
  if (charOverlap > 0) {
    return `${existing}${next.slice(charOverlap)}`.trim();
  }

  const existingLines = existing.split("\n");
  const nextLines = next.split("\n");
  const lineOverlap = findLongestLineSuffixPrefixOverlap(existingLines, nextLines);
  if (lineOverlap > 0) {
    return [...existingLines, ...nextLines.slice(lineOverlap)].join("\n").trim();
  }

  return `${existing}\n${next}`.trim();
}

function shouldUseStreamingAppendMerge(session: CliSessionSnapshot): boolean {
  if (session.mode !== "interactive") {
    return false;
  }
  return DELIVERY_BUSY_REPLY_STATES.has(String(session.reply_capture_state || ""));
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractJsonCandidate(rawReply: string): string | undefined {
  const source = String(rawReply || "");
  const markerIndex = source.indexOf(MEETING_CONTROL_MARKER);
  if (markerIndex < 0) {
    return undefined;
  }

  let start = markerIndex;
  while (start >= 0 && source[start] !== "{") {
    start -= 1;
  }
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index] || "";
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

function parseMeetingControlDirective(rawReply: string): {
  content?: string;
  control?: MeetingControlDirective;
} {
  const normalizedReply = String(rawReply || "").trim();
  if (!normalizedReply || !normalizedReply.includes(MEETING_CONTROL_MARKER)) {
    return {
      content: normalizedReply || undefined,
    };
  }

  const jsonCandidate = extractJsonCandidate(normalizedReply);
  if (!jsonCandidate) {
    return {
      content: normalizedReply || undefined,
    };
  }

  try {
    const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
    const directiveRoot = parsed[MEETING_CONTROL_MARKER];
    if (!isObjectRecord(directiveRoot)) {
      return {
        content: normalizedReply || undefined,
      };
    }

    const action = String(directiveRoot.action || "").trim();
    if (action !== "leave" && action !== "summon") {
      return {
        content: normalizedReply || undefined,
      };
    }

    const control: MeetingControlDirective = {
      action,
      target_agent_id: typeof directiveRoot.target_agent_id === "string"
        ? directiveRoot.target_agent_id.trim() || undefined
        : undefined,
      reason: typeof directiveRoot.reason === "string"
        ? directiveRoot.reason.trim() || undefined
        : undefined,
    };
    const content = normalizedReply.replace(jsonCandidate, "").trim() || undefined;
    return { content, control };
  } catch {
    return {
      content: normalizedReply || undefined,
    };
  }
}

function routingKey(threadId: string, participantAgentId: string): string {
  return `${threadId}::${participantAgentId}`;
}

function buildMsgWaitWakePrompt(threadName: string): string {
  return [
    `Please use msg_wait to process messages in "${threadName}".`,
    "When you are ready to contribute, please prefer to use msg_post to share your opinion in the thread.",
  ].join(" ");
}

interface WakePromptRecord {
  seq: number;
  sentAt: number;
}

export class CliMeetingOrchestrator {
  private readonly inFlightRelaySyncs = new Set<string>();
  private readonly pendingRelayResyncs = new Set<string>();
  private readonly pendingDeliverySeqBySession = new Map<string, number>();
  private readonly lastWakePromptBySession = new Map<string, WakePromptRecord>();
  private readonly participantRoutingStates = new Map<string, MeetingRoutingState>();
  private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: MemoryStore,
    private readonly cliSessionManager: CliSessionManager,
  ) {
    this.unsubscribe = eventBus.subscribe((event) => {
      void this.handleEvent(event).catch((error: unknown) => {
        const detail = error instanceof Error ? (error.stack || error.message) : String(error);
        logError(`[cli-meeting] event handling failed: ${detail}`);
      });
    });
  }

  close(): void {
    this.unsubscribe();
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();
  }

  private isThreadClosedForCoordination(threadId: string): boolean {
    const thread = this.store.getThread(threadId);
    const status = String(thread?.status || "").trim().toLowerCase();
    return status === "closed" || status === "archived";
  }

  private clearThreadCoordinationState(threadId: string): void {
    const sessions = this.cliSessionManager.listSessionsForThread(threadId);
    for (const session of sessions) {
      this.pendingDeliverySeqBySession.delete(session.id);
      this.lastWakePromptBySession.delete(session.id);
      this.cliSessionManager.clearWakePromptState(session.id);
    }

    for (const key of Array.from(this.participantRoutingStates.keys())) {
      if (key.startsWith(`${threadId}::`)) {
        this.participantRoutingStates.delete(key);
      }
    }
  }

  prepareSession(input: PrepareCliMeetingSessionInput): PreparedCliMeetingSession {
    const participant = this.store.getAgent(input.participantAgentId);
    if (!participant) {
      throw new Error(`Participant agent '${input.participantAgentId}' not found.`);
    }

    // Keep CLI-invited agents in the thread participant set even before they post.
    // This mirrors bus_connect semantics more closely and keeps thread membership durable.
    this.store.addThreadParticipant(input.threadId, input.participantAgentId);

    let administrator = getThreadAdministratorInfo(this.store, input.threadId);
    let participantRole: CliMeetingParticipantRole =
      administrator.agentId === input.participantAgentId ? "administrator" : "participant";

    if (!administrator.agentId) {
      // For the first CLI agent in a thread with no administrator, persist it as the
      // creator administrator so the database state matches bus_connect-created threads.
      this.store.setCreatorAdmin(
        input.threadId,
        input.participantAgentId,
        getParticipantName(this.store, input.participantAgentId, input.participantDisplayName),
      );
      administrator = getThreadAdministratorInfo(this.store, input.threadId);
      participantRole = "administrator";
    }

    this.setParticipantRoutingState(input.threadId, input.participantAgentId, "online");

    const deliveryMode: CliMeetingDeliveryMode = hasParticipantPosted(
      this.store,
      input.threadId,
      input.participantAgentId,
    )
      ? "resume"
      : "join";

    const promptEnvelope = buildCliMeetingPrompt({
      store: this.store,
      threadId: input.threadId,
      participantAgentId: input.participantAgentId,
      participantDisplayName: input.participantDisplayName,
      participantRole,
      initialInstruction: input.initialInstruction,
      deliveryMode,
    });

    return {
      participantRole,
      participantDisplayName: getParticipantName(
        this.store,
        input.participantAgentId,
        input.participantDisplayName,
      ),
      prompt: promptEnvelope.prompt,
      contextDeliveryMode: promptEnvelope.deliveryMode,
      lastDeliveredSeq: promptEnvelope.deliveredSeq,
    };
  }

  private async handleEvent(event: Record<string, unknown>): Promise<void> {
    const type = String(event?.type || "");
    if (type === "thread.state" || type === "thread.closed") {
      const payload = event?.payload && typeof event.payload === "object"
        ? (event.payload as { id?: string; thread_id?: string; status?: string })
        : undefined;
      const threadId = String(payload?.thread_id || payload?.id || "").trim();
      const status = type === "thread.closed"
        ? "closed"
        : String(payload?.status || "").trim().toLowerCase();
      if (threadId && (status === "closed" || status === "archived")) {
        this.clearThreadCoordinationState(threadId);
      }
      return;
    }
    if (type === "msg.new") {
      await this.handleThreadMessage(event);
      return;
    }

    if (!type.startsWith("cli.session.")) {
      return;
    }

    const session = event?.payload && typeof event.payload === "object"
      ? (event.payload as { session?: CliSessionSnapshot }).session
      : undefined;
    if (!session?.participant_agent_id) {
      return;
    }
    if (!usesLegacyPtyRelay(session)) {
      await this.flushPendingDelivery(session);
      return;
    }

    this.syncParticipantPresence(session);
    await this.syncRelayMessage(session);
    await this.flushPendingDelivery(session);
  }

  private async handleThreadMessage(event: Record<string, unknown>): Promise<void> {
    const payload = event?.payload && typeof event.payload === "object"
      ? (event.payload as {
          thread_id?: string;
          seq?: number;
          author_id?: string;
          author_name?: string;
          role?: string;
          content?: string;
          metadata?: Record<string, unknown> | null;
        })
      : undefined;
    const threadId = String(payload?.thread_id || "").trim();
    if (!threadId) {
      return;
    }
    if (this.isThreadClosedForCoordination(threadId)) {
      this.clearThreadCoordinationState(threadId);
      return;
    }

    const metadata = payload?.metadata && typeof payload.metadata === "object"
      ? payload.metadata
      : null;
    const isInteractivePlaceholder =
      isInteractivePlaceholderContent(String(payload?.content || ""))
      && String(metadata?.cli_relay_mode || "") === "participant_session";
    if (isInteractivePlaceholder) {
      return;
    }

    this.adoptParticipantIdentityFromMessage(threadId, payload);

    const sessions = this.cliSessionManager.listSessionsForThread(threadId)
      .filter((session) => Boolean(session.participant_agent_id))
      .filter((session) => session.mode === "interactive");
    const targetSeq = Number.isFinite(Number(payload?.seq))
      ? Number(payload?.seq)
      : this.store.getThreadCurrentSeq(threadId);
    for (const session of sessions) {
      if (session.participant_agent_id && session.participant_agent_id === payload?.author_id) {
        continue;
      }
      await this.maybeDeliverIncrementalContext(session, targetSeq);
    }
  }

  private syncParticipantPresence(session: CliSessionSnapshot): void {
    const participantAgentId = session.participant_agent_id;
    if (!participantAgentId) {
      return;
    }

    if (ONLINE_SESSION_STATES.has(session.state)) {
      this.markParticipantOnline(participantAgentId, session.id);
      return;
    }

    this.clearHeartbeat(session.id);
    this.store.setAgentOnlineState(participantAgentId, false, `cli_session_${session.state}`);
  }

  private markParticipantOnline(participantAgentId: string, sessionId: string): void {
    const participant = this.store.getAgent(participantAgentId);
    const token = String(participant?.token || "");
    if (token) {
      this.store.heartbeatAgent(participantAgentId, token);
    } else {
      this.store.setAgentOnlineState(participantAgentId, true, "cli_session_running");
    }

    if (this.heartbeatTimers.has(sessionId)) {
      return;
    }

    const timer = setInterval(() => {
      const latest = this.cliSessionManager.getSession(sessionId);
      if (!latest?.participant_agent_id || !ONLINE_SESSION_STATES.has(latest.state)) {
        this.clearHeartbeat(sessionId);
        return;
      }

      const latestParticipant = this.store.getAgent(latest.participant_agent_id);
      const latestToken = String(latestParticipant?.token || "");
      if (latestToken) {
        this.store.heartbeatAgent(latest.participant_agent_id, latestToken);
        return;
      }

      this.store.setAgentOnlineState(latest.participant_agent_id, true, "cli_session_running");
    }, PARTICIPANT_HEARTBEAT_INTERVAL_MS);

    this.heartbeatTimers.set(sessionId, timer);
  }

  private clearHeartbeat(sessionId: string): void {
    const timer = this.heartbeatTimers.get(sessionId);
    if (!timer) {
      return;
    }
    clearInterval(timer);
    this.heartbeatTimers.delete(sessionId);
  }

  private getSessionWorkState(session: CliSessionSnapshot): "busy" | "idle" | "unavailable" {
    if (!ONLINE_SESSION_STATES.has(session.state)) {
      return "unavailable";
    }

    if (String(session.meeting_post_state || "") === "posting") {
      return "busy";
    }
    if (DELIVERY_BUSY_REPLY_STATES.has(String(session.reply_capture_state || ""))) {
      return "busy";
    }
    if (["codex_working", "claude_working", "cursor_working"].includes(String(session.automation_state || ""))) {
      return "busy";
    }

    if (session.adapter === "claude" && session.mode === "interactive") {
      if (looksLikeClaudeWorkingScreen(session.screen_excerpt)) {
        return "busy";
      }
      if (looksLikeClaudeIdleScreen(session.screen_excerpt)) {
        return "idle";
      }
      if (["completed", "timeout", "error"].includes(String(session.reply_capture_state || ""))) {
        return "idle";
      }
    }

    if (session.mode === "interactive" && looksLikeCodexIdleScreen(session.screen_excerpt)) {
      return "idle";
    }
    if (
      session.mode === "interactive"
      && ["completed", "timeout", "error"].includes(String(session.reply_capture_state || ""))
      && !looksLikeCodexIdleScreen(session.screen_excerpt)
      && !String(session.screen_excerpt || "").trim()
    ) {
      return "idle";
    }
    if (session.mode === "interactive" && session.state === "running") {
      return "idle";
    }
    if (session.mode === "headless") {
      return "busy";
    }
    return "unavailable";
  }

  private isMultiParticipantThread(threadId: string): boolean {
    const participantIds = new Set(
      this.cliSessionManager
        .listSessionsForThread(threadId)
        .map((session) => String(session.participant_agent_id || "").trim())
        .filter(Boolean),
    );
    return participantIds.size > 1;
  }

  private getParticipantRoutingState(threadId: string, participantAgentId: string): MeetingRoutingState {
    return this.participantRoutingStates.get(routingKey(threadId, participantAgentId)) || "online";
  }

  private setParticipantRoutingState(
    threadId: string,
    participantAgentId: string,
    state: MeetingRoutingState,
  ): void {
    this.participantRoutingStates.set(routingKey(threadId, participantAgentId), state);
  }

  private getRelayCandidate(session: CliSessionSnapshot): RelayCandidate | undefined {
    const desiredContent = getDesiredRelayContent(session);
    if (!desiredContent) {
      return undefined;
    }
    if (isInteractivePlaceholderContent(desiredContent)) {
      return { content: desiredContent };
    }
    const parsed = parseMeetingControlDirective(desiredContent);
    return {
      content: parsed.content,
      control: parsed.control,
      rawReply: desiredContent,
    };
  }

  private async applyMeetingControl(
    session: CliSessionSnapshot,
    control: MeetingControlDirective | undefined,
  ): Promise<void> {
    if (!control || !session.participant_agent_id) {
      return;
    }
    if (!this.isMultiParticipantThread(session.thread_id)) {
      return;
    }

    if (control.action === "leave") {
      this.setParticipantRoutingState(session.thread_id, session.participant_agent_id, "offline");
      logInfo(
        `[cli-meeting] participant ${session.participant_agent_id} left automatic routing in thread ${session.thread_id}`,
      );
      return;
    }

    const targetAgentId = String(control.target_agent_id || "").trim();
    if (!targetAgentId || targetAgentId === session.participant_agent_id) {
      return;
    }
    if (!this.store.getAgent(targetAgentId)) {
      return;
    }
    if (this.getParticipantRoutingState(session.thread_id, targetAgentId) === "online") {
      return;
    }

    this.setParticipantRoutingState(session.thread_id, targetAgentId, "online");
    logInfo(
      `[cli-meeting] participant ${session.participant_agent_id} summoned ${targetAgentId} in thread ${session.thread_id}`,
    );

    const targetSession = this.cliSessionManager
      .listSessionsForThread(session.thread_id)
      .find((candidate) => candidate.participant_agent_id === targetAgentId);
    if (targetSession) {
      await this.maybeDeliverIncrementalContext(targetSession);
    }
  }

  private async maybeDeliverIncrementalContext(
    session: CliSessionSnapshot,
    requestedTargetSeq?: number,
  ): Promise<void> {
    if (this.isThreadClosedForCoordination(session.thread_id)) {
      this.pendingDeliverySeqBySession.delete(session.id);
      this.lastWakePromptBySession.delete(session.id);
      this.cliSessionManager.clearWakePromptState(session.id);
      return;
    }
    if (!session.participant_agent_id) {
      return;
    }
    if (session.mode !== "interactive") {
      return;
    }
    const deliveredSeq = Number(session.last_delivered_seq) || 0;
    const pendingSeq = this.pendingDeliverySeqBySession.get(session.id) || 0;
    const latestSeq = Number.isFinite(Number(requestedTargetSeq))
      ? Number(requestedTargetSeq)
      : Math.max(
        pendingSeq,
        this.store.getThreadCurrentSeq(session.thread_id),
      );
    if (
      this.isMultiParticipantThread(session.thread_id)
      && this.getParticipantRoutingState(session.thread_id, session.participant_agent_id) !== "online"
    ) {
      this.pendingDeliverySeqBySession.set(
        session.id,
        Math.max(pendingSeq, latestSeq),
      );
      return;
    }
    if (Number.isFinite(Number(requestedTargetSeq))) {
      if (latestSeq <= deliveredSeq) {
        return;
      }
    } else if (latestSeq <= Math.max(deliveredSeq, pendingSeq)) {
      return;
    }

    if (!usesLegacyPtyRelay(session) && this.isParticipantActivelyWaiting(session.thread_id, session.participant_agent_id)) {
      // When the participant is actively blocked in msg_wait, the bus itself will
      // deliver the new message. Do not queue a redundant wake-up or restart.
      this.pendingDeliverySeqBySession.delete(session.id);
      this.lastWakePromptBySession.delete(session.id);
      this.cliSessionManager.clearWakePromptState(session.id);
      return;
    }

    const workState = this.getSessionWorkState(session);
    if (!usesLegacyPtyRelay(session) && workState === "unavailable") {
      if (
        RESTARTABLE_SESSION_STATES.has(String(session.state || ""))
        && session.supports_restart
      ) {
        try {
          const restarted = await this.cliSessionManager.restartSession(session.id);
          if (restarted) {
            this.pendingDeliverySeqBySession.delete(session.id);
            logInfo(
              `[cli-meeting] restarted agent_mcp session ${session.id} to resume thread ${session.thread_id}`,
            );
            return;
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.pendingDeliverySeqBySession.set(
            session.id,
            Math.max(pendingSeq, latestSeq),
          );
          logInfo(
            `[cli-meeting] delayed restart for session ${session.id}; session is not restart-ready yet (${detail})`,
          );
          return;
        }
      }
      this.pendingDeliverySeqBySession.set(
        session.id,
        Math.max(pendingSeq, latestSeq),
      );
      return;
    }
    if (workState !== "idle") {
      this.pendingDeliverySeqBySession.set(
        session.id,
        Math.max(pendingSeq, latestSeq),
      );
      return;
    }

    if (!usesLegacyPtyRelay(session)) {
      const wakeRecord = this.lastWakePromptBySession.get(session.id);
      if (wakeRecord && Date.now() - wakeRecord.sentAt < MCP_WAKE_PROMPT_COOLDOWN_MS) {
        this.pendingDeliverySeqBySession.set(
          session.id,
          Math.max(pendingSeq, latestSeq),
        );
        return;
      }

      const thread = this.store.getThread(session.thread_id);
      const threadName = String(thread?.topic || session.thread_id).trim() || session.thread_id;
      const result = await this.cliSessionManager.deliverWakePrompt(
        session.id,
        buildMsgWaitWakePrompt(threadName),
      );
      if (!result?.ok) {
        this.pendingDeliverySeqBySession.set(session.id, latestSeq);
        if (result?.error) {
          logError(`[cli-meeting] failed to wake agent_mcp session ${session.id}: ${result.error}`);
        }
        return;
      }

      this.lastWakePromptBySession.set(session.id, {
        seq: latestSeq,
        sentAt: Date.now(),
      });
      this.pendingDeliverySeqBySession.delete(session.id);
      logInfo(
        `[cli-meeting] delivered msg_wait wake prompt for thread ${session.thread_id} to session ${session.id}`,
      );
      return;
    }

    const envelope = buildCliIncrementalPrompt({
      store: this.store,
      threadId: session.thread_id,
      participantAgentId: session.participant_agent_id,
      participantDisplayName: session.participant_display_name,
      participantRole: session.participant_role || "participant",
      lastDeliveredSeq: deliveredSeq,
      targetSeq: latestSeq,
    });

    if (envelope.deliveredSeq <= deliveredSeq) {
      this.pendingDeliverySeqBySession.delete(session.id);
      return;
    }

    const result = await this.cliSessionManager.deliverPrompt(session.id, envelope.prompt, {
      deliveryMode: envelope.deliveryMode,
      deliveredSeq: envelope.deliveredSeq,
    });
    if (!result?.ok) {
      this.pendingDeliverySeqBySession.set(session.id, latestSeq);
      if (result?.error) {
        logError(`[cli-meeting] failed to deliver incremental context to ${session.id}: ${result.error}`);
      }
      return;
    }

    this.pendingDeliverySeqBySession.delete(session.id);
    logInfo(
      `[cli-meeting] delivered incremental context through seq ${envelope.deliveredSeq} to session ${session.id}`,
    );
  }

  private isParticipantActivelyWaiting(threadId: string, participantAgentId: string): boolean {
    const waitStates = this.store.getThreadWaitStates(threadId);
    return Boolean(waitStates[participantAgentId]);
  }

  private async flushPendingDelivery(session: CliSessionSnapshot): Promise<void> {
    const pendingSeq = this.pendingDeliverySeqBySession.get(session.id);
    if (!pendingSeq) {
      return;
    }
    if (this.getSessionWorkState(session) !== "idle") {
      return;
    }
    await this.maybeDeliverIncrementalContext(session, pendingSeq);
  }

  private adoptParticipantIdentityFromMessage(
    threadId: string,
    payload: {
      author_id?: string;
      author_name?: string;
      role?: string;
    } | undefined,
  ): void {
    const authorId = String(payload?.author_id || "").trim();
    const role = String(payload?.role || "").trim().toLowerCase();
    if (!authorId || authorId === "system" || role !== "assistant") {
      return;
    }

    const sessions = this.cliSessionManager.listSessionsForThread(threadId)
      .filter((session) => session.mode === "interactive")
      .filter((session) => !usesLegacyPtyRelay(session))
      .filter((session) => Boolean(session.participant_agent_id));
    if (sessions.some((session) => session.participant_agent_id === authorId)) {
      return;
    }

    const candidates = sessions
      .filter((session) => ONLINE_SESSION_STATES.has(session.state))
      .filter((session) => !hasParticipantPosted(this.store, threadId, session.participant_agent_id || ""));
    if (candidates.length !== 1) {
      return;
    }

    const candidate = candidates[0];
    const previousAgentId = String(candidate.participant_agent_id || "").trim();
    if (!previousAgentId || previousAgentId === authorId) {
      return;
    }

    this.cliSessionManager.updateMeetingState(candidate.id, {
      participant_agent_id: authorId,
    });
    this.store.replaceThreadParticipantIdentity(threadId, previousAgentId, authorId);

    const previousRoutingState = this.getParticipantRoutingState(threadId, previousAgentId);
    this.participantRoutingStates.delete(routingKey(threadId, previousAgentId));
    this.participantRoutingStates.set(routingKey(threadId, authorId), previousRoutingState);

    const actualAgent = this.store.getAgent(authorId);
    const adoptedName = String(
      candidate.participant_display_name
      || actualAgent?.display_name
      || actualAgent?.name
      || payload?.author_name
      || authorId,
    ).trim() || authorId;
    if (candidate.participant_display_name !== adoptedName) {
      this.cliSessionManager.updateMeetingState(candidate.id, {
        participant_display_name: adoptedName,
      });
    }
    const administrator = getThreadAdministratorInfo(this.store, threadId);
    this.cliSessionManager.updateMeetingState(candidate.id, {
      participant_role: administrator.agentId === authorId ? "administrator" : "participant",
    });

    logInfo(
      `[cli-meeting] adopted live participant identity ${authorId} for session ${candidate.id} (was ${previousAgentId})`,
    );
  }

  private async syncRelayMessage(session: CliSessionSnapshot): Promise<void> {
    const sessionId = session.id;
    if (this.inFlightRelaySyncs.has(sessionId)) {
      this.pendingRelayResyncs.add(sessionId);
      return;
    }

    this.inFlightRelaySyncs.add(sessionId);
    try {
      let latestSession = session;
      while (true) {
        this.pendingRelayResyncs.delete(sessionId);
        latestSession = this.cliSessionManager.getSession(sessionId) || latestSession;
        await this.syncRelayMessageOnce(latestSession);
        if (!this.pendingRelayResyncs.has(sessionId)) {
          break;
        }
      }
    } finally {
      this.inFlightRelaySyncs.delete(sessionId);
    }
  }

  private async syncRelayMessageOnce(session: CliSessionSnapshot): Promise<void> {
    if (this.isThreadClosedForCoordination(session.thread_id)) {
      this.pendingRelayResyncs.delete(session.id);
      return;
    }
    if (!session.participant_agent_id) {
      return;
    }
    if (RELAY_BLOCKED_STATES.has(String(session.meeting_post_state || ""))) {
      return;
    }

    const relayCandidate = this.getRelayCandidate(session);
    if (!relayCandidate?.content && !relayCandidate?.control) {
      return;
    }
    const desiredContent = relayCandidate.content;

    if (!session.last_posted_message_id) {
      const latestSeq = this.store.getThreadCurrentSeq(session.thread_id);
      const deliveredSeq = Number.isFinite(Number(session.last_delivered_seq))
        ? Number(session.last_delivered_seq)
        : undefined;
      const shouldBlockFirstRelayAsStale =
        deliveredSeq !== undefined
        && latestSeq > deliveredSeq
        && (session.mode === "headless" || !isInteractivePlaceholderContent(desiredContent));
      if (shouldBlockFirstRelayAsStale) {
        this.cliSessionManager.updateMeetingState(session.id, {
          meeting_post_state: "stale",
          meeting_post_error:
            `Thread advanced from seq ${deliveredSeq} to ${latestSeq} before the CLI reply was relayed. Restart the session to resync context.`,
        });
        return;
      }
    }

    if (!desiredContent) {
      await this.applyMeetingControl(session, relayCandidate.control);
      this.cliSessionManager.updateMeetingState(session.id, {
        meeting_post_state: "posted",
        meeting_post_error: "",
        last_acknowledged_seq: Number(session.last_delivered_seq) || 0,
      });
      return;
    }

    if (session.last_posted_message_id) {
      const existingMessage = this.store.getMessage(session.last_posted_message_id);
      if (!existingMessage) {
        this.cliSessionManager.updateMeetingState(session.id, {
          meeting_post_state: "error",
          meeting_post_error:
            `Previously relayed message '${session.last_posted_message_id}' could not be found for session sync.`,
        });
        return;
      }
      if (existingMessage.content === desiredContent) {
        if (session.meeting_post_state !== "posted" || session.meeting_post_error) {
          this.cliSessionManager.updateMeetingState(session.id, {
            meeting_post_state: "posted",
            meeting_post_error: "",
            last_posted_seq: existingMessage.seq,
            last_posted_message_id: existingMessage.id,
          });
        }
        return;
      }

      const nextContent =
        shouldUseStreamingAppendMerge(session)
        && !isInteractivePlaceholderContent(existingMessage.content)
        && !isInteractivePlaceholderContent(desiredContent)
          ? mergeStreamingRelayContent(existingMessage.content, desiredContent)
          : desiredContent;

      if (existingMessage.content === nextContent) {
        if (session.meeting_post_state !== "posted" || session.meeting_post_error) {
          this.cliSessionManager.updateMeetingState(session.id, {
            meeting_post_state: "posted",
            meeting_post_error: "",
            last_posted_seq: existingMessage.seq,
            last_posted_message_id: existingMessage.id,
          });
        }
        return;
      }

      this.cliSessionManager.updateMeetingState(session.id, {
        meeting_post_state: "posting",
        meeting_post_error: "",
      });
      const edited = this.store.editMessage(
        existingMessage.id,
        nextContent,
        session.participant_agent_id,
      );
      if (!edited) {
        throw new Error(`Relay message '${existingMessage.id}' could not be edited.`);
      }
      this.cliSessionManager.updateMeetingState(session.id, {
        meeting_post_state: "posted",
        meeting_post_error: "",
        last_acknowledged_seq: Number(session.last_delivered_seq) || 0,
        last_posted_seq: existingMessage.seq,
        last_posted_message_id: existingMessage.id,
      });
      await this.applyMeetingControl(session, relayCandidate.control);
      logInfo(
        `[cli-meeting] updated relayed message ${existingMessage.id} for session ${session.id}`,
      );
      return;
    }

    this.cliSessionManager.updateMeetingState(session.id, {
      meeting_post_state: "posting",
      meeting_post_error: "",
    });
    const sync = this.store.issueSyncContext(
      session.thread_id,
      session.participant_agent_id,
      "cli_meeting_relay",
    );
    const message = this.store.postMessage({
      threadId: session.thread_id,
      author: session.participant_agent_id,
      content: desiredContent,
      role: "assistant",
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
      metadata: {
        cli_session_id: session.id,
        cli_relay_mode: "participant_session",
        participant_agent_id: session.participant_agent_id,
        participant_role: session.participant_role || "participant",
        context_delivery_mode: session.context_delivery_mode || "join",
      },
    });

    this.cliSessionManager.updateMeetingState(session.id, {
      meeting_post_state: "posted",
      meeting_post_error: "",
      last_acknowledged_seq: Number(session.last_delivered_seq) || 0,
      last_posted_seq: message.seq,
      last_posted_message_id: message.id,
    });
    await this.applyMeetingControl(session, relayCandidate.control);
    logInfo(
      `[cli-meeting] created relayed message ${message.id} seq=${message.seq} for session ${session.id}`,
    );
  }
}
