import { eventBus } from "../../shared/eventBus.js";
import { logError, logInfo } from "../../shared/logger.js";
import {
  buildCliMeetingPrompt,
  getThreadAdministratorInfo,
  type CliMeetingDeliveryMode,
  type CliMeetingParticipantRole,
} from "./cliMeetingContextBuilder.js";
import type { CliSessionManager, CliSessionSnapshot } from "./cliSessionManager.js";
import type { MemoryStore } from "./memoryStore.js";

const PARTICIPANT_HEARTBEAT_INTERVAL_MS = 10_000;
const ONLINE_SESSION_STATES = new Set(["created", "starting", "running"]);
const RELAY_BLOCKED_STATES = new Set(["stale", "error"]);
const INTERACTIVE_PLACEHOLDER_REPLY = "Thinking...";

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
    return INTERACTIVE_PLACEHOLDER_REPLY;
  }
  return undefined;
}

export class CliMeetingOrchestrator {
  private readonly inFlightRelaySyncs = new Set<string>();
  private readonly pendingRelayResyncs = new Set<string>();
  private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: MemoryStore,
    private readonly cliSessionManager: CliSessionManager,
  ) {
    this.unsubscribe = eventBus.subscribe((event) => {
      void this.handleEvent(event);
    });
  }

  close(): void {
    this.unsubscribe();
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();
  }

  prepareSession(input: PrepareCliMeetingSessionInput): PreparedCliMeetingSession {
    const participant = this.store.getAgent(input.participantAgentId);
    if (!participant) {
      throw new Error(`Participant agent '${input.participantAgentId}' not found.`);
    }

    this.store.addThreadParticipant(input.threadId, input.participantAgentId);

    let administrator = getThreadAdministratorInfo(this.store, input.threadId);
    let participantRole: CliMeetingParticipantRole =
      administrator.agentId === input.participantAgentId ? "administrator" : "participant";

    if (!administrator.agentId) {
      this.store.assignAdmin(
        input.threadId,
        input.participantAgentId,
        getParticipantName(this.store, input.participantAgentId, input.participantDisplayName),
      );
      administrator = getThreadAdministratorInfo(this.store, input.threadId);
      participantRole = "administrator";
    }

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
    if (!type.startsWith("cli.session.")) {
      return;
    }

    const session = event?.payload && typeof event.payload === "object"
      ? (event.payload as { session?: CliSessionSnapshot }).session
      : undefined;
    if (!session?.participant_agent_id) {
      return;
    }

    this.syncParticipantPresence(session);
    await this.syncRelayMessage(session);
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
    if (!session.participant_agent_id) {
      return;
    }
    if (RELAY_BLOCKED_STATES.has(String(session.meeting_post_state || ""))) {
      return;
    }

    const desiredContent = getDesiredRelayContent(session);
    if (!desiredContent) {
      return;
    }

    if (!session.last_posted_message_id) {
      const latestSeq = this.store.getThreadCurrentSeq(session.thread_id);
      const deliveredSeq = Number.isFinite(Number(session.last_delivered_seq))
        ? Number(session.last_delivered_seq)
        : undefined;
      const shouldBlockFirstRelayAsStale =
        deliveredSeq !== undefined
        && latestSeq > deliveredSeq
        && (session.mode === "headless" || desiredContent !== INTERACTIVE_PLACEHOLDER_REPLY);
      if (shouldBlockFirstRelayAsStale) {
        this.cliSessionManager.updateMeetingState(session.id, {
          meeting_post_state: "stale",
          meeting_post_error:
            `Thread advanced from seq ${deliveredSeq} to ${latestSeq} before the CLI reply was relayed. Restart the session to resync context.`,
        });
        return;
      }
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

      this.cliSessionManager.updateMeetingState(session.id, {
        meeting_post_state: "posting",
        meeting_post_error: "",
      });
      const edited = this.store.editMessage(
        existingMessage.id,
        desiredContent,
        session.participant_agent_id,
      );
      if (!edited) {
        throw new Error(`Relay message '${existingMessage.id}' could not be edited.`);
      }
      this.cliSessionManager.updateMeetingState(session.id, {
        meeting_post_state: "posted",
        meeting_post_error: "",
        last_posted_seq: existingMessage.seq,
        last_posted_message_id: existingMessage.id,
      });
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
      last_posted_seq: message.seq,
      last_posted_message_id: message.id,
    });
    logInfo(
      `[cli-meeting] created relayed message ${message.id} seq=${message.seq} for session ${session.id}`,
    );
  }
}
