import { randomUUID } from "node:crypto";
import xtermHeadless from "@xterm/headless";
import { getConfig } from "../config/registry.js";
import { eventBus } from "../../shared/eventBus.js";
import { logError, logInfo } from "../../shared/logger.js";
import { CursorInteractiveAdapter } from "./adapters/cursorInteractiveAdapter.js";
import { CursorDirectAdapter } from "./adapters/cursorDirectAdapter.js";
import { CodexInteractiveAdapter } from "./adapters/codexInteractiveAdapter.js";
import { CodexDirectAdapter } from "./adapters/codexDirectAdapter.js";
import { ClaudeDirectAdapter } from "./adapters/claudeDirectAdapter.js";
import { ClaudeInteractiveAdapter } from "./adapters/claudeInteractiveAdapter.js";
import { GeminiInteractiveAdapter } from "./adapters/geminiInteractiveAdapter.js";
import { CopilotDirectAdapter } from "./adapters/copilotDirectAdapter.js";
import { CopilotInteractiveAdapter } from "./adapters/copilotInteractiveAdapter.js";
import { CURSOR_SESSION_ID_ENV_VAR, CursorHeadlessAdapter } from "./adapters/cursorHeadlessAdapter.js";
import { CODEX_THREAD_ID_ENV_VAR, CodexHeadlessAdapter } from "./adapters/codexHeadlessAdapter.js";
import { COPILOT_SESSION_ID_ENV_VAR, CopilotHeadlessAdapter } from "./adapters/copilotHeadlessAdapter.js";
import { CLAUDE_SESSION_ID_ENV_VAR, ClaudeHeadlessAdapter } from "./adapters/claudeHeadlessAdapter.js";
import { GEMINI_SESSION_ID_ENV_VAR, GeminiHeadlessAdapter } from "./adapters/geminiHeadlessAdapter.js";
import { isCodexWorkingLine, looksLikeConversationalWorkingScreen } from "./cliInteractiveHeuristics.js";
import { buildCliMeetingWakePrompt } from "./cliMeetingContextBuilder.js";

type HeadlessTerminalInstance = import("@xterm/headless").Terminal;
const { Terminal: HeadlessTerminal } = xtermHeadless;

export type CliSessionAdapterId = "cursor" | "codex" | "claude" | "gemini" | "copilot";
export type CliSessionMode = "headless" | "interactive" | "direct";
export type CliSessionState =
  | "created"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "stopped";
export type CliSessionStream = "stdout" | "stderr";
export type CliNativeActivityCardShellStatus =
  | "starting"
  | "connected"
  | "running"
  | "completed"
  | "stopped"
  | "failed";
export type CliNativeActivityCardSectionKind =
  | "thinking"
  | "tool"
  | "command"
  | "files"
  | "plan"
  | "diff"
  | "task"
  | "placeholder";

export type CliNativeActivityCardBlockKind =
  | "message"
  | "thinking"
  | "tool"
  | "command"
  | "files"
  | "diff"
  | "plan"
  | "task"
  | "placeholder";

export interface CliNativeActivityCardSectionItem {
  label: string;
  value?: string;
  status?: string;
  kind?: string;
}

export interface CliNativeActivityCardBlockItem {
  label: string;
  value?: string;
  status?: string;
  kind?: string;
}

export interface CliNativeActivityCardSection {
  kind: CliNativeActivityCardSectionKind;
  title: string;
  summary: string;
  status: "in_progress" | "completed" | "failed" | "placeholder";
  meta?: string;
  items?: CliNativeActivityCardSectionItem[];
}

export interface CliNativeActivityCardBlock {
  id: string;
  kind: CliNativeActivityCardBlockKind;
  status: "in_progress" | "completed" | "failed" | "placeholder";
  updated_at: string;
  title?: string;
  summary?: string;
  content?: string;
  meta?: string;
  command?: string;
  cwd?: string;
  duration_ms?: number;
  files?: Array<{
    path: string;
    change_type?: "add" | "delete" | "update";
    move_path?: string | null;
  }>;
  diff?: string;
  items?: CliNativeActivityCardBlockItem[];
}

export interface CliNativeActivityCard {
  anchor_message_id?: string;
  shell_status: CliNativeActivityCardShellStatus;
  shell_status_text: string;
  updated_at: string;
  placeholder_visible: boolean;
  content_blocks?: CliNativeActivityCardBlock[];
  content_sections: CliNativeActivityCardSection[];
}

export interface CliSessionWaitStatusSnapshot {
  is_waiting: boolean;
  status: "waiting" | "completed" | "canceled" | "cleared" | "idle";
  wait_call_id?: string;
  entered_at?: string;
  timeout_ms?: number;
  last_exit_reason?: string;
  last_exited_at?: string;
}

export type CliNativeThreadStatusType = "notLoaded" | "idle" | "systemError" | "active";
export type CliNativeThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";
export type CliNativeTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type CliNativeTurnPhase =
  | "idle"
  | "starting"
  | "running"
  | "interrupting"
  | "completed"
  | "interrupted"
  | "failed";

export interface CliNativeTurnRuntime {
  updated_at: string;
  thread_id?: string;
  thread_status_type?: CliNativeThreadStatusType;
  thread_active_flags?: CliNativeThreadActiveFlag[];
  active_turn_id?: string;
  last_turn_id?: string;
  turn_status?: CliNativeTurnStatus;
  phase: CliNativeTurnPhase;
  last_error?: string;
}

export interface CliSessionSnapshot {
  id: string;
  thread_id: string;
  thread_display_name?: string;
  reentry_prompt_override?: string;
  adapter: CliSessionAdapterId;
  mode: CliSessionMode;
  model?: string;
  reasoning_effort?: string;
  permission_mode?: string;
  state: CliSessionState;
  prompt: string;
  prompt_history?: Array<{
    at: string;
    kind: "initial" | "update" | "wake" | "delivery";
    prompt: string;
  }>;
  initial_instruction?: string;
  workspace: string;
  requested_by_agent_id: string;
  participant_agent_id?: string;
  participant_display_name?: string;
  participant_role?: "administrator" | "participant";
  meeting_transport?: CliMeetingTransport;
  created_at: string;
  updated_at: string;
  run_count: number;
  supports_input: boolean;
  supports_restart: boolean;
  supports_resize: boolean;
  pid?: number;
  last_error?: string;
  last_result?: string;
  raw_result?: Record<string, unknown> | null;
  external_session_id?: string;
  external_request_id?: string;
  exit_code?: number | null;
  stdout_excerpt?: string;
  stderr_excerpt?: string;
  output_cursor: number;
  cols?: number;
  rows?: number;
  shell?: string;
  screen_excerpt?: string;
  screen_cursor_x?: number;
  screen_cursor_y?: number;
  screen_buffer?: "normal" | "alternate";
  interactive_work_state?: "busy" | "idle";
  interactive_work_reason?: string;
  automation_state?: string;
  reply_capture_state?: string;
  reply_capture_excerpt?: string;
  reply_capture_error?: string;
  context_delivery_mode?: "join" | "resume" | "incremental";
  last_delivered_seq?: number;
  last_acknowledged_seq?: number;
  last_posted_seq?: number;
  meeting_post_state?: "pending" | "posting" | "posted" | "stale" | "error";
  meeting_post_error?: string;
  last_posted_message_id?: string;
  launch_started_at?: string;
  process_started_at?: string;
  first_output_at?: string;
  last_output_at?: string;
  connected_at?: string;
  last_tool_call_at?: string;
  recent_tool_events?: Array<{
    at: string;
    tool_name: string;
  }>;
  recent_stream_events?: Array<{
    at: string;
    stream: CliSessionStream;
  }>;
  reentry_prompt?: {
    resolved_kind: "wake";
    resolved_prompt: string;
    resolved_at: string;
    last_sent_prompt?: string;
    last_sent_at?: string;
  };
  recent_activity_events?: CliAdapterActivityEvent[];
  native_turn_runtime?: CliNativeTurnRuntime;
  wait_status?: CliSessionWaitStatusSnapshot;
  native_activity_card?: CliNativeActivityCard;
}

export interface CliSessionOutputEntry {
  seq: number;
  stream: CliSessionStream;
  text: string;
  created_at: string;
}

export interface CreateCliSessionInput {
  threadId: string;
  threadDisplayName?: string;
  reentryPromptOverride?: string;
  adapter: CliSessionAdapterId;
  mode?: CliSessionMode;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
  prompt?: string;
  initialInstruction?: string;
  workspace?: string;
  requestedByAgentId: string;
  participantAgentId?: string;
  participantDisplayName?: string;
  participantRole?: "administrator" | "participant";
  meetingTransport?: CliMeetingTransport;
  contextDeliveryMode?: "join" | "resume" | "incremental";
  lastDeliveredSeq?: number;
  cols?: number;
  rows?: number;
  launchEnv?: Record<string, string>;
}

export interface CliSessionMeetingStatePatch {
  participant_agent_id?: string;
  participant_display_name?: string;
  participant_role?: "administrator" | "participant";
  context_delivery_mode?: "join" | "resume" | "incremental";
  last_delivered_seq?: number;
  last_acknowledged_seq?: number;
  last_posted_seq?: number;
  meeting_post_state?: "pending" | "posting" | "posted" | "stale" | "error";
  meeting_post_error?: string;
  last_posted_message_id?: string;
}

export interface CliSessionPromptPatch {
  prompt: string;
}

function getDefaultModeForAdapter(adapterId: CliSessionAdapterId): CliSessionMode {
  return adapterId === "codex" || adapterId === "claude" || adapterId === "copilot" || adapterId === "cursor"
    ? "direct"
    : "interactive";
}

function getDefaultPermissionModeForAdapter(adapterId: CliSessionAdapterId): string | undefined {
  return adapterId === "claude" ? "dontAsk" : undefined;
}

type CliSessionControls = {
  kill?: () => void;
  write?: (text: string) => void;
  resize?: (cols: number, rows: number) => void;
};

type CliSessionRuntime = {
  snapshot: CliSessionSnapshot;
  output: CliSessionOutputEntry[];
  outputParseBuffer: string;
  stopRequested: boolean;
  abortController: AbortController | null;
  runPromise: Promise<void> | null;
  controls: CliSessionControls | null;
  screenState: CliSessionScreenRuntime | null;
  automationState: CliSessionAutomationRuntime | null;
  replyCapture: CliSessionReplyCaptureRuntime | null;
  launchEnv: Record<string, string>;
};

type CliSessionScreenSnapshot = {
  text: string;
  normalizedText: string;
  cursorX: number;
  cursorY: number;
  bufferType: "normal" | "alternate";
};

type CliSessionScreenRuntime = {
  terminal: HeadlessTerminalInstance;
  writeQueue: Promise<void>;
  latest: CliSessionScreenSnapshot;
};

type CliSessionAutomationRuntime = {
  profile: "codex-startup";
  continueSent: boolean;
  initialPromptTextScheduled: boolean;
  initialPromptTextSent: boolean;
  initialPromptEnterSent: boolean;
  initialPromptEnterRetried: boolean;
  deliveryPromptEnterRetried: boolean;
  wakePromptText?: string;
  wakePromptEnterSent: boolean;
  wakePromptEnterRetried: boolean;
  manualOverride: boolean;
  sawReadyScreen: boolean;
  sawWorkingScreen: boolean;
  submitTimer: NodeJS.Timeout | null;
  toolApprovalRetryTimer: NodeJS.Timeout | null;
  activitySettleTimer: NodeJS.Timeout | null;
  lastCopilotToolApprovalAt?: number;
  lastCopilotToolApprovalKey?: string;
  lastCopilotDecisionAt?: number;
  lastCopilotDecisionKey?: string;
  lastCopilotActivityMarker?: string;
  lastCopilotActivityChangedAt?: number;
  copilotCorrectionSent?: boolean;
  copilotAskUserCorrectionSent?: boolean;
};

type CliSessionReplyCaptureState =
  | "waiting_for_reply"
  | "working"
  | "streaming"
  | "completed"
  | "timeout"
  | "error";

type CliSessionReplyCaptureRuntime = {
  mode: "initial_prompt";
  prompt: string;
  rawOutput: string;
  state: CliSessionReplyCaptureState;
  baselineExcerpt?: string;
  excerpt?: string;
  error?: string;
  timeoutTimer: NodeJS.Timeout | null;
  finalizeTimer: NodeJS.Timeout | null;
};

import type {
  CliAdapterActivityEvent,
  CliAdapterNativeRuntimeEvent,
  CliMeetingTransport,
  CliSessionAdapter,
  CliAdapterRunInput,
  CliAdapterRunHooks,
  CliAdapterRunResult,
} from "./adapters/types.js";

import {
  CLI_REPLY_TIMEOUT_MS,
  CLI_REPLY_FINALIZE_DEBOUNCE_MS,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
} from "./adapters/constants.js";
import {
  normalizeWorkspacePath as normalizeWorkspacePathUtil,
  normalizeTerminalCols,
  normalizeTerminalRows,
  clipText,
} from "./adapters/utils.js";

const DEFAULT_HEADLESS_SCREEN_SNAPSHOT: CliSessionScreenSnapshot = {
  text: "",
  normalizedText: "",
  cursorX: 0,
  cursorY: 0,
  bufferType: "normal",
};
const CODEX_READY_SETTLE_DELAY_MS = 800;
const CODEX_INITIAL_PROMPT_ENTER_DELAY_MS = 1500;
const CLAUDE_INITIAL_PROMPT_ENTER_DELAY_MS = 1000;
const COPILOT_TOOL_APPROVAL_ENTER_COOLDOWN_MS = 200;
const COPILOT_DECISION_PROMPT_COOLDOWN_MS = 3000;
const COPILOT_ACTIVITY_SETTLE_MS = 2000;
const ANSI_CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const ANSI_SINGLE_CHAR_SEQUENCE = /\u001b[@-_]/g;
const KNOWN_MCP_TOOL_NAMES = new Set([
  "bus_connect",
  "msg_wait",
  "msg_post",
  "msg_get",
  "msg_list",
  "msg_edit",
  "msg_react",
  "msg_unreact",
  "thread_create",
  "thread_get",
  "thread_list",
  "thread_close",
  "thread_archive",
  "thread_unarchive",
  "thread_set_state",
  "thread_settings_get",
  "thread_settings_update",
  "thread_wait_state_get",
  "agent_register",
  "agent_update",
  "agent_resume",
  "agent_heartbeat",
  "agent_list",
]);

function nowIso(): string {
  return new Date().toISOString();
}

const VALID_NATIVE_THREAD_STATUS_TYPES = new Set<CliNativeThreadStatusType>([
  "notLoaded",
  "idle",
  "systemError",
  "active",
]);
const VALID_NATIVE_THREAD_ACTIVE_FLAGS = new Set<CliNativeThreadActiveFlag>([
  "waitingOnApproval",
  "waitingOnUserInput",
]);
const VALID_NATIVE_TURN_STATUSES = new Set<CliNativeTurnStatus>([
  "completed",
  "interrupted",
  "failed",
  "inProgress",
]);
const VALID_NATIVE_TURN_PHASES = new Set<CliNativeTurnPhase>([
  "idle",
  "starting",
  "running",
  "interrupting",
  "completed",
  "interrupted",
  "failed",
]);

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

function normalizeNativeThreadStatusType(value: unknown): CliNativeThreadStatusType | undefined {
  const normalized = String(value || "").trim() as CliNativeThreadStatusType;
  return VALID_NATIVE_THREAD_STATUS_TYPES.has(normalized) ? normalized : undefined;
}

function normalizeNativeThreadActiveFlags(value: unknown): CliNativeThreadActiveFlag[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const flags = value
    .map((entry) => String(entry || "").trim() as CliNativeThreadActiveFlag)
    .filter((entry) => VALID_NATIVE_THREAD_ACTIVE_FLAGS.has(entry));
  return flags.length ? [...new Set(flags)] : [];
}

function normalizeNativeTurnStatus(value: unknown): CliNativeTurnStatus | undefined {
  const normalized = String(value || "").trim() as CliNativeTurnStatus;
  return VALID_NATIVE_TURN_STATUSES.has(normalized) ? normalized : undefined;
}

function normalizeNativeTurnPhase(value: unknown): CliNativeTurnPhase | undefined {
  const normalized = String(value || "").trim() as CliNativeTurnPhase;
  return VALID_NATIVE_TURN_PHASES.has(normalized) ? normalized : undefined;
}

function cloneNativeTurnRuntime(runtime: CliNativeTurnRuntime | undefined): CliNativeTurnRuntime | undefined {
  if (!runtime) {
    return undefined;
  }
  return {
    ...runtime,
    thread_active_flags: Array.isArray(runtime.thread_active_flags)
      ? [...runtime.thread_active_flags]
      : runtime.thread_active_flags,
  };
}

function mergeNativeTurnRuntime(
  current: CliNativeTurnRuntime | undefined,
  event: CliAdapterNativeRuntimeEvent,
): CliNativeTurnRuntime {
  const next: CliNativeTurnRuntime = cloneNativeTurnRuntime(current) || {
    updated_at: nowIso(),
    phase: "idle",
  };

  next.updated_at = normalizeOptionalString(event.at) || nowIso();

  if (Object.prototype.hasOwnProperty.call(event, "thread_id")) {
    next.thread_id = normalizeOptionalString(event.thread_id);
  }
  if (Object.prototype.hasOwnProperty.call(event, "thread_status_type")) {
    next.thread_status_type = normalizeNativeThreadStatusType(event.thread_status_type);
  }
  if (Object.prototype.hasOwnProperty.call(event, "thread_active_flags")) {
    next.thread_active_flags = normalizeNativeThreadActiveFlags(event.thread_active_flags);
  }
  if (Object.prototype.hasOwnProperty.call(event, "active_turn_id")) {
    next.active_turn_id = normalizeOptionalString(event.active_turn_id);
  }
  if (Object.prototype.hasOwnProperty.call(event, "last_turn_id")) {
    next.last_turn_id = normalizeOptionalString(event.last_turn_id);
  }
  if (Object.prototype.hasOwnProperty.call(event, "turn_status")) {
    next.turn_status = normalizeNativeTurnStatus(event.turn_status);
  }
  if (Object.prototype.hasOwnProperty.call(event, "phase")) {
    next.phase = normalizeNativeTurnPhase(event.phase) || next.phase || "idle";
  }
  if (Object.prototype.hasOwnProperty.call(event, "last_error")) {
    next.last_error = normalizeOptionalString(event.last_error);
  }

  if (!next.phase) {
    next.phase = next.active_turn_id ? "running" : "idle";
  }

  return next;
}

function clipNativeCardText(value: unknown, maxLength = 240): string {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function clipNativeCardContent(value: unknown, maxLength = 4_000): string {
  const normalized = String(value || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatNativeCardDuration(durationMs: number | undefined): string {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) {
    return "";
  }
  if (durationMs < 1000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    const rounded = seconds >= 10 ? Math.round(seconds) : Math.round(seconds * 10) / 10;
    return `${rounded}s`;
  }
  const wholeSeconds = Math.round(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function parseIsoMs(value: string | undefined): number | undefined {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getLatestActivityEntry(
  entries: CliAdapterActivityEvent[] | undefined,
  predicate: (entry: CliAdapterActivityEvent) => boolean,
  status?: CliAdapterActivityEvent["status"],
): CliAdapterActivityEvent | undefined {
  if (!Array.isArray(entries) || !entries.length) {
    return undefined;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || (status && entry.status !== status)) {
      continue;
    }
    if (predicate(entry)) {
      return entry;
    }
  }
  return undefined;
}

function getPreferredActivityEntry(
  entries: CliAdapterActivityEvent[] | undefined,
  predicate: (entry: CliAdapterActivityEvent) => boolean,
): CliAdapterActivityEvent | undefined {
  return getLatestActivityEntry(entries, predicate, "in_progress")
    || getLatestActivityEntry(entries, predicate);
}

function mapActivityStatusToCardStatus(
  status: CliAdapterActivityEvent["status"] | undefined,
): CliNativeActivityCardSection["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "declined":
      return "failed";
    default:
      return "in_progress";
  }
}

function collapseActivityEntries(
  entries: CliAdapterActivityEvent[] | undefined,
): CliAdapterActivityEvent[] {
  if (!Array.isArray(entries) || !entries.length) {
    return [];
  }
  const deduped: CliAdapterActivityEvent[] = [];
  const seen = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const itemId = String(entry?.item_id || "").trim();
    if (!itemId || seen.has(itemId)) {
      continue;
    }
    seen.add(itemId);
    deduped.unshift(entry);
  }
  return deduped;
}

function isTerminalNativeTaskState(snapshot: CliSessionSnapshot): boolean {
  const runtime = snapshot.native_turn_runtime;
  return (
    snapshot.state === "completed"
    || snapshot.state === "failed"
    || runtime?.phase === "completed"
    || runtime?.phase === "interrupted"
    || runtime?.phase === "failed"
  );
}

function getPrimaryActiveActivityEntry(
  entries: CliAdapterActivityEvent[] | undefined,
): CliAdapterActivityEvent | undefined {
  if (!Array.isArray(entries) || !entries.length) {
    return undefined;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.kind === "task" || entry.status !== "in_progress") {
      continue;
    }
    return entry;
  }
  return undefined;
}

function getCardActivityTimeline(
  snapshot: CliSessionSnapshot,
  entries: CliAdapterActivityEvent[] | undefined,
): CliAdapterActivityEvent[] {
  if (!Array.isArray(entries) || !entries.length) {
    return [];
  }
  const timeline = entries.filter(Boolean);
  if (!timeline.length) {
    return [];
  }
  const primaryActive = getPrimaryActiveActivityEntry(timeline);
  const terminalStatus: CliAdapterActivityEvent["status"] | undefined = isTerminalNativeTaskState(snapshot)
    ? snapshot.state === "failed" || snapshot.native_turn_runtime?.phase === "failed"
      ? "failed"
      : "completed"
    : undefined;
  return timeline.map((entry) => {
    if (!entry || entry.kind === "task" || entry.status !== "in_progress") {
      return entry;
    }
    if (terminalStatus) {
      return {
        ...entry,
        status: terminalStatus,
        completed_at: entry.completed_at || nowIso(),
      };
    }
    if (!primaryActive || entry.item_id === primaryActive.item_id) {
      return entry;
    }
    const sameTurn = primaryActive.turn_id && entry.turn_id
      ? primaryActive.turn_id === entry.turn_id
      : true;
    if (!sameTurn) {
      return entry;
    }
    return {
      ...entry,
      status: "completed",
      completed_at: entry.completed_at || primaryActive.at || nowIso(),
    };
  });
}

function getEffectiveCardActivityEntries(
  snapshot: CliSessionSnapshot,
  entries: CliAdapterActivityEvent[] | undefined,
): CliAdapterActivityEvent[] {
  const collapsed = collapseActivityEntries(getCardActivityTimeline(snapshot, entries));
  if (!collapsed.length) {
    return collapsed;
  }
  const primaryActive = getPrimaryActiveActivityEntry(collapsed);
  const terminalStatus: CliAdapterActivityEvent["status"] | undefined = isTerminalNativeTaskState(snapshot)
    ? snapshot.state === "failed" || snapshot.native_turn_runtime?.phase === "failed"
      ? "failed"
      : "completed"
    : undefined;
  return collapsed.map((entry) => {
    if (!entry || entry.kind === "task" || entry.status !== "in_progress") {
      return entry;
    }
    if (terminalStatus) {
      return {
        ...entry,
        status: terminalStatus,
        completed_at: entry.completed_at || nowIso(),
      };
    }
    if (!primaryActive || entry.item_id === primaryActive.item_id) {
      return entry;
    }
    const sameTurn = primaryActive.turn_id && entry.turn_id
      ? primaryActive.turn_id === entry.turn_id
      : true;
    if (!sameTurn) {
      return entry;
    }
    return {
      ...entry,
      status: "completed",
      completed_at: entry.completed_at || primaryActive.at || nowIso(),
    };
  });
}

function mapActivityKindToSectionKind(
  kind: CliAdapterActivityEvent["kind"] | undefined,
): CliNativeActivityCardSectionKind | undefined {
  switch (kind) {
    case "thinking":
      return "thinking";
    case "plan":
      return "plan";
    case "mcp_tool_call":
    case "dynamic_tool_call":
      return "tool";
    case "command_execution":
      return "command";
    case "file_change":
      return "files";
    case "task":
      return "task";
    default:
      return undefined;
  }
}

function getPrimaryActiveSectionKind(
  entries: CliAdapterActivityEvent[] | undefined,
): CliNativeActivityCardSectionKind | undefined {
  return mapActivityKindToSectionKind(getPrimaryActiveActivityEntry(entries)?.kind);
}

function getNativeSectionSortWeight(
  section: CliNativeActivityCardSection,
  activeKind: CliNativeActivityCardSectionKind | undefined,
): number {
  if (activeKind && section.kind === activeKind) {
    return 0;
  }
  if (activeKind === "files" && section.kind === "diff") {
    return 1;
  }
  switch (section.kind) {
    case "thinking":
      return 10;
    case "tool":
      return 20;
    case "command":
      return 30;
    case "files":
      return 40;
    case "diff":
      return 41;
    case "plan":
      return 50;
    case "task":
      return 60;
    case "placeholder":
    default:
      return 99;
  }
}

function sortNativeCardSections(
  sections: CliNativeActivityCardSection[],
  activeKind: CliNativeActivityCardSectionKind | undefined,
): CliNativeActivityCardSection[] {
  return [...sections].sort((left, right) =>
    getNativeSectionSortWeight(left, activeKind) - getNativeSectionSortWeight(right, activeKind));
}

function summarizeShellStatus(snapshot: CliSessionSnapshot): {
  status: CliNativeActivityCardShellStatus;
  text: string;
} {
  const state = String(snapshot.state || "").trim().toLowerCase();
  const runtime = snapshot.native_turn_runtime;
  if (state === "failed") {
    return { status: "failed", text: "Failed" };
  }
  if (state === "stopped") {
    return { status: "stopped", text: "Stopped" };
  }
  if (state === "completed") {
    return { status: "completed", text: "Completed" };
  }
  if (state === "starting" || state === "created") {
    return { status: "starting", text: `Starting ${getCliAdapterDisplayName(snapshot.adapter)}` };
  }
  if (runtime?.thread_active_flags?.includes("waitingOnApproval")) {
    return { status: "running", text: "Waiting on approval" };
  }
  if (runtime?.thread_active_flags?.includes("waitingOnUserInput")) {
    return { status: "running", text: "Waiting on input" };
  }
  if (runtime?.phase === "interrupting") {
    return { status: "running", text: "Interrupting" };
  }
  if (runtime?.phase === "running" || runtime?.phase === "starting") {
    return { status: "running", text: "Running" };
  }
  if (runtime?.phase === "interrupted") {
    return { status: "completed", text: "Interrupted" };
  }
  if (runtime?.phase === "completed") {
    return { status: "completed", text: "Completed" };
  }
  if (snapshot.connected_at) {
    return { status: "connected", text: "Connected" };
  }
  return { status: "running", text: "Running" };
}

function getCliAdapterDisplayName(adapter: CliSessionAdapterId | string | undefined): string {
  const normalized = String(adapter || "").trim().toLowerCase();
  if (normalized === "claude") {
    return "Claude";
  }
  if (normalized === "cursor") {
    return "Cursor";
  }
  if (normalized === "gemini") {
    return "Gemini";
  }
  if (normalized === "copilot") {
    return "Copilot";
  }
  return "Codex";
}

function pickNativeCardUpdatedAt(snapshot: CliSessionSnapshot, sections: CliNativeActivityCardSection[]): string {
  const activityEntries = Array.isArray(snapshot.recent_activity_events) ? snapshot.recent_activity_events : [];
  const latestActivityAt = activityEntries.length ? String(activityEntries[activityEntries.length - 1]?.at || "") : "";
  const latestSectionSummary = sections.find((section) => section.status === "in_progress");
  if (latestSectionSummary && latestActivityAt) {
    return latestActivityAt;
  }
  return String(
    latestActivityAt
    || snapshot.last_output_at
    || snapshot.last_tool_call_at
    || snapshot.updated_at
    || snapshot.created_at
    || nowIso(),
  ).trim() || nowIso();
}

function buildSessionReentryPrompt(snapshot: CliSessionSnapshot): CliSessionSnapshot["reentry_prompt"] {
  const threadLabel = String(snapshot.thread_display_name || snapshot.thread_id || "").trim() || "current thread";
  const resolvedPrompt = String(snapshot.reentry_prompt_override || "").trim() || buildCliMeetingWakePrompt(threadLabel);
  const promptHistory = Array.isArray(snapshot.prompt_history) ? snapshot.prompt_history : [];
  const latestWakeEntry = [...promptHistory]
    .reverse()
    .find((entry) => String(entry?.kind || "").trim().toLowerCase() === "wake");
  return {
    resolved_kind: "wake",
    resolved_prompt: resolvedPrompt,
    resolved_at: String(snapshot.updated_at || snapshot.created_at || nowIso()).trim() || nowIso(),
    last_sent_prompt: String(latestWakeEntry?.prompt || "").trim() || undefined,
    last_sent_at: String(latestWakeEntry?.at || "").trim() || undefined,
  };
}

function isNativeTaskActive(snapshot: CliSessionSnapshot): boolean {
  const phase = String(snapshot.native_turn_runtime?.phase || "").trim();
  return phase === "starting" || phase === "running" || phase === "interrupting";
}

function buildNativeThinkingSummary(
  snapshot: CliSessionSnapshot,
  events: CliAdapterActivityEvent[],
): { summary: string; meta?: string } {
  const runtime = snapshot.native_turn_runtime;
  const latestActiveEvent = getLatestActivityEntry(events, (entry) => entry.status === "in_progress");
  const planEvent = getPreferredActivityEntry(events, (entry) => entry.kind === "plan");
  const toolEvent = getPreferredActivityEntry(
    events,
    (entry) => entry.kind === "mcp_tool_call" || entry.kind === "dynamic_tool_call",
  );
  const commandEvent = getPreferredActivityEntry(events, (entry) => entry.kind === "command_execution");
  const fileEvent = getPreferredActivityEntry(events, (entry) => entry.kind === "file_change");

  if (runtime?.thread_active_flags?.includes("waitingOnApproval")) {
    return {
      summary: "Waiting for approval before continuing.",
      meta: "Approval required",
    };
  }
  if (runtime?.thread_active_flags?.includes("waitingOnUserInput")) {
    return {
      summary: "Waiting for input to continue.",
      meta: "User input required",
    };
  }
  if (runtime?.phase === "interrupting") {
    return {
      summary: `Stopping the current ${getCliAdapterDisplayName(snapshot.adapter)} task.`,
      meta: "Interrupting",
    };
  }

  const candidateSummary = clipNativeCardText(
    planEvent?.summary
      || latestActiveEvent?.summary
      || toolEvent?.summary
      || commandEvent?.summary
      || fileEvent?.summary
      || commandEvent?.command
      || [toolEvent?.server, toolEvent?.tool].filter(Boolean).join(" / "),
    280,
  );
  const candidateMeta = clipNativeCardText(
    latestActiveEvent && latestActiveEvent.kind !== "thinking"
      ? latestActiveEvent.label
      : "",
    90,
  );
  return {
    summary: candidateSummary || "Working through the next steps.",
    meta: candidateMeta || undefined,
  };
}

function getRecentActivityEntries(
  events: CliAdapterActivityEvent[],
  predicate: (entry: CliAdapterActivityEvent) => boolean,
  limit = 4,
): CliAdapterActivityEvent[] {
  if (!Array.isArray(events) || !events.length || limit <= 0) {
    return [];
  }
  const selected: CliAdapterActivityEvent[] = [];
  const seen = new Set<string>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index];
    if (!entry || !predicate(entry)) {
      continue;
    }
    const summaryKey = clipNativeCardText(
      [
        entry.kind,
        entry.item_id,
        entry.command,
        entry.server,
        entry.tool,
        entry.summary,
      ].filter(Boolean).join("::"),
      320,
    );
    const key = summaryKey || `${entry.kind}:${entry.item_id}:${index}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(entry);
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}

function getFileActionLabel(changeType: string | undefined): string {
  switch (String(changeType || "").trim().toLowerCase()) {
    case "add":
      return "Added file";
    case "delete":
      return "Deleted file";
    default:
      return "Edited file";
  }
}

function getToolActionLabel(status: CliAdapterActivityEvent["status"] | undefined): string {
  if (status === "completed") {
    return "Used tool";
  }
  if (status === "failed" || status === "declined") {
    return "Tool failed";
  }
  return "Using tool";
}

function getCommandActionLabel(status: CliAdapterActivityEvent["status"] | undefined): string {
  if (status === "completed") {
    return "Ran";
  }
  if (status === "failed" || status === "declined") {
    return "Command failed";
  }
  return "Running";
}

function buildCommandHeadline(event: CliAdapterActivityEvent | undefined): string {
  if (!event) {
    return "";
  }
  const command = clipNativeCardText(event.command, 220);
  if (command) {
    return `${getCommandActionLabel(event.status)} ${command}`;
  }
  return clipNativeCardText(event.summary || event.label, 280);
}

function buildToolHeadline(event: CliAdapterActivityEvent | undefined): string {
  if (!event) {
    return "";
  }
  const target = clipNativeCardText(
    [event.server, event.tool].filter(Boolean).join(" / "),
    220,
  );
  if (target) {
    return `${getToolActionLabel(event.status)} ${target}`;
  }
  return clipNativeCardText(event.summary || event.label, 260);
}

function buildFilesHeadline(event: CliAdapterActivityEvent | undefined): string {
  if (!event) {
    return "";
  }
  const files = Array.isArray(event.files) ? event.files.filter((file) => file?.path) : [];
  if (!files.length) {
    return clipNativeCardText(event.summary || event.label, 240);
  }
  if (files.length === 1) {
    return clipNativeCardText(`${getFileActionLabel(files[0]?.change_type)} ${files[0]?.path}`, 240);
  }
  return clipNativeCardText(`Edited ${files.length} files`, 240);
}

function buildThinkingSectionItems(
  events: CliAdapterActivityEvent[],
  primarySummary: string,
): CliNativeActivityCardSectionItem[] | undefined {
  const items: CliNativeActivityCardSectionItem[] = [];
  for (const entry of getRecentActivityEntries(
    events,
    (entry) => (entry.kind === "thinking" || entry.kind === "plan" || entry.kind === "task") && !!entry.summary,
    4,
  )) {
    const value = clipNativeCardText(entry.summary, 240);
    if (!value || value === primarySummary) {
      continue;
    }
    items.push({
        label: entry.kind === "plan" ? "Plan note" : entry.kind === "task" ? "Task note" : "Thought",
        value,
        status: entry.status,
        kind: entry.kind,
      });
  }
  return items.length ? items : undefined;
}

function buildToolSectionItems(events: CliAdapterActivityEvent[]): CliNativeActivityCardSectionItem[] | undefined {
  const items = getRecentActivityEntries(
    events,
    (entry) => entry.kind === "mcp_tool_call" || entry.kind === "dynamic_tool_call",
    4,
  )
    .flatMap((entry) => {
      const target = clipNativeCardText([entry.server, entry.tool].filter(Boolean).join(" / "), 180)
        || clipNativeCardText(entry.label, 140);
      const summary = clipNativeCardText(entry.summary, 200);
      const rows: CliNativeActivityCardSectionItem[] = [];
      if (target) {
        rows.push({
          label: getToolActionLabel(entry.status),
          value: target,
          status: entry.status,
          kind: entry.kind,
        });
      }
      if (summary && summary !== target) {
        rows.push({
          label: "Progress",
          value: summary,
          status: entry.status,
          kind: entry.kind,
        });
      }
      return rows;
    });
  return items.length ? items : undefined;
}

function buildCommandSectionItems(events: CliAdapterActivityEvent[]): CliNativeActivityCardSectionItem[] | undefined {
  const recentCommands = getRecentActivityEntries(events, (entry) => entry.kind === "command_execution", 3);
  const items: CliNativeActivityCardSectionItem[] = [];
  for (const entry of recentCommands) {
    const command = clipNativeCardText(entry.command, 180);
    if (command) {
      items.push({
        label: getCommandActionLabel(entry.status),
        value: command,
        status: entry.status,
        kind: entry.kind,
      });
    }
    const cwd = clipNativeCardText(entry.cwd, 180);
    if (cwd) {
      items.push({
        label: "Directory",
        value: cwd,
        status: entry.status,
        kind: "cwd",
      });
    }
    const summary = clipNativeCardText(entry.summary, 220);
    if (summary && summary !== command) {
      items.push({
        label: "Output",
        value: summary,
        status: entry.status,
        kind: "output",
      });
    }
  }
  return items.length ? items.slice(0, 6) : undefined;
}

function buildFilesSectionItems(fileEvent: CliAdapterActivityEvent | undefined): CliNativeActivityCardSectionItem[] | undefined {
  const files = Array.isArray(fileEvent?.files) ? fileEvent.files.filter((file) => file?.path) : [];
  if (!files.length) {
    return undefined;
  }
  return files.slice(0, 8).map((file) => ({
    label: getFileActionLabel(file.change_type),
    value: clipNativeCardText(file.path, 220),
    kind: file.change_type || "update",
    status: fileEvent?.status,
  }));
}

function mapActivityKindToBlockKind(
  kind: CliAdapterActivityEvent["kind"] | undefined,
): CliNativeActivityCardBlockKind | undefined {
  switch (kind) {
    case "agent_message":
      return "message";
    case "thinking":
      return "thinking";
    case "plan":
      return "plan";
    case "mcp_tool_call":
    case "dynamic_tool_call":
      return "tool";
    case "command_execution":
      return "command";
    case "file_change":
      return "files";
    case "task":
      return "task";
    default:
      return undefined;
  }
}

function getBlockTitleFromTool(entry: CliAdapterActivityEvent): string {
  return buildToolHeadline(entry) || "Using tool";
}

function getBlockTitleFromCommand(
  entry: CliAdapterActivityEvent,
  durationMs: number | undefined,
): string {
  const command = clipNativeCardText(entry.command, 220);
  if (!command) {
    return clipNativeCardText(entry.summary || entry.label, 280) || "Running command";
  }
  if (entry.status === "failed" || entry.status === "declined") {
    return `Command failed ${command}`;
  }
  const durationText = formatNativeCardDuration(durationMs);
  if (entry.status === "completed") {
    return durationText ? `Ran ${command} for ${durationText}` : `Ran ${command}`;
  }
  return `Running ${command}`;
}

function getBlockTitleFromFiles(entry: CliAdapterActivityEvent): string {
  const files = Array.isArray(entry.files) ? entry.files.filter((file) => file?.path) : [];
  if (!files.length) {
    return clipNativeCardText(entry.summary || entry.label, 260) || "Editing files";
  }
  if (files.length === 1) {
    const file = files[0];
    if (file?.move_path) {
      return clipNativeCardText(`Moved ${file.path} -> ${file.move_path}`, 280) || "Moved file";
    }
    return clipNativeCardText(`${getFileActionLabel(file.change_type)} ${file.path}`, 280) || "Edited file";
  }
  return clipNativeCardText(`Edited ${files.length} files`, 260) || "Editing files";
}

function appendUniqueBlockItem(
  items: CliNativeActivityCardBlockItem[],
  next: CliNativeActivityCardBlockItem | null,
): void {
  if (!next || (!next.label && !next.value)) {
    return;
  }
  const key = `${next.kind || ""}::${next.label || ""}::${next.value || ""}::${next.status || ""}`;
  const exists = items.some((entry) =>
    `${entry.kind || ""}::${entry.label || ""}::${entry.value || ""}::${entry.status || ""}` === key);
  if (!exists) {
    items.push(next);
  }
}

function buildCommandBlockItems(
  entry: CliAdapterActivityEvent,
): CliNativeActivityCardBlockItem[] | undefined {
  const items: CliNativeActivityCardBlockItem[] = [];
  const cwd = clipNativeCardText(entry.cwd, 220);
  if (cwd) {
    appendUniqueBlockItem(items, {
      label: "Directory",
      value: cwd,
      status: entry.status,
      kind: "cwd",
    });
  }

  const outputSource = clipNativeCardContent(entry.content || entry.summary, 1_800);
  const outputLines = outputSource
    ? outputSource
      .split(/\r?\n/g)
      .map((line) => clipNativeCardText(line, 260))
      .filter(Boolean)
    : [];
  const selectedOutputLines = outputLines.length > 3 ? outputLines.slice(-3) : outputLines;
  for (const line of selectedOutputLines) {
    appendUniqueBlockItem(items, {
      label: line.startsWith("Sent input:") ? "Input" : "Output",
      value: line,
      status: entry.status,
      kind: line.startsWith("Sent input:") ? "input" : "output",
    });
  }

  return items.length ? items : undefined;
}

function buildFilesBlockItems(entry: CliAdapterActivityEvent): CliNativeActivityCardBlockItem[] | undefined {
  const items: CliNativeActivityCardBlockItem[] = [];
  const files = Array.isArray(entry.files) ? entry.files.filter((file) => file?.path) : [];
  for (const file of files.slice(0, 8)) {
    appendUniqueBlockItem(items, {
      label: file.move_path
        ? "Moved file"
        : getFileActionLabel(file.change_type),
      value: file.move_path
        ? clipNativeCardText(`${file.path} -> ${file.move_path}`, 280)
        : clipNativeCardText(file.path, 240),
      status: entry.status,
      kind: file.change_type || (file.move_path ? "move" : "update"),
    });
  }
  return items.length ? items : undefined;
}

function buildToolBlockItems(entry: CliAdapterActivityEvent): CliNativeActivityCardBlockItem[] | undefined {
  const items: CliNativeActivityCardBlockItem[] = [];
  const target = clipNativeCardText([entry.server, entry.tool].filter(Boolean).join(" / "), 240);
  if (target) {
    appendUniqueBlockItem(items, {
      label: entry.status === "completed" ? "Used" : "Using",
      value: target,
      status: entry.status,
      kind: "tool_target",
    });
  }
  const progress = clipNativeCardText(entry.summary, 280);
  if (progress && progress !== target) {
    appendUniqueBlockItem(items, {
      label: "Progress",
      value: progress,
      status: entry.status,
      kind: "tool_progress",
    });
  }
  return items.length ? items : undefined;
}

function buildPlanBlockItems(entry: CliAdapterActivityEvent): CliNativeActivityCardBlockItem[] | undefined {
  if (!Array.isArray(entry.plan_steps) || !entry.plan_steps.length) {
    return undefined;
  }
  return entry.plan_steps.slice(0, 6).map((step) => ({
    label: step.step,
    status: step.status,
    kind: "plan_step",
  }));
}

function buildNativeActivityBlocks(snapshot: CliSessionSnapshot): CliNativeActivityCardBlock[] {
  const timeline = getCardActivityTimeline(snapshot, snapshot.recent_activity_events);
  if (!timeline.length) {
    return [];
  }

  const orderedIds: string[] = [];
  const aggregated = new Map<string, {
    first_seen_at: string;
    latest: CliAdapterActivityEvent;
    started_at?: string;
    completed_at?: string;
  }>();

  for (const entry of timeline) {
    if (!entry?.item_id) {
      continue;
    }
    const existing = aggregated.get(entry.item_id);
    if (!existing) {
      orderedIds.push(entry.item_id);
      aggregated.set(entry.item_id, {
        first_seen_at: entry.started_at || entry.at,
        latest: entry,
        started_at: entry.started_at || entry.at,
        completed_at: entry.completed_at,
      });
      continue;
    }
    existing.latest = entry;
    existing.started_at = existing.started_at || entry.started_at || entry.at;
    existing.completed_at = entry.completed_at || existing.completed_at;
  }

  const blocks: CliNativeActivityCardBlock[] = [];
  for (const itemId of orderedIds) {
    const entry = aggregated.get(itemId);
    if (!entry) {
      continue;
    }
    const blockKind = mapActivityKindToBlockKind(entry.latest.kind);
    if (!blockKind) {
      continue;
    }
    const startedAtMs = parseIsoMs(entry.started_at);
    const completedAtMs = parseIsoMs(entry.completed_at);
    const durationMs = startedAtMs !== undefined && completedAtMs !== undefined
      ? Math.max(0, completedAtMs - startedAtMs)
      : undefined;
    const block: CliNativeActivityCardBlock = {
      id: itemId,
      kind: blockKind,
      status: mapActivityStatusToCardStatus(entry.latest.status),
      updated_at: entry.latest.at,
    };

    switch (blockKind) {
      case "message":
        block.title = "Codex";
        block.summary = clipNativeCardText(entry.latest.summary || entry.latest.content, 320) || undefined;
        block.content = clipNativeCardContent(entry.latest.content || entry.latest.summary, 6_000) || undefined;
        break;
      case "thinking":
        block.title = "Thinking";
        block.summary = clipNativeCardText(entry.latest.summary || entry.latest.label, 320) || "Working through the next steps.";
        break;
      case "plan":
        block.title = "Plan";
        block.summary = clipNativeCardText(entry.latest.summary || entry.latest.label, 320) || "Plan updated";
        block.items = buildPlanBlockItems(entry.latest);
        break;
      case "tool":
        block.title = getBlockTitleFromTool(entry.latest);
        block.summary = clipNativeCardText(entry.latest.summary, 320) || undefined;
        block.meta = clipNativeCardText([entry.latest.server, entry.latest.tool].filter(Boolean).join(" / "), 220) || undefined;
        block.items = buildToolBlockItems(entry.latest);
        break;
      case "command":
        block.title = getBlockTitleFromCommand(entry.latest, durationMs);
        block.summary = clipNativeCardText(entry.latest.summary, 320) || undefined;
        block.command = clipNativeCardText(entry.latest.command, 260) || undefined;
        block.cwd = clipNativeCardText(entry.latest.cwd, 220) || undefined;
        block.duration_ms = durationMs;
        block.items = buildCommandBlockItems(entry.latest);
        break;
      case "files":
        block.title = getBlockTitleFromFiles(entry.latest);
        block.summary = clipNativeCardText(entry.latest.summary, 320) || undefined;
        block.files = Array.isArray(entry.latest.files)
          ? entry.latest.files.map((file) => ({ ...file }))
          : undefined;
        block.diff = clipNativeCardContent(entry.latest.diff, 1_600) || undefined;
        block.items = buildFilesBlockItems(entry.latest);
        break;
      case "task":
        block.title = "Task";
        block.summary = clipNativeCardText(entry.latest.summary || entry.latest.label, 320) || "Task updated";
        break;
      default:
        break;
    }

    blocks.push(block);
    if (blockKind === "files" && block.diff) {
      blocks.push({
        id: `${itemId}:diff`,
        kind: "diff",
        status: block.status,
        updated_at: block.updated_at,
        title: "Diff",
        summary: clipNativeCardText(block.diff, 320) || "Diff updated",
        diff: block.diff,
      });
    }
  }

  return blocks;
}

function buildNativePlaceholderSummary(
  snapshot: CliSessionSnapshot,
  shell: { status: CliNativeActivityCardShellStatus; text: string },
): string {
  const adapterName = getCliAdapterDisplayName(snapshot.adapter);
  switch (shell.status) {
    case "starting":
      return `${adapterName} is starting.`;
    case "completed":
      return `Last ${adapterName} task completed.`;
    case "failed":
      return `${adapterName} stopped after an error.`;
    case "stopped":
      return `${adapterName} session stopped.`;
    case "connected":
      return `Connected and waiting for the next ${adapterName} task.`;
    default:
      return `Connected and waiting for the next ${adapterName} task.`;
  }
}

export function buildNativeActivityCard(snapshot: CliSessionSnapshot): CliNativeActivityCard {
  const events = getEffectiveCardActivityEntries(snapshot, snapshot.recent_activity_events);
  const sections: CliNativeActivityCardSection[] = [];
  const shell = summarizeShellStatus(snapshot);
  const runtime = snapshot.native_turn_runtime;
  const taskActive = isNativeTaskActive(snapshot);
  const waitingOnApproval = runtime?.thread_active_flags?.includes("waitingOnApproval");
  const waitingOnInput = runtime?.thread_active_flags?.includes("waitingOnUserInput");
  const primaryActiveKind = getPrimaryActiveSectionKind(events);

  const taskEvent = getPreferredActivityEntry(events, (entry) => entry.kind === "task");
  const thinkingEvent = getPreferredActivityEntry(events, (entry) => entry.kind === "thinking");
  const toolEvent = getPreferredActivityEntry(
    events,
    (entry) => entry.kind === "mcp_tool_call" || entry.kind === "dynamic_tool_call",
  );
  const commandEvent = getPreferredActivityEntry(events, (entry) => entry.kind === "command_execution");
  const fileEvent = getPreferredActivityEntry(events, (entry) => entry.kind === "file_change");
  const planEvent = getPreferredActivityEntry(events, (entry) => entry.kind === "plan");

  if (thinkingEvent?.summary) {
    const thinkingSummary = clipNativeCardText(thinkingEvent.summary, 280);
    sections.push({
      kind: "thinking",
      title: "Thinking",
      summary: thinkingSummary,
      status: mapActivityStatusToCardStatus(thinkingEvent.status),
      items: buildThinkingSectionItems(events, thinkingSummary),
    });
  }

  if (toolEvent) {
    const meta = [toolEvent.server, toolEvent.tool].filter(Boolean).join(" / ");
    const toolItems = buildToolSectionItems(events);
    sections.push({
      kind: "tool",
      title: "Tool",
      summary: buildToolHeadline(toolEvent) || "Using tool",
      status: mapActivityStatusToCardStatus(toolEvent.status),
      meta: toolItems?.length ? undefined : clipNativeCardText(toolEvent.summary, 180) || clipNativeCardText(meta, 180) || undefined,
      items: toolItems,
    });
  }

  if (commandEvent) {
    const commandItems = buildCommandSectionItems(events);
    sections.push({
      kind: "command",
      title: "Command",
      summary: buildCommandHeadline(commandEvent) || "Running command",
      status: mapActivityStatusToCardStatus(commandEvent.status),
      meta: commandItems?.length ? undefined : clipNativeCardText(commandEvent.summary, 220) || undefined,
      items: commandItems,
    });
  }

  if (fileEvent) {
    sections.push({
      kind: "files",
      title: "Files",
      summary: buildFilesHeadline(fileEvent) || "Editing files",
      status: mapActivityStatusToCardStatus(fileEvent.status),
      meta: clipNativeCardText(fileEvent.summary, 180) || undefined,
      items: buildFilesSectionItems(fileEvent),
    });

    if (fileEvent.diff) {
      sections.push({
        kind: "diff",
        title: "Diff",
        summary: clipNativeCardText(fileEvent.diff, 320) || "Diff updated",
        status: mapActivityStatusToCardStatus(fileEvent.status),
      });
    }
  }

  if (planEvent) {
    sections.push({
      kind: "plan",
      title: "Plan",
      summary: clipNativeCardText(planEvent.summary || planEvent.label, 240) || "Plan updated",
      status: mapActivityStatusToCardStatus(planEvent.status),
      items: Array.isArray(planEvent.plan_steps)
        ? planEvent.plan_steps
          .slice(0, 5)
          .map((step) => ({
            label: step.step,
            status: step.status,
          }))
        : undefined,
    });
  }

  if (taskActive && !sections.some((section) => section.kind === "thinking")) {
    const synthesizedThinking = buildNativeThinkingSummary(snapshot, events);
    sections.push({
      kind: "thinking",
      title: "Thinking",
      summary: synthesizedThinking.summary,
      status: "in_progress",
      meta: synthesizedThinking.meta,
      items: buildThinkingSectionItems(events, synthesizedThinking.summary),
    });
  }

  const hasTerminalTaskState = isTerminalNativeTaskState(snapshot);

  if (
    taskEvent
    && !hasTerminalTaskState
    && (waitingOnApproval || waitingOnInput || (!taskActive && !sections.length))
  ) {
    sections.push({
      kind: "task",
      title: "Task",
      summary: clipNativeCardText(taskEvent.summary || taskEvent.label, 240) || "Task updated",
      status: mapActivityStatusToCardStatus(taskEvent.status),
      meta: clipNativeCardText(taskEvent.status, 80) || undefined,
    });
  }

  if (
    hasTerminalTaskState
    && (
      taskEvent?.summary
      || snapshot.raw_result?.turn_status
      || snapshot.last_result
      || snapshot.last_error
      || runtime?.turn_status
      || runtime?.phase
    )
  ) {
    const taskFailed = snapshot.state === "failed" || runtime?.phase === "failed";
    const taskInterrupted = runtime?.phase === "interrupted";
    const terminalTaskStatus: CliNativeActivityCardSection["status"] = taskFailed ? "failed" : "completed";
    sections.push({
      kind: "task",
      title: "Task",
      summary: clipNativeCardText(
        snapshot.last_error
          || snapshot.last_result
          || taskEvent?.summary
          || (taskInterrupted ? "Task interrupted" : undefined)
          || String(snapshot.raw_result?.turn_status || ""),
        240,
      ) || (taskFailed ? "Task failed" : taskInterrupted ? "Task interrupted" : "Task completed"),
      status: taskEvent && taskEvent.status !== "in_progress"
        ? mapActivityStatusToCardStatus(taskEvent.status)
        : terminalTaskStatus,
      meta: clipNativeCardText(
        [
          taskEvent?.status ? String(taskEvent.status) : "",
          runtime?.turn_status ? String(runtime.turn_status) : "",
          snapshot.raw_result?.turn_status ? String(snapshot.raw_result.turn_status) : "",
          runtime?.phase ? String(runtime.phase) : "",
        ].filter(Boolean).join(" · "),
        80,
      ) || undefined,
    });
  }

  if (!sections.length) {
    sections.push({
      kind: "placeholder",
      title: "Activity",
      summary: buildNativePlaceholderSummary(snapshot, shell),
      status: "placeholder",
      meta: shell.text,
    });
  }

  const sortedSections = sortNativeCardSections(sections, primaryActiveKind);
  const contentBlocks = buildNativeActivityBlocks(snapshot);
  const finalizedBlocks = contentBlocks.length
    ? contentBlocks
    : [{
      id: "placeholder",
      kind: "placeholder" as const,
      status: "placeholder" as const,
      updated_at: pickNativeCardUpdatedAt(snapshot, sortedSections),
      title: "Activity",
      summary: buildNativePlaceholderSummary(snapshot, shell),
      meta: shell.text,
    }];
  const activeSection = sortedSections.find(
    (section) => section.kind !== "task" && section.kind !== "placeholder" && section.status === "in_progress",
  );
  const activeThinking = activeSection?.kind === "thinking";
  const shellActivityText = activeSection
    ? (
      activeSection.kind === "tool"
        ? "Using tool"
        : activeSection.kind === "command"
          ? "Running command"
          : activeSection.kind === "files" || activeSection.kind === "diff"
            ? "Editing files"
            : activeSection.kind === "plan"
              ? "Updating plan"
              : "Thinking"
    )
    : shell.text;
  const shellStatusText = clipNativeCardText(
    !waitingOnApproval && !waitingOnInput && activeThinking
      ? "Thinking"
      : !waitingOnApproval && !waitingOnInput && activeSection
        ? shellActivityText
        : shell.text,
    60,
  ) || "Connected";

  return {
    anchor_message_id: String(snapshot.last_posted_message_id || "").trim() || undefined,
    shell_status: shell.status,
    shell_status_text: shellStatusText,
    updated_at: pickNativeCardUpdatedAt(snapshot, sortedSections),
    placeholder_visible: finalizedBlocks.length === 1 && finalizedBlocks[0].kind === "placeholder",
    content_blocks: finalizedBlocks,
    content_sections: sortedSections,
  };
}

function normalizeToolNameCandidate(value: string | undefined): string | undefined {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!normalized) {
    return undefined;
  }
  return KNOWN_MCP_TOOL_NAMES.has(normalized) ? normalized : undefined;
}

function extractToolNamesFromStructuredEvent(value: unknown, keyHint = "", depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    const key = String(keyHint || "").toLowerCase();
    if (!key || !/(tool|function|name|method|command|invocation|call)/.test(key)) {
      return [];
    }
    const normalized = normalizeToolNameCandidate(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractToolNamesFromStructuredEvent(entry, keyHint, depth + 1));
  }

  if (typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const eventType = String(record.type || "").toLowerCase();
  const inspectAllNameLikeFields = /tool|function|call/.test(eventType);
  const found = new Set<string>();
  for (const [key, child] of Object.entries(record)) {
    const nextHint = inspectAllNameLikeFields ? "tool" : key;
    extractToolNamesFromStructuredEvent(child, nextHint, depth + 1).forEach((name) => found.add(name));
  }
  return Array.from(found);
}

function stripTerminalControlSequences(input: string): string {
  return String(input || "")
    .replace(ANSI_OSC_SEQUENCE, "")
    .replace(ANSI_CSI_SEQUENCE, "")
    .replace(ANSI_SINGLE_CHAR_SEQUENCE, "")
    .replace(/\r/g, "");
}

function normalizeScreenMatchText(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimBlankScreenLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) {
    start += 1;
  }
  while (end > start && !lines[end - 1]?.trim()) {
    end -= 1;
  }
  return lines.slice(start, end);
}

function collectHeadlessScreenLines(terminal: HeadlessTerminalInstance, startLine: number): string[] {
  const lines: string[] = [];
  const activeBuffer = terminal.buffer.active;
  const start = Math.max(0, startLine);
  const end = Math.min(activeBuffer.length, start + terminal.rows);
  for (let index = start; index < end; index += 1) {
    lines.push(activeBuffer.getLine(index)?.translateToString(true) || "");
  }
  return lines;
}

function snapshotHeadlessScreen(terminal: HeadlessTerminalInstance): CliSessionScreenSnapshot {
  const activeBuffer = terminal.buffer.active;
  const viewportLines = trimBlankScreenLines(collectHeadlessScreenLines(terminal, activeBuffer.viewportY));
  const fallbackStart = Math.max(0, activeBuffer.length - terminal.rows);
  const fallbackLines = trimBlankScreenLines(collectHeadlessScreenLines(terminal, fallbackStart));
  const visibleLines = viewportLines.length > 0 ? viewportLines : fallbackLines;
  const text = clipText(visibleLines.join("\n"), 2400);
  return {
    text,
    normalizedText: normalizeScreenMatchText(text),
    cursorX: activeBuffer.cursorX,
    cursorY: activeBuffer.cursorY,
    bufferType: activeBuffer.type,
  };
}

function buildHeadlessScreenSummary(screen: CliSessionScreenSnapshot): string | undefined {
  const lines = String(screen.text || "")
    .split("\n")
    .map((line) => line.trimEnd());
  const trimmed = trimBlankScreenLines(lines).join("\n").trim();
  if (!trimmed) {
    return undefined;
  }
  return clipText(trimmed, 1200);
}

export function extractObservedAgentCurrentSeq(screenExcerpt: string | undefined): number | undefined {
  const text = String(screenExcerpt || "");
  if (!text.trim()) {
    return undefined;
  }

  const matches: number[] = [];
  const patterns = [
    /"current_seq"\s*:\s*(\d+)/gi,
    /\bcurrent[_ ]seq\s*[=:]\s*(\d+)/gi,
    /\bcurrent seq\b[^\d]{0,12}(\d+)/gi,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    do {
      match = pattern.exec(text);
      if (!match?.[1]) {
        continue;
      }
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) {
        matches.push(value);
      }
    } while (match);
  }

  if (!matches.length) {
    return undefined;
  }
  return Math.max(...matches);
}

function looksLikeClaudeIdleScreen(screenExcerpt: string | undefined): boolean {
  const normalized = normalizeScreenMatchText(String(screenExcerpt || ""));
  if (!normalized) {
    return false;
  }
  // Claude shows a simple prompt when ready for input
  // Look for common patterns in Claude's interactive mode
  return (
    normalized.includes("how can i help")
    || normalized.includes("what would you like")
    || normalized.includes("anything else")
    || /^[>\$#]\s*$/.test(normalized.trim())
  );
}

function looksLikeClaudeWorkingScreen(screenExcerpt: string | undefined): boolean {
  return looksLikeConversationalWorkingScreen(screenExcerpt);
}

function looksLikeClaudeProceedPrompt(screenExcerpt: string | undefined): boolean {
  const normalized = normalizeScreenMatchText(String(screenExcerpt || ""));
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("do you want to proceed")
    && normalized.includes("yes")
    && normalized.includes("no")
  );
}

function looksLikeClaudeUsableScreen(screen: CliSessionScreenSnapshot): boolean {
  const normalized = String(screen.normalizedText || "").trim();
  if (!normalized) {
    return false;
  }
  if (looksLikeClaudeWorkingScreen(screen.text)) {
    return false;
  }
  if (looksLikeClaudeProceedPrompt(screen.text)) {
    return false;
  }
  return true;
}

function looksLikeClaudeReplyIdleScreen(screen: CliSessionScreenSnapshot): boolean {
  return !looksLikeClaudeWorkingScreen(screen.text)
    && !looksLikeClaudeProceedPrompt(screen.text)
    && (looksLikeClaudeIdleScreen(screen.text) || looksLikeClaudeUsableScreen(screen));
}

function looksLikeClaudePastedTextPrompt(screenExcerpt: string | undefined): boolean {
  const normalized = normalizeScreenMatchText(String(screenExcerpt || ""));
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("pasted text")
    || normalized.includes("paste text")
  );
}

function looksLikeCursorIdleScreen(screenExcerpt: string | undefined): boolean {
  return looksLikeClaudeIdleScreen(screenExcerpt);
}

function looksLikeCursorWorkingScreen(screenExcerpt: string | undefined): boolean {
  return looksLikeClaudeWorkingScreen(screenExcerpt);
}

function looksLikeCursorProceedPrompt(screenExcerpt: string | undefined): boolean {
  return looksLikeClaudeProceedPrompt(screenExcerpt);
}

function looksLikeCursorUsableScreen(screen: CliSessionScreenSnapshot): boolean {
  const normalized = String(screen.normalizedText || "").trim();
  if (!normalized) {
    return false;
  }
  if (looksLikeCursorWorkingScreen(screen.text)) {
    return false;
  }
  if (looksLikeCursorProceedPrompt(screen.text)) {
    return false;
  }
  return true;
}

function looksLikeCursorPastedTextPrompt(screenExcerpt: string | undefined): boolean {
  return looksLikeClaudePastedTextPrompt(screenExcerpt);
}

function isClaudeFamilyAdapter(adapter: CliSessionAdapterId): boolean {
  return adapter === "claude" || adapter === "gemini";
}

function getClaudeFamilyAdapterLabel(adapter: CliSessionAdapterId): string {
  return adapter === "gemini" ? "Gemini" : "Claude";
}

function getClaudeFamilyStatePrefix(adapter: CliSessionAdapterId): string {
  return adapter === "gemini" ? "gemini" : "claude";
}

function isCursorPromptShowingText(screenExcerpt: string | undefined, prompt: string): boolean {
  return isClaudePromptShowingText(screenExcerpt, prompt);
}

function isClaudePromptShowingText(screenExcerpt: string | undefined, prompt: string): boolean {
  const normalizedScreen = normalizeScreenMatchText(String(screenExcerpt || ""));
  const normalizedPrompt = normalizePromptMatchText(prompt);
  if (!normalizedScreen || !normalizedPrompt) {
    return false;
  }
  return normalizedScreen.includes(normalizedPrompt);
}

function looksLikeCopilotPromptLine(screenText: string): boolean {
  return String(screenText || "")
    .split("\n")
    .some((line) => /^\s*❯\s/.test(line));
}

type CopilotPromptLine = {
  index: number;
  text: string;
};

function getCopilotPromptLines(screenText: string): CopilotPromptLine[] {
  return String(screenText || "")
    .split("\n")
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => /^\s*❯\s/.test(line))
    .map(({ index, line }) => ({
      index,
      text: line.replace(/^\s*❯\s*/, "").trim(),
    }));
}

function getCopilotPromptLineText(screenText: string): string | undefined {
  const promptLines = getCopilotPromptLines(screenText);
  return promptLines[promptLines.length - 1]?.text;
}

function isCopilotFooterLine(line: string): boolean {
  const normalized = normalizePromptMatchText(line);
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("shift tab switch mode")
    || normalized.includes("remaining reqs")
    || normalized.includes("type to mention files")
    || normalized.includes("ctrl s run command")
    || normalized.includes("ctrl q enqueue")
  );
}

function isCopilotWorkspaceStatusLine(line: string): boolean {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return false;
  }
  return /^~\\/.test(trimmed) && /\[[^\]]+\]/.test(trimmed);
}

function looksLikeCopilotIdleScreen(screenExcerpt: string | undefined): boolean {
  const normalized = normalizeScreenMatchText(String(screenExcerpt || ""));
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("type to mention files")
    || normalized.includes("describe a task to get started")
    || (
      normalized.includes("shift tab switch mode")
      && looksLikeCopilotPromptLine(String(screenExcerpt || ""))
    )
  );
}

function looksLikeCopilotToolApprovalPrompt(screenExcerpt: string | undefined): boolean {
  const normalized = normalizeScreenMatchText(String(screenExcerpt || ""));
  if (!normalized) {
    return false;
  }
  const mentionsToolPrompt =
    normalized.includes("do you want to use this tool")
    || normalized.includes("do you want to use these tools")
    || normalized.includes("approve tool")
    || normalized.includes("approve all tools");
  const mentionsPositiveChoice =
    normalized.includes("enter to select")
    || normalized.includes(" 1 yes ")
    || normalized.startsWith("1 yes ")
    || normalized.includes(" yes and approve ")
    || normalized.includes("agentchatbus");
  return mentionsToolPrompt && mentionsPositiveChoice;
}

function looksLikeCopilotSeqMismatchChoicePrompt(screenExcerpt: string | undefined): boolean {
  const normalized = normalizeScreenMatchText(String(screenExcerpt || ""));
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("msg post was rejected due to a seq mismatch")
    && normalized.includes("use the interface options or reply with your choice")
  );
}

function extractCopilotSeqMismatchChoice(screenExcerpt: string | undefined): string | undefined {
  if (!looksLikeCopilotSeqMismatchChoicePrompt(screenExcerpt)) {
    return undefined;
  }
  const text = String(screenExcerpt || "");
  if (/wait for further instructions/i.test(text)) {
    return "Wait for further instructions";
  }
  if (/post a short reply acknowledging and proposing a coordination plan/i.test(text)) {
    return "Post a short reply acknowledging and proposing a coordination plan";
  }
  return undefined;
}

function extractCopilotToolApprovalKey(screenExcerpt: string | undefined): string | undefined {
  const normalized = normalizeScreenMatchText(String(screenExcerpt || ""));
  if (!normalized || !looksLikeCopilotToolApprovalPrompt(screenExcerpt)) {
    return undefined;
  }

  const toolMatch = normalized.match(
    /\b(bus connect|msg post|msg wait|thread create|thread close|thread archive|thread set state|thread settings update|agent update|agent register)\b/,
  );
  if (toolMatch?.[1]) {
    return toolMatch[1];
  }

  const permissionMatch = normalized.match(/permission request \d+ remaining/);
  if (permissionMatch?.[0]) {
    return `${permissionMatch[0]}::${normalized.slice(0, 160)}`;
  }

  return normalized.slice(0, 160);
}

function looksLikeCopilotBackgroundTaskDetour(screenExcerpt: string | undefined): boolean {
  const normalized = normalizeScreenMatchText(String(screenExcerpt || ""));
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("background agent started")
    || normalized.includes("read agent with agent id")
    || normalized.includes("background tasks")
    || normalized.includes("1 background tasks")
    || normalized.includes("1 background tasks")
    || normalized.includes("1 background tasks shift tab switch mode")
    || normalized.includes("1 background tasks shift tab")
    || normalized.includes("background tasks shift tab")
    || normalized.includes("background /tasks")
  );
}

function looksLikeCopilotForeignToolingLeak(screenExcerpt: string | undefined): boolean {
  const normalized = normalizeScreenMatchText(String(screenExcerpt || ""));
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("report_intent")
    || normalized.includes("multi_tool_use.parallel")
    || normalized.includes("developer instructions")
  );
}

function looksLikeCopilotAskUserDetour(screenExcerpt: string | undefined): boolean {
  const normalized = normalizeScreenMatchText(String(screenExcerpt || ""));
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("asked user")
    || normalized.includes("use the provided ask user tool")
    || normalized.includes("use the provided ask_user tool")
    || normalized.includes("would you like me to post")
    || normalized.includes("confirm whether to post")
    || normalized.includes("post updated introduction now")
    || normalized.includes("ready to post the introduction now")
    || normalized.includes("ready to post an updated introduction")
    || normalized.includes("ready to post the short introduction now")
  );
}

function looksLikeCopilotWorkingScreen(screenExcerpt: string | undefined): boolean {
  return looksLikeConversationalWorkingScreen(screenExcerpt);
}

function looksLikeCopilotUsableScreen(screen: CliSessionScreenSnapshot): boolean {
  const normalized = String(screen.normalizedText || "").trim();
  if (!normalized) {
    return false;
  }
  if (looksLikeCopilotWorkingScreen(screen.text)) {
    return false;
  }
  if (looksLikeCopilotToolApprovalPrompt(screen.text)) {
    return false;
  }
  if (looksLikeClaudeProceedPrompt(screen.text)) {
    return false;
  }
  return looksLikeCopilotPromptLine(screen.text);
}

function looksLikeCopilotReplyIdleScreen(screen: CliSessionScreenSnapshot): boolean {
  return !looksLikeCopilotWorkingScreen(screen.text)
    && !looksLikeClaudeProceedPrompt(screen.text)
    && looksLikeCopilotUsableScreen(screen);
}

function extractCopilotTerminalError(screenExcerpt: string | undefined): string | undefined {
  const lines = String(screenExcerpt || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (isCopilotFooterLine(line) || isCopilotWorkspaceStatusLine(line)) {
      continue;
    }
    if (/^✗\s+/u.test(line)) {
      return clipText(line.replace(/^✗\s+/u, "").trim(), 500);
    }
    const normalized = normalizeScreenMatchText(line);
    if (
      normalized.includes("you have no quota")
      || normalized.includes("execution failed")
      || normalized.includes("request failed")
      || normalized.includes("rate limit")
    ) {
      return clipText(line, 500);
    }
  }
  return undefined;
}

function isCopilotToolApprovalLine(line: string): boolean {
  const normalized = normalizePromptMatchText(line);
  if (!normalized) {
    return false;
  }
  if (
    normalized.includes("do you want to use this tool")
    || normalized.includes("to navigate")
    || normalized.includes("enter to select")
    || normalized.includes("approve tool")
    || normalized.includes("approve all tools")
    || normalized.includes("tell copilot what to do differently")
  ) {
    return true;
  }
  return /^\d+\.\s/.test(String(line || "").trim());
}

function stripCopilotStatusPrefix(line: string): string {
  return String(line || "").replace(/^[●○◎◉◌•]+\s*/u, "").trim();
}

function isCopilotTranscriptBulletLine(line: string): boolean {
  const normalized = normalizePromptMatchText(stripCopilotStatusPrefix(line));
  if (!normalized) {
    return false;
  }

  const transcriptPrefixes = [
    "msg_wait",
    "msg_post",
    "msg_get",
    "msg_list",
    "msg_edit",
    "msg_react",
    "bus_connect",
    "thread_create",
    "thread_get",
    "thread_list",
    "thread_close",
    "thread_archive",
    "thread_set_state",
    "thread_settings_get",
    "thread_settings_update",
    "thread_wait_state_get",
    "agent_register",
    "agent_update",
    "agent_resume",
    "agent_list",
    "sync_context",
  ];

  return transcriptPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

function extractCopilotActivityMarker(screenText: string): string | undefined {
  const lines = String(screenText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // Prefer the newest visible activity line near the bottom of the terminal.
  // Copilot can leave older spinner rows higher in the viewport while continuing
  // work on a newer row below; scanning bottom-up avoids latching onto stale rows.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^\s*❯\s/.test(line)) {
      continue;
    }
    if (isCopilotWorkspaceStatusLine(line) || isCopilotFooterLine(line)) {
      continue;
    }
    if (isCopilotToolApprovalLine(line)) {
      continue;
    }
    if (isCopilotTranscriptBulletLine(line)) {
      continue;
    }
    const match = /^\s*([◉●◎○◌])\b/u.exec(line) || /^\s*([◉●◎○◌])/u.exec(line);
    if (match?.[1]) {
      return `${match[1]}::${stripCopilotStatusPrefix(line).slice(0, 120)}`;
    }
  }

  return undefined;
}

function extractCopilotReplyFromScreen(screen: CliSessionScreenSnapshot): string | undefined {
  const lines = String(screen.text || "")
    .split("\n")
    .map((line) => line.trimEnd());

  const replyLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (replyLines.length > 0 && replyLines[replyLines.length - 1] !== "") {
        replyLines.push("");
      }
      continue;
    }
    if (/^\s*❯\s/.test(line)) {
      break;
    }
    if (isCopilotWorkspaceStatusLine(trimmed) || isCopilotFooterLine(trimmed)) {
      if (replyLines.length > 0) {
        break;
      }
      continue;
    }
    if (looksLikeCopilotWorkingScreen(trimmed) || isCopilotToolApprovalLine(trimmed)) {
      continue;
    }
    const normalized = normalizeScreenMatchText(trimmed);
    if (
      normalized.includes("choose one")
      || normalized.includes("use the interface options or reply with your choice")
    ) {
      continue;
    }
    replyLines.push(stripCopilotStatusPrefix(trimmed));
  }

  const reply = replyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!reply) {
    return undefined;
  }
  return clipText(reply, 2400);
}

function isCopilotPromptShowingText(screenExcerpt: string | undefined, prompt: string): boolean {
  const promptLine = getCopilotPromptLineText(String(screenExcerpt || ""));
  if (!promptLine) {
    return false;
  }
  const normalizedPromptLine = normalizePromptMatchText(promptLine);
  const normalizedPrompt = normalizePromptMatchText(prompt);
  return Boolean(normalizedPrompt) && normalizedPromptLine.includes(normalizedPrompt);
}

function looksLikeCodexContinuePrompt(normalizedText: string): boolean {
  if (!normalizedText) {
    return false;
  }
  return (
    normalizedText.includes("press enter to continue")
    || normalizedText.includes("press enter or return to continue")
    || normalizedText.includes("press return to continue")
    || (
      normalizedText.includes("continue")
      && (normalizedText.includes("press enter") || normalizedText.includes("press return"))
    )
    || (normalizedText.includes("trust") && normalizedText.includes("continue"))
  );
}

function looksLikeCodexPromptLine(screenText: string): boolean {
  return String(screenText || "")
    .split("\n")
    .some((line) => /^\s*[>›]\s/.test(line));
}

type CodexPromptLine = {
  index: number;
  text: string;
};

function getCodexPromptLines(screenText: string): CodexPromptLine[] {
  return String(screenText || "")
    .split("\n")
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => /^\s*[>›]\s/.test(line))
    .map(({ index, line }) => ({
      index,
      text: line.replace(/^\s*[>›]\s*/, "").trim(),
    }));
}

function getCodexPromptLineText(screenText: string): string | undefined {
  const promptLines = getCodexPromptLines(screenText);
  return promptLines[promptLines.length - 1]?.text;
}

function normalizePromptMatchText(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTranscriptText(input: string): string {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(ANSI_OSC_SEQUENCE, "")
    .replace(ANSI_CSI_SEQUENCE, "")
    .replace(ANSI_SINGLE_CHAR_SEQUENCE, "");
}

function looksLikeCodexReadyScreen(screen: CliSessionScreenSnapshot): boolean {
  const normalizedText = screen.normalizedText;
  if (!normalizedText) {
    return false;
  }
  return (
    normalizedText.includes("plan search build anything")
    || normalizedText.includes("plan search build anythnig")
    || (
      normalizedText.includes("openai codex")
      && normalizedText.includes("use skills to list available skills")
    )
    || (
      normalizedText.includes("openai codex")
      && normalizedText.includes("model to change")
      && normalizedText.includes("directory")
    )
    || (
      normalizedText.includes("openai codex")
      && looksLikeCodexStatusFooter(screen.text)
      && looksLikeCodexPromptLine(screen.text)
    )
    || (
      normalizedText.includes("build anything")
      && normalizedText.includes("plan")
      && normalizedText.includes("search")
    )
    || (
      looksLikeCodexStatusFooter(screen.text)
      && looksLikeCodexPromptLine(screen.text)
    )
  );
}

function looksLikeCodexWorkingScreen(screen: CliSessionScreenSnapshot): boolean {
  return String(screen.text || "")
    .split("\n")
    .some((line) => isCodexWorkingLine(line));
}

function looksLikeCodexPastedContentPrompt(screen: CliSessionScreenSnapshot): boolean {
  const promptLine = getCodexPromptLineText(screen.text);
  if (!promptLine) {
    return false;
  }
  const normalizedPromptLine = normalizePromptMatchText(promptLine);
  return normalizedPromptLine.includes("pasted content");
}

function looksLikeCodexStatusFooter(text: string): boolean {
  const normalized = normalizePromptMatchText(text);
  if (!normalized) {
    return false;
  }
  const hasUsageToken =
    normalized.includes(" left")
    || normalized.includes("% left")
    || normalized.includes(" remaining");
  const hasCodexIdentity =
    normalized.includes("gpt 5")
    || normalized.includes("gpt-5")
    || normalized.includes("documents")
    || normalized.includes("agentchatbus");
  return hasUsageToken && hasCodexIdentity;
}

function isCodexFooterLine(line: string): boolean {
  return looksLikeCodexStatusFooter(line);
}

function shouldTreatInputAsManualOverride(text: string): boolean {
  if (!text) {
    return false;
  }
  const printable = stripTerminalControlSequences(text)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return Boolean(printable);
}

function looksLikeCodexIdlePrompt(screen: CliSessionScreenSnapshot): boolean {
  return looksLikeCodexReadyScreen(screen) && looksLikeCodexPromptLine(screen.text);
}

function looksLikeCodexReplyIdleScreen(screen: CliSessionScreenSnapshot): boolean {
  return !looksLikeCodexWorkingScreen(screen) && looksLikeCodexPromptLine(screen.text);
}

function isCodexPromptShowingText(screen: CliSessionScreenSnapshot, prompt: string): boolean {
  const promptLine = getCodexPromptLineText(screen.text);
  if (!promptLine) {
    return false;
  }
  const normalizedPromptLine = normalizePromptMatchText(promptLine);
  const normalizedPrompt = normalizePromptMatchText(prompt);
  return Boolean(normalizedPrompt) && normalizedPromptLine.includes(normalizedPrompt);
}

function isCodexWakePromptShowing(screen: CliSessionScreenSnapshot, prompt: string): boolean {
  if (!prompt) {
    return false;
  }
  if (isCodexPromptShowingText(screen, prompt)) {
    return true;
  }
  const normalizedPrompt = normalizePromptMatchText(prompt);
  return Boolean(normalizedPrompt) && screen.normalizedText.includes(normalizedPrompt);
}

function extractClaudeReplyFromTranscript(rawOutput: string, prompt: string): string | undefined {
  // Claude doesn't use prompt markers like Codex's "> prompt"
  // Just extract everything after the prompt text appears
  const lines = normalizeTranscriptText(rawOutput)
    .split("\n")
    .map((line) => line.trimEnd());

  // Find where the prompt appears in the output
  const normalizedPrompt = normalizePromptMatchText(prompt);
  let promptIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (normalizePromptMatchText(line).includes(normalizedPrompt)) {
      promptIndex = index;
      break;
    }
  }

  // If we can't find the prompt, just take everything
  const startIndex = promptIndex >= 0 ? promptIndex + 1 : 0;

  const replyLines: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      if (replyLines.length > 0) {
        replyLines.push("");
      }
      continue;
    }
    // Skip the prompt marker ">"
    if (trimmed === ">") {
      break;
    }
    replyLines.push(trimmed);
  }

  const reply = replyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!reply) {
    return undefined;
  }
  return clipText(reply, 2400);
}

function extractCopilotReplyFromTranscript(rawOutput: string, prompt: string): string | undefined {
  const normalizedPrompt = normalizePromptMatchText(prompt);
  if (!normalizedPrompt) {
    return undefined;
  }

  const lines = normalizeTranscriptText(rawOutput)
    .split("\n")
    .map((line) => line.trimEnd());
  let promptIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = normalizePromptMatchText(lines[index]?.replace(/^\s*❯\s*/, ""));
    if (candidate.includes(normalizedPrompt)) {
      promptIndex = index;
    }
  }
  if (promptIndex < 0) {
    return undefined;
  }

  const replyLines: string[] = [];
  for (let index = promptIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] || "";
    const trimmed = line.trim();
    if (!trimmed) {
      if (replyLines.length > 0) {
        replyLines.push("");
      }
      continue;
    }
    if (looksLikeCopilotWorkingScreen(trimmed)) {
      continue;
    }
    if (isCopilotToolApprovalLine(trimmed)) {
      continue;
    }
    if (/^\s*❯\s/.test(line)) {
      break;
    }
    if (isCopilotFooterLine(trimmed) || isCopilotWorkspaceStatusLine(trimmed)) {
      break;
    }
    replyLines.push(trimmed);
  }

  const reply = replyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!reply) {
    return undefined;
  }
  return clipText(reply, 2400);
}

function extractCodexReplyFromTranscript(rawOutput: string, prompt: string): string | undefined {
  const normalizedPrompt = normalizePromptMatchText(prompt);
  if (!normalizedPrompt) {
    return undefined;
  }

  const lines = normalizeTranscriptText(rawOutput)
    .split("\n")
    .map((line) => line.trimEnd());
  let promptIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const candidate = normalizePromptMatchText(line.replace(/^\s*[>›]\s*/, ""));
    if (candidate.includes(normalizedPrompt)) {
      promptIndex = index;
    }
  }
  if (promptIndex < 0) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const trimmed = lines[index]?.trim() || "";
      if (isCodexWorkingLine(trimmed)) {
        promptIndex = index;
        break;
      }
    }
  }
  if (promptIndex < 0) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/^\s*[>›]\s/.test(lines[index] || "")) {
        promptIndex = index;
        break;
      }
    }
  }
  if (promptIndex < 0) {
    return undefined;
  }

  const replyLines: string[] = [];
  for (let index = promptIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      if (replyLines.length > 0) {
        replyLines.push("");
      }
      continue;
    }
    if (looksLikeCodexContinuePrompt(normalizePromptMatchText(trimmed))) {
      continue;
    }
    if (normalizePromptMatchText(trimmed).includes("working") && normalizePromptMatchText(trimmed).includes("esc to interrupt")) {
      continue;
    }
    if (/^\s*[>›]\s/.test(line)) {
      break;
    }
    if (isCodexFooterLine(trimmed)) {
      break;
    }
    replyLines.push(trimmed);
  }

  const reply = replyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!reply) {
    return undefined;
  }
  return normalizeCodexReplyExcerpt(reply);
}

function hasDecorativeCodexBullet(line: string): boolean {
  return /^\s*[•·●]\s+/.test(String(line || ""));
}

function normalizeCodexReplyExcerpt(reply: string | undefined): string | undefined {
  const value = String(reply || "").trim();
  if (!value) {
    return undefined;
  }

  const lines = value.split("\n");
  const nonEmptyLines = lines.filter((line) => Boolean(line.trim()));
  const allNonEmptyLinesUseDecorativeBullets =
    nonEmptyLines.length > 0 && nonEmptyLines.every((line) => hasDecorativeCodexBullet(line));
  if (allNonEmptyLinesUseDecorativeBullets) {
    for (let index = 0; index < lines.length; index += 1) {
      if (hasDecorativeCodexBullet(lines[index] || "")) {
        lines[index] = lines[index].replace(/^\s*[•·●]\s+/, "");
      }
    }
  } else {
    const firstNonEmptyIndex = lines.findIndex((line) => Boolean(line.trim()));
    if (firstNonEmptyIndex >= 0 && hasDecorativeCodexBullet(lines[firstNonEmptyIndex] || "")) {
      const remainingNonEmptyLines = lines
        .slice(firstNonEmptyIndex + 1)
        .map((line) => line.trim())
        .filter(Boolean);
      const looksLikeSingleDecorativeLeadBullet =
        remainingNonEmptyLines.length === 0 || !hasDecorativeCodexBullet(remainingNonEmptyLines[0]);
      if (looksLikeSingleDecorativeLeadBullet) {
        lines[firstNonEmptyIndex] = lines[firstNonEmptyIndex].replace(/^\s*[•·●]\s+/, "");
      }
    }
  }

  const normalized = lines.join("\n").trim();
  if (!normalized) {
    return undefined;
  }
  return clipText(normalized, 2400);
}

function normalizeReplyComparisonText(reply: string | undefined): string {
  return String(normalizeCodexReplyExcerpt(reply) || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function areEquivalentReplyExcerpts(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeReplyComparisonText(left);
  const normalizedRight = normalizeReplyComparisonText(right);
  return Boolean(normalizedLeft) && normalizedLeft === normalizedRight;
}

function findLastCodexReplyBlockStart(lines: string[], endExclusive: number): number {
  let index = Math.min(lines.length, endExclusive) - 1;

  while (index >= 0) {
    const trimmed = lines[index]?.trim() || "";
    if (!trimmed || isCodexFooterLine(trimmed)) {
      index -= 1;
      continue;
    }
    break;
  }

  if (index < 0) {
    return endExclusive;
  }

  let blankRun = 0;
  for (; index >= 0; index -= 1) {
    const line = lines[index] || "";
    const trimmed = line.trim();
    if (!trimmed) {
      blankRun += 1;
      if (blankRun >= 2) {
        return index + 1;
      }
      continue;
    }
    blankRun = 0;
    if (/^\s*[>›]\s/.test(line) || isCodexWorkingLine(trimmed)) {
      return index + 1;
    }
    if (isCodexFooterLine(trimmed)) {
      return index + 1;
    }
  }

  return 0;
}

function extractCodexReplyFromScreen(screen: CliSessionScreenSnapshot, prompt: string): string | undefined {
  const normalizedPrompt = normalizePromptMatchText(prompt);
  if (!normalizedPrompt) {
    return undefined;
  }

  const lines = String(screen.text || "")
    .split("\n")
    .map((line) => line.trimEnd());

  const promptLines = getCodexPromptLines(screen.text);
  const activePrompt = promptLines[promptLines.length - 1];
  const endExclusive = activePrompt ? activePrompt.index : lines.length;
  if (endExclusive <= 0) {
    return undefined;
  }

  let startIndex = -1;
  for (const promptLine of promptLines) {
    if (promptLine.index >= endExclusive) {
      break;
    }
    if (normalizePromptMatchText(promptLine.text).includes(normalizedPrompt)) {
      startIndex = promptLine.index + 1;
    }
  }

  if (startIndex < 0) {
    for (let index = endExclusive - 1; index >= 0; index -= 1) {
      if (isCodexWorkingLine(lines[index] || "")) {
        startIndex = index + 1;
        break;
      }
    }
  }

  if (startIndex < 0) {
    startIndex = findLastCodexReplyBlockStart(lines, endExclusive);
  }

  if (startIndex >= endExclusive) {
    return undefined;
  }

  const replyLines: string[] = [];
  for (let index = startIndex; index < endExclusive; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      if (replyLines.length > 0) {
        replyLines.push("");
      }
      continue;
    }
    if (isCodexFooterLine(trimmed)) {
      continue;
    }
    if (/^\s*[>›]\s/.test(line)) {
      break;
    }
    if (isCodexWorkingLine(trimmed)) {
      continue;
    }
    replyLines.push(trimmed);
  }

  const reply = replyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!reply) {
    return undefined;
  }
  return normalizeCodexReplyExcerpt(reply);
}

function stripTrailingPlaceholderLine(reply: string | undefined, screen: CliSessionScreenSnapshot): string | undefined {
  const value = String(reply || "").trim();
  if (!value) {
    return undefined;
  }
  const currentPromptText = getCodexPromptLineText(screen.text);
  if (!currentPromptText) {
    return value;
  }
  const lines = value.split("\n");
  const lastLine = lines[lines.length - 1]?.trim();
  if (normalizePromptMatchText(lastLine) === normalizePromptMatchText(currentPromptText)) {
    const trimmed = lines.slice(0, -1).join("\n").trim();
    return trimmed || undefined;
  }
  if (normalizePromptMatchText(value) === normalizePromptMatchText(currentPromptText)) {
    return undefined;
  }
  return value;
}

function getCodexReplyTimeoutMs(
  deliveryMode?: CliSessionSnapshot["context_delivery_mode"],
): number {
  return CLI_REPLY_TIMEOUT_MS;
}

export class CliSessionManager {
  private readonly runtimes = new Map<string, CliSessionRuntime>();
  private readonly adapters = new Map<string, CliSessionAdapter>();

  constructor(adapters: CliSessionAdapter[] = [
    new CursorDirectAdapter(),
    new CursorInteractiveAdapter(),
    new CursorHeadlessAdapter(),
    new CodexInteractiveAdapter(),
    new CodexHeadlessAdapter(),
    new CodexDirectAdapter(),
    new CopilotDirectAdapter(),
    new CopilotInteractiveAdapter(),
    new CopilotHeadlessAdapter(),
    new ClaudeDirectAdapter(),
    new ClaudeInteractiveAdapter(),
    new ClaudeHeadlessAdapter(),
    new GeminiInteractiveAdapter(),
    new GeminiHeadlessAdapter(),
  ]) {
    for (const adapter of adapters) {
      this.adapters.set(this.adapterKey(adapter.adapterId, adapter.mode), adapter);
    }
    eventBus.subscribe((event) => {
      if (String(event?.type || "") !== "mcp.tool.called") {
        return;
      }
      const payload = (event?.payload || {}) as Record<string, unknown>;
      const agentId = typeof payload.agent_id === "string" ? payload.agent_id : undefined;
      const threadId = typeof payload.thread_id === "string" ? payload.thread_id : undefined;
      const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
      const at = typeof payload.at === "string" ? payload.at : undefined;
      if (agentId && toolName) {
        this.recordObservedToolCall(agentId, toolName, threadId, at);
      }
    });
  }

  createSession(input: CreateCliSessionInput): CliSessionSnapshot {
    const prompt = String(input.prompt || "");
    const adapterId = String(input.adapter || "").trim() as CliSessionAdapterId;
    const defaultMode = getDefaultModeForAdapter(adapterId);
    const requestedMode = (String(input.mode || defaultMode).trim() || defaultMode) as CliSessionMode;
    const mode = requestedMode === "headless"
      ? "headless"
      : requestedMode === "direct"
        ? "direct"
        : "interactive";
    const adapter = this.adapters.get(this.adapterKey(adapterId, mode));
    if (!adapter) {
      throw new Error(`Unsupported CLI adapter '${adapterId}' in mode '${mode}'`);
    }
    if (adapter.requiresPrompt && !prompt.trim()) {
      throw new Error("prompt is required");
    }

    const workspace = normalizeWorkspacePathUtil(input.workspace);
    const cols = adapter.supportsResize ? normalizeTerminalCols(input.cols) : undefined;
    const rows = adapter.supportsResize ? normalizeTerminalRows(input.rows) : undefined;
    const initialInstruction = String(input.initialInstruction || "").trim() || undefined;
    const model = String(input.model || "").trim() || undefined;
    const reasoningEffort = String(input.reasoningEffort || "").trim() || undefined;
    const permissionMode = String(
      input.permissionMode || getDefaultPermissionModeForAdapter(adapterId) || "",
    ).trim() || undefined;
    const participantAgentId = String(input.participantAgentId || "").trim() || undefined;
    const participantDisplayName = String(input.participantDisplayName || "").trim() || undefined;
    const participantRole = input.participantRole;
    const meetingTransport = input.meetingTransport || "agent_mcp";
    const contextDeliveryMode = input.contextDeliveryMode;
    const lastDeliveredSeq = Number.isFinite(Number(input.lastDeliveredSeq))
      ? Number(input.lastDeliveredSeq)
      : undefined;
    const snapshot: CliSessionSnapshot = {
      id: randomUUID(),
      thread_id: input.threadId,
      thread_display_name: String(input.threadDisplayName || "").trim() || undefined,
      reentry_prompt_override: String(input.reentryPromptOverride || "").trim() || undefined,
      adapter: adapterId,
      mode,
      model,
      reasoning_effort: reasoningEffort,
      permission_mode: permissionMode,
      state: "created",
      prompt,
      prompt_history: prompt.trim()
        ? [{
          at: nowIso(),
          kind: "initial",
          prompt,
        }]
        : [],
      initial_instruction: initialInstruction,
      workspace,
      requested_by_agent_id: input.requestedByAgentId,
      participant_agent_id: participantAgentId,
      participant_display_name: participantDisplayName,
      participant_role: participantRole,
      meeting_transport: meetingTransport,
      created_at: nowIso(),
      updated_at: nowIso(),
      run_count: 0,
      supports_input: adapter.supportsInput,
      supports_restart: adapter.supportsRestart,
      supports_resize: adapter.supportsResize,
      output_cursor: 0,
      raw_result: null,
      cols,
      rows,
      shell: adapter.shell,
      recent_activity_events: [],
      native_turn_runtime: {
        updated_at: nowIso(),
        phase: "idle",
      },
      wait_status: {
        is_waiting: false,
        status: "idle",
      },
      context_delivery_mode: contextDeliveryMode,
      last_delivered_seq: lastDeliveredSeq,
      last_acknowledged_seq: lastDeliveredSeq,
      meeting_post_state: participantAgentId ? "pending" : undefined,
    };

    const runtime: CliSessionRuntime = {
      snapshot,
      output: [],
      outputParseBuffer: "",
      stopRequested: false,
      abortController: null,
      runPromise: null,
      controls: null,
      screenState: null,
      automationState: null,
      replyCapture: null,
      launchEnv: { ...(input.launchEnv || {}) },
    };

    // Keep the PTY-facing runtime shape even for "agent_mcp" sessions.
    // The new MCP-first entry path no longer depends on PTY relay for meeting coordination,
    // but the existing terminal/session plumbing is still useful for visibility, fallback
    // adapters, and future hybrid flows. This compatibility layer is intentionally retained.
    this.runtimes.set(snapshot.id, runtime);
    this.emitSessionEvent("cli.session.created", runtime);
    runtime.runPromise = this.runRuntime(runtime);
    return this.cloneSnapshot(runtime.snapshot);
  }

  getSession(sessionId: string): CliSessionSnapshot | null {
    const runtime = this.runtimes.get(sessionId);
    return runtime ? this.cloneSnapshot(runtime.snapshot) : null;
  }

  updateSessionPrompt(sessionId: string, patch: CliSessionPromptPatch): CliSessionSnapshot | null {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }
    const nextPrompt = String(patch.prompt || "");
    if (runtime.snapshot.prompt === nextPrompt) {
      return this.cloneSnapshot(runtime.snapshot);
    }
    runtime.snapshot.prompt = nextPrompt;
    this.recordPromptHistory(runtime, nextPrompt, "update");
    runtime.snapshot.updated_at = nowIso();
    this.emitSessionEvent("cli.session.state", runtime);
    return this.cloneSnapshot(runtime.snapshot);
  }

  updateSessionLaunchEnv(sessionId: string, launchEnv: Record<string, string>): CliSessionSnapshot | null {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }
    runtime.launchEnv = { ...launchEnv };
    runtime.snapshot.updated_at = nowIso();
    this.emitSessionEvent("cli.session.state", runtime);
    return this.cloneSnapshot(runtime.snapshot);
  }

  updateSessionWaitStatus(
    sessionId: string,
    waitStatus: CliSessionWaitStatusSnapshot,
  ): CliSessionSnapshot | null {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }
    const normalized: CliSessionWaitStatusSnapshot = {
      is_waiting: Boolean(waitStatus?.is_waiting),
      status: (String(waitStatus?.status || "idle").trim() as CliSessionWaitStatusSnapshot["status"]) || "idle",
      wait_call_id: String(waitStatus?.wait_call_id || "").trim() || undefined,
      entered_at: String(waitStatus?.entered_at || "").trim() || undefined,
      timeout_ms: Number.isFinite(Number(waitStatus?.timeout_ms))
        ? Number(waitStatus?.timeout_ms)
        : undefined,
      last_exit_reason: String(waitStatus?.last_exit_reason || "").trim() || undefined,
      last_exited_at: String(waitStatus?.last_exited_at || "").trim() || undefined,
    };
    const previous = JSON.stringify(runtime.snapshot.wait_status || null);
    const next = JSON.stringify(normalized);
    if (previous === next) {
      return this.cloneSnapshot(runtime.snapshot);
    }
    runtime.snapshot.wait_status = normalized;
    runtime.snapshot.updated_at = nowIso();
    this.emitSessionEvent("cli.session.state", runtime);
    return this.cloneSnapshot(runtime.snapshot);
  }

  updateSessionThreadDisplayName(sessionId: string, threadDisplayName: string): CliSessionSnapshot | null {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }
    const nextThreadDisplayName = String(threadDisplayName || "").trim() || undefined;
    if (runtime.snapshot.thread_display_name === nextThreadDisplayName) {
      return this.cloneSnapshot(runtime.snapshot);
    }
    runtime.snapshot.thread_display_name = nextThreadDisplayName;
    runtime.snapshot.updated_at = nowIso();
    this.emitSessionEvent("cli.session.state", runtime);
    return this.cloneSnapshot(runtime.snapshot);
  }

  updateMeetingState(sessionId: string, patch: CliSessionMeetingStatePatch): CliSessionSnapshot | null {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }
    const entries = Object.entries(patch) as Array<[keyof CliSessionMeetingStatePatch, CliSessionMeetingStatePatch[keyof CliSessionMeetingStatePatch]]>;
    let changed = false;
    const snapshotRecord = runtime.snapshot as unknown as Record<string, unknown>;
    for (const [key, value] of entries) {
      if (value === undefined) {
        continue;
      }
      if (snapshotRecord[key] === value) {
        continue;
      }
      snapshotRecord[key] = value;
      changed = true;
    }
    if (!changed) {
      return this.cloneSnapshot(runtime.snapshot);
    }
    runtime.snapshot.updated_at = nowIso();
    this.emitSessionEvent("cli.session.state", runtime);
    return this.cloneSnapshot(runtime.snapshot);
  }

  clearWakePromptState(sessionId: string): CliSessionSnapshot | null {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }
    const automation = runtime.automationState;
    if (!automation) {
      return this.cloneSnapshot(runtime.snapshot);
    }
    const hadWakePrompt =
      Boolean(String(automation.wakePromptText || "").trim())
      || automation.wakePromptEnterSent
      || automation.wakePromptEnterRetried;
    automation.wakePromptText = undefined;
    automation.wakePromptEnterSent = false;
    automation.wakePromptEnterRetried = false;
    automation.copilotAskUserCorrectionSent = false;
    if (hadWakePrompt) {
      runtime.snapshot.updated_at = nowIso();
      this.emitSessionEvent("cli.session.state", runtime);
    }
    return this.cloneSnapshot(runtime.snapshot);
  }

  listSessionsForThread(threadId: string): CliSessionSnapshot[] {
    return Array.from(this.runtimes.values())
      .filter((runtime) => runtime.snapshot.thread_id === threadId)
      .sort((left, right) => right.snapshot.created_at.localeCompare(left.snapshot.created_at))
      .map((runtime) => this.cloneSnapshot(runtime.snapshot));
  }

  getSessionOutput(
    sessionId: string,
    after = 0,
    limit = 200,
  ): { entries: CliSessionOutputEntry[]; next_cursor: number } | null {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }
    const normalizedAfter = Math.max(0, Number(after) || 0);
    const normalizedLimit = Math.min(Math.max(1, Number(limit) || 200), 1000);
    const entries = runtime.output.filter((entry) => entry.seq > normalizedAfter).slice(0, normalizedLimit);
    const nextCursor = entries.length > 0
      ? entries[entries.length - 1].seq
      : runtime.snapshot.output_cursor;
    return {
      entries: entries.map((entry) => ({ ...entry })),
      next_cursor: nextCursor,
    };
  }

  async restartSession(
    sessionId: string,
    options?: {
      prompt?: string;
      promptHistoryKind?: "initial" | "update" | "wake" | "delivery";
      contextDeliveryMode?: CliSessionSnapshot["context_delivery_mode"];
    },
  ): Promise<CliSessionSnapshot | null> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }
    const adapter = this.adapters.get(this.adapterKey(runtime.snapshot.adapter, runtime.snapshot.mode));
    if (!adapter || !adapter.supportsRestart) {
      throw new Error("Session does not support restart");
    }
    // Wait for any running promise to complete before restarting
    if (runtime.runPromise) {
      await runtime.runPromise.catch(() => {
        // Ignore errors from previous run
      });
    }

    const nextPrompt = String(options?.prompt || "").trim();
    if (nextPrompt) {
      runtime.snapshot.prompt = nextPrompt;
      this.recordPromptHistory(
        runtime,
        nextPrompt,
        options?.promptHistoryKind || "update",
      );
    }
    if (options?.contextDeliveryMode) {
      runtime.snapshot.context_delivery_mode = options.contextDeliveryMode;
    }

    runtime.stopRequested = false;
    runtime.output = [];
    runtime.controls = null;
    runtime.snapshot.output_cursor = 0;
    runtime.snapshot.pid = undefined;
    runtime.snapshot.exit_code = undefined;
    runtime.snapshot.last_error = undefined;
    runtime.snapshot.last_result = undefined;
    runtime.snapshot.raw_result = null;
    runtime.snapshot.stdout_excerpt = undefined;
    runtime.snapshot.stderr_excerpt = undefined;
    runtime.snapshot.external_session_id = undefined;
    runtime.snapshot.external_request_id = undefined;
    runtime.snapshot.screen_excerpt = undefined;
    runtime.snapshot.screen_cursor_x = undefined;
    runtime.snapshot.screen_cursor_y = undefined;
    runtime.snapshot.screen_buffer = undefined;
    runtime.snapshot.interactive_work_state = undefined;
    runtime.snapshot.interactive_work_reason = undefined;
    runtime.snapshot.automation_state = undefined;
    runtime.snapshot.reply_capture_state = undefined;
    runtime.snapshot.reply_capture_excerpt = undefined;
    runtime.snapshot.reply_capture_error = undefined;
    runtime.snapshot.last_acknowledged_seq = runtime.snapshot.last_delivered_seq;
    runtime.snapshot.last_posted_seq = undefined;
    runtime.snapshot.meeting_post_state = runtime.snapshot.participant_agent_id ? "pending" : undefined;
    runtime.snapshot.meeting_post_error = undefined;
    runtime.snapshot.last_posted_message_id = undefined;
    runtime.snapshot.native_turn_runtime = {
      updated_at: nowIso(),
      phase: "idle",
      thread_id: this.resolveLaunchExternalThreadId(
        runtime.snapshot.adapter,
        runtime.snapshot.mode,
        runtime.launchEnv,
      ),
    };
    runtime.snapshot.updated_at = nowIso();
    this.disposeInteractiveRuntimeState(runtime);
    this.emitSessionEvent("cli.session.restarting", runtime);
    runtime.runPromise = this.runRuntime(runtime);
    return this.cloneSnapshot(runtime.snapshot);
  }

  async stopSession(sessionId: string): Promise<CliSessionSnapshot | null> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }

    runtime.stopRequested = true;
    runtime.abortController?.abort();
    try {
      runtime.controls?.kill?.();
    } catch {
      // Best effort shutdown.
    }

    if (!runtime.runPromise) {
      runtime.snapshot.state = "stopped";
      runtime.snapshot.updated_at = nowIso();
      this.emitSessionEvent("cli.session.stopped", runtime);
      return this.cloneSnapshot(runtime.snapshot);
    }

    await runtime.runPromise.catch(() => {
      // Surface final snapshot state below.
    });
    return this.cloneSnapshot(runtime.snapshot);
  }

  async removeSession(sessionId: string): Promise<CliSessionSnapshot | null> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }

    await this.stopSession(sessionId);
    const latestRuntime = this.runtimes.get(sessionId);
    if (!latestRuntime) {
      return null;
    }

    const snapshot = this.cloneSnapshot(latestRuntime.snapshot);
    this.disposeInteractiveRuntimeState(latestRuntime);
    latestRuntime.output = [];
    latestRuntime.outputParseBuffer = "";
    latestRuntime.controls = null;
    latestRuntime.abortController = null;
    latestRuntime.runPromise = null;
    this.runtimes.delete(sessionId);
    eventBus.emit({
      type: "cli.session.removed",
      payload: {
        thread_id: snapshot.thread_id,
        session_id: snapshot.id,
        session: snapshot,
      },
    });
    return snapshot;
  }

  async clearSessionsForThread(threadId: string): Promise<CliSessionSnapshot[]> {
    const resolvedThreadId = String(threadId || "").trim();
    if (!resolvedThreadId) {
      return [];
    }
    const sessionIds = Array.from(this.runtimes.values())
      .filter((runtime) => runtime.snapshot.thread_id === resolvedThreadId)
      .map((runtime) => runtime.snapshot.id);
    if (!sessionIds.length) {
      return [];
    }
    const cleared: CliSessionSnapshot[] = [];
    for (const sessionId of sessionIds) {
      const removed = await this.removeSession(sessionId);
      if (removed) {
        cleared.push(removed);
      }
    }
    return cleared;
  }

  async sendInput(sessionId: string, text: string): Promise<{ ok: boolean; error?: string } | null> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }
    if (!runtime.snapshot.supports_input || !runtime.controls?.write) {
      return {
        ok: false,
        error: `Session adapter '${runtime.snapshot.adapter}' in mode '${runtime.snapshot.mode}' does not support interactive input yet.`,
      };
    }
    if (runtime.automationState && shouldTreatInputAsManualOverride(text)) {
      runtime.automationState.manualOverride = true;
      this.updateAutomationState(runtime, "manual_input_override");
    }
    runtime.controls.write(text);
    runtime.snapshot.updated_at = nowIso();
    return { ok: true };
  }

  async deliverWakePrompt(
    sessionId: string,
    prompt: string,
  ): Promise<{ ok: boolean; session?: CliSessionSnapshot; error?: string } | null> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }
    if (!runtime.snapshot.supports_input || !runtime.controls?.write) {
      return {
        ok: false,
        error: `Session adapter '${runtime.snapshot.adapter}' in mode '${runtime.snapshot.mode}' does not support interactive wake prompts.`,
      };
    }
    if (runtime.snapshot.state !== "running") {
      return {
        ok: false,
        error: `Session '${sessionId}' is not running and cannot receive a wake prompt.`,
      };
    }

    const normalizedPrompt = String(prompt || "").trim();
    if (!normalizedPrompt) {
      return {
        ok: false,
        error: "Wake prompt delivery requires non-empty content.",
      };
    }

    const automation = runtime.automationState;
    const pendingWakePrompt = String(automation?.wakePromptText || "").trim();
    if (
      automation
      && pendingWakePrompt
      && pendingWakePrompt === normalizedPrompt
      && !automation.wakePromptEnterRetried
    ) {
      return {
        ok: true,
        session: this.cloneSnapshot(runtime.snapshot),
      };
    }

    runtime.snapshot.updated_at = nowIso();
    this.recordPromptHistory(runtime, normalizedPrompt, "wake");
    runtime.controls.write(normalizedPrompt);
    if (automation) {
      automation.wakePromptText = normalizedPrompt;
      automation.wakePromptEnterSent = false;
      automation.wakePromptEnterRetried = false;
    }

    if (runtime.snapshot.adapter === "codex" && runtime.snapshot.mode === "interactive") {
      this.updateAutomationState(runtime, "meeting_wake_prompt_sent");
      this.scheduleCodexDeliveryEnter(runtime, 1000, "sent_codex_wake_enter");
    } else if (runtime.snapshot.adapter === "cursor" && runtime.snapshot.mode === "interactive") {
      this.updateAutomationState(runtime, "meeting_wake_prompt_sent");
      this.scheduleCursorDelayedEnter(runtime, "sent_cursor_wake_enter", 1000);
    } else if (runtime.snapshot.adapter === "claude" && runtime.snapshot.mode === "interactive") {
      this.updateAutomationState(runtime, "meeting_wake_prompt_sent");
      this.scheduleClaudePastedTextEnter(runtime, "sent_claude_wake_enter", 1000);
    } else if (runtime.snapshot.adapter === "gemini" && runtime.snapshot.mode === "interactive") {
      this.updateAutomationState(runtime, "meeting_wake_prompt_sent");
      this.scheduleClaudePastedTextEnter(runtime, "sent_gemini_wake_enter", 1000);
    } else if (runtime.snapshot.adapter === "copilot" && runtime.snapshot.mode === "interactive") {
      this.updateAutomationState(runtime, "meeting_wake_prompt_sent");
      this.scheduleCopilotDelayedEnter(runtime, "sent_copilot_wake_enter", 1000);
    } else {
      runtime.controls.write("\r");
    }

    this.emitSessionEvent("cli.session.state", runtime);
    return {
      ok: true,
      session: this.cloneSnapshot(runtime.snapshot),
    };
  }

  async deliverPrompt(
    sessionId: string,
    prompt: string,
    options?: {
      deliveryMode?: "join" | "resume" | "incremental";
      deliveredSeq?: number;
    },
  ): Promise<{ ok: boolean; session?: CliSessionSnapshot; error?: string } | null> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }
    if (!runtime.snapshot.supports_input || !runtime.controls?.write) {
      return {
        ok: false,
        error: `Session adapter '${runtime.snapshot.adapter}' in mode '${runtime.snapshot.mode}' does not support interactive prompt delivery.`,
      };
    }
    if (runtime.snapshot.state !== "running") {
      return {
        ok: false,
        error: `Session '${sessionId}' is not running and cannot receive a coordinated prompt.`,
      };
    }

    const normalizedPrompt = String(prompt || "").trim();
    if (!normalizedPrompt) {
      return {
        ok: false,
        error: "Prompt delivery requires non-empty content.",
      };
    }

    runtime.snapshot.prompt = normalizedPrompt;
    this.recordPromptHistory(runtime, normalizedPrompt, "delivery");
    runtime.snapshot.context_delivery_mode = options?.deliveryMode || "incremental";
    if (Number.isFinite(Number(options?.deliveredSeq))) {
      runtime.snapshot.last_delivered_seq = Number(options?.deliveredSeq);
    }
    runtime.snapshot.last_posted_seq = undefined;
    runtime.snapshot.last_posted_message_id = undefined;
    runtime.snapshot.meeting_post_state = runtime.snapshot.participant_agent_id ? "pending" : undefined;
    runtime.snapshot.meeting_post_error = undefined;
    const previousExcerpt = runtime.snapshot.reply_capture_excerpt;
    runtime.snapshot.reply_capture_state = undefined;
    runtime.snapshot.reply_capture_excerpt = undefined;
    runtime.snapshot.reply_capture_error = undefined;
    if (runtime.replyCapture?.timeoutTimer) {
      clearTimeout(runtime.replyCapture.timeoutTimer);
    }
    if (runtime.replyCapture?.finalizeTimer) {
      clearTimeout(runtime.replyCapture.finalizeTimer);
    }
    if (runtime.automationState?.profile === "codex-startup") {
      runtime.automationState.deliveryPromptEnterRetried = false;
      runtime.automationState.wakePromptText = undefined;
      runtime.automationState.wakePromptEnterSent = false;
      runtime.automationState.wakePromptEnterRetried = false;
      runtime.automationState.copilotAskUserCorrectionSent = false;
    }
    runtime.replyCapture = null;
    this.startReplyCapture(runtime, normalizedPrompt, {
      baselineExcerpt: previousExcerpt,
      timeoutMs: getCodexReplyTimeoutMs(options?.deliveryMode),
    });
    runtime.controls.write(normalizedPrompt);
    this.updateAutomationState(runtime, "meeting_delivery_prompt_sent");
    if (runtime.snapshot.adapter === "codex" && runtime.snapshot.mode === "interactive") {
      this.scheduleCodexDeliveryEnter(runtime, 1000);
    } else if (runtime.snapshot.adapter === "cursor" && runtime.snapshot.mode === "interactive") {
      this.scheduleCursorDelayedEnter(runtime, "sent_cursor_delivery_enter", 1000);
    } else if (runtime.snapshot.adapter === "claude" && runtime.snapshot.mode === "interactive") {
      this.scheduleClaudePastedTextEnter(runtime, "sent_claude_delivery_enter", 1000);
    } else if (runtime.snapshot.adapter === "gemini" && runtime.snapshot.mode === "interactive") {
      this.scheduleClaudePastedTextEnter(runtime, "sent_gemini_delivery_enter", 1000);
    } else if (runtime.snapshot.adapter === "copilot" && runtime.snapshot.mode === "interactive") {
      this.scheduleCopilotDelayedEnter(runtime, "sent_copilot_delivery_enter", 1000);
    } else {
      runtime.controls.write("\r");
    }
    runtime.snapshot.updated_at = nowIso();
    this.emitSessionEvent("cli.session.state", runtime);
    return {
      ok: true,
      session: this.cloneSnapshot(runtime.snapshot),
    };
  }

  async resizeSession(
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<{ ok: boolean; session?: CliSessionSnapshot; error?: string } | null> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }
    const normalizedCols = normalizeTerminalCols(cols);
    const normalizedRows = normalizeTerminalRows(rows);
    runtime.snapshot.cols = normalizedCols;
    runtime.snapshot.rows = normalizedRows;
    if (!runtime.snapshot.supports_resize) {
      runtime.snapshot.updated_at = nowIso();
      this.emitSessionEvent("cli.session.state", runtime);
      return {
        ok: true,
        session: this.cloneSnapshot(runtime.snapshot),
      };
    }
    if (runtime.controls?.resize) {
      runtime.controls.resize(normalizedCols, normalizedRows);
      runtime.screenState?.terminal.resize(normalizedCols, normalizedRows);
      if (runtime.screenState) {
        this.refreshScreenSnapshot(runtime, snapshotHeadlessScreen(runtime.screenState.terminal));
      }
    }
    runtime.snapshot.updated_at = nowIso();
    this.emitSessionEvent("cli.session.state", runtime);
    return {
      ok: true,
      session: this.cloneSnapshot(runtime.snapshot),
    };
  }

  async close(): Promise<void> {
    await Promise.all(
      Array.from(this.runtimes.keys()).map((sessionId) => this.stopSession(sessionId))
    );
  }

  private async runRuntime(runtime: CliSessionRuntime): Promise<void> {
    const adapter = this.adapters.get(this.adapterKey(runtime.snapshot.adapter, runtime.snapshot.mode));
    if (!adapter) {
      runtime.snapshot.state = "failed";
      runtime.snapshot.last_error = `Missing adapter '${runtime.snapshot.adapter}'`;
      runtime.snapshot.updated_at = nowIso();
      this.emitSessionEvent("cli.session.state", runtime);
      runtime.runPromise = null;
      return;
    }

    runtime.stopRequested = false;
    runtime.abortController = new AbortController();
    runtime.controls = null;
    runtime.outputParseBuffer = "";
    this.prepareInteractiveRuntimeState(runtime);
    runtime.snapshot.run_count += 1;
    runtime.snapshot.state = "starting";
    runtime.snapshot.launch_started_at = nowIso();
    runtime.snapshot.process_started_at = undefined;
    runtime.snapshot.first_output_at = undefined;
    runtime.snapshot.last_output_at = undefined;
    runtime.snapshot.connected_at = undefined;
    runtime.snapshot.last_tool_call_at = undefined;
    runtime.snapshot.recent_tool_events = [];
    runtime.snapshot.recent_stream_events = [];
    runtime.snapshot.recent_activity_events = [];
    runtime.snapshot.native_turn_runtime = {
      updated_at: nowIso(),
      phase: "idle",
      thread_id: this.resolveLaunchExternalThreadId(
        runtime.snapshot.adapter,
        runtime.snapshot.mode,
        runtime.launchEnv,
      ),
    };
    runtime.snapshot.updated_at = nowIso();
    this.emitSessionEvent("cli.session.started", runtime);

    try {
      runtime.snapshot.state = "running";
      runtime.snapshot.updated_at = nowIso();
      this.emitSessionEvent("cli.session.state", runtime);

      if (
        runtime.snapshot.adapter === "copilot"
        && runtime.snapshot.mode === "interactive"
        && runtime.snapshot.prompt.trim()
        && !runtime.replyCapture
      ) {
        this.startReplyCapture(runtime, runtime.snapshot.prompt);
      }

      const result = await adapter.run(
        {
          prompt: runtime.snapshot.prompt,
          workspace: runtime.snapshot.workspace,
          cols: normalizeTerminalCols(runtime.snapshot.cols),
          rows: normalizeTerminalRows(runtime.snapshot.rows),
          model: runtime.snapshot.model,
          reasoningEffort: runtime.snapshot.reasoning_effort,
          permissionMode: runtime.snapshot.permission_mode,
          env: runtime.launchEnv,
        },
        {
          signal: runtime.abortController.signal,
          onOutput: (stream, text) => this.appendOutput(runtime, stream, text),
          onActivity: (activity) => this.appendActivity(runtime, activity),
          onNativeRuntime: (event) => this.applyNativeRuntimeEvent(runtime, event),
          onProcessStart: (pid) => {
            runtime.snapshot.pid = pid;
            runtime.snapshot.process_started_at = nowIso();
            runtime.snapshot.updated_at = nowIso();
            this.emitSessionEvent("cli.session.state", runtime);
          },
          onControls: (controls) => {
            runtime.controls = controls;
            if (
              runtime.snapshot.supports_resize
              && runtime.controls.resize
              && Number.isFinite(runtime.snapshot.cols)
              && Number.isFinite(runtime.snapshot.rows)
            ) {
              try {
                runtime.controls.resize(
                  normalizeTerminalCols(runtime.snapshot.cols),
                  normalizeTerminalRows(runtime.snapshot.rows),
                );
              } catch {
                // Best effort sync for early UI resize requests.
              }
            }
          },
        }
      );
      if (runtime.screenState) {
        await runtime.screenState.writeQueue.catch(() => {
          // Preserve the session result even if the headless parser failed.
        });
        this.finalizeReplyCaptureIfIdle(runtime, runtime.screenState.latest);
      }
      if (runtime.replyCapture) {
        if (runtime.replyCapture.excerpt) {
          this.updateReplyCaptureState(runtime, "completed", {
            excerpt: runtime.replyCapture.excerpt,
            clearTimer: true,
          });
        } else if (!runtime.replyCapture.error) {
          this.updateReplyCaptureState(runtime, "error", {
            error: `CLI session ended before a Codex reply was captured for '${runtime.replyCapture.prompt}'.`,
            clearTimer: true,
          });
        }
      }

      runtime.snapshot.pid = undefined;
      runtime.snapshot.exit_code = result.exitCode;
      runtime.snapshot.last_result = result.resultText;
      runtime.snapshot.raw_result = result.rawResult ?? null;
      runtime.snapshot.external_session_id = result.externalSessionId;
      runtime.snapshot.external_request_id = result.externalRequestId;
      runtime.snapshot.stdout_excerpt = clipText(result.stdout);
      runtime.snapshot.stderr_excerpt = clipText(result.stderr);
      runtime.snapshot.updated_at = nowIso();
      if (
        runtime.snapshot.adapter === "codex"
        && (runtime.snapshot.mode === "headless" || runtime.snapshot.mode === "direct")
        && result.externalSessionId
      ) {
        runtime.launchEnv = {
          ...runtime.launchEnv,
          [CODEX_THREAD_ID_ENV_VAR]: result.externalSessionId,
        };
      } else if (
        runtime.snapshot.adapter === "cursor"
        && (runtime.snapshot.mode === "headless" || runtime.snapshot.mode === "direct")
        && result.externalSessionId
      ) {
        runtime.launchEnv = {
          ...runtime.launchEnv,
          [CURSOR_SESSION_ID_ENV_VAR]: result.externalSessionId,
        };
      } else if (
        runtime.snapshot.adapter === "copilot"
        && runtime.snapshot.mode === "headless"
        && result.externalSessionId
      ) {
        runtime.launchEnv = {
          ...runtime.launchEnv,
          [COPILOT_SESSION_ID_ENV_VAR]: result.externalSessionId,
        };
      } else if (
        runtime.snapshot.adapter === "claude"
        && (runtime.snapshot.mode === "headless" || runtime.snapshot.mode === "direct")
        && result.externalSessionId
      ) {
        runtime.launchEnv = {
          ...runtime.launchEnv,
          [CLAUDE_SESSION_ID_ENV_VAR]: result.externalSessionId,
        };
      } else if (
        runtime.snapshot.adapter === "gemini"
        && runtime.snapshot.mode === "headless"
        && result.externalSessionId
      ) {
        runtime.launchEnv = {
          ...runtime.launchEnv,
          [GEMINI_SESSION_ID_ENV_VAR]: result.externalSessionId,
        };
      }

      if (runtime.stopRequested) {
        runtime.snapshot.state = "stopped";
        this.emitSessionEvent("cli.session.stopped", runtime);
      } else if (result.exitCode === 0) {
        runtime.snapshot.state = "completed";
        this.emitSessionEvent("cli.session.completed", runtime);
      } else {
        runtime.snapshot.state = "failed";
        runtime.snapshot.last_error = clipText(
          result.stderr || result.stdout || `Process exited with code ${result.exitCode ?? "unknown"}`,
          1200
        );
        this.emitSessionEvent("cli.session.failed", runtime);
      }
    } catch (error) {
      runtime.snapshot.pid = undefined;
      runtime.snapshot.updated_at = nowIso();
      if (runtime.stopRequested || runtime.abortController.signal.aborted) {
        runtime.snapshot.state = "stopped";
        this.emitSessionEvent("cli.session.stopped", runtime);
      } else {
        runtime.snapshot.state = "failed";
        runtime.snapshot.last_error = clipText(error instanceof Error ? error.message : String(error), 1200);
        logError(`[cli-session] ${runtime.snapshot.id} failed: ${runtime.snapshot.last_error}`);
        this.emitSessionEvent("cli.session.failed", runtime);
      }
    } finally {
      const settledState = runtime.snapshot.state;
      logInfo(
        `[cli-session] ${runtime.snapshot.adapter}/${runtime.snapshot.mode} ${runtime.snapshot.id} -> ${runtime.snapshot.state}`
      );
      runtime.abortController = null;
      runtime.controls = null;
      runtime.runPromise = null;
      this.disposeInteractiveRuntimeState(runtime);
      if (settledState === "completed" || settledState === "failed" || settledState === "stopped") {
        runtime.snapshot.updated_at = nowIso();
        this.emitSessionEvent("cli.session.state", runtime);
      }
    }
  }

  private appendOutput(runtime: CliSessionRuntime, stream: CliSessionStream, text: string): void {
    const normalized = String(text || "");
    if (!normalized) {
      return;
    }
    const entry: CliSessionOutputEntry = {
      seq: runtime.snapshot.output_cursor + 1,
      stream,
      text: normalized,
      created_at: nowIso(),
    };
    runtime.snapshot.output_cursor = entry.seq;
    runtime.snapshot.first_output_at = runtime.snapshot.first_output_at || entry.created_at;
    runtime.snapshot.last_output_at = entry.created_at;
    this.pushRecentStreamEvent(runtime, stream, entry.created_at);
    runtime.output.push(entry);
    // Use more efficient array truncation to avoid memory fragmentation
    const MAX_OUTPUT_ENTRIES = 5000;
    if (runtime.output.length > MAX_OUTPUT_ENTRIES) {
      const excessCount = runtime.output.length - MAX_OUTPUT_ENTRIES;
      runtime.output.splice(0, excessCount);
    }
    if (stream === "stdout") {
      runtime.snapshot.stdout_excerpt = clipText(`${runtime.snapshot.stdout_excerpt || ""}${normalized}`);
      this.captureRecentToolEvents(runtime, normalized);
      if (runtime.replyCapture) {
        this.clearReplyCaptureFinalizeTimer(runtime);
        runtime.replyCapture.rawOutput = clipText(`${runtime.replyCapture.rawOutput}${normalized}`, 24000);
        this.updateReplyCaptureFromOutput(runtime);
      }
    } else {
      runtime.snapshot.stderr_excerpt = clipText(`${runtime.snapshot.stderr_excerpt || ""}${normalized}`);
    }
    if (stream === "stdout" && runtime.screenState) {
      this.queueScreenWrite(runtime, normalized);
    }
    runtime.snapshot.updated_at = nowIso();
    eventBus.emit({
      type: "cli.session.output",
      payload: {
        thread_id: runtime.snapshot.thread_id,
        session_id: runtime.snapshot.id,
        entry: { ...entry },
      },
    });
  }

  private captureRecentToolEvents(runtime: CliSessionRuntime, text: string): void {
    if (!text) {
      return;
    }

    runtime.outputParseBuffer = `${runtime.outputParseBuffer}${text}`;
    const lines = runtime.outputParseBuffer.split(/\r?\n/g);
    runtime.outputParseBuffer = lines.pop() || "";

    let changed = false;
    for (const line of lines) {
      const trimmed = String(line || "").trim();
      if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const toolNames = extractToolNamesFromStructuredEvent(parsed);
        for (const toolName of toolNames) {
          if (this.pushRecentToolEvent(runtime, toolName)) {
            changed = true;
          }
        }
      } catch {
        // Ignore non-JSON or partial diagnostic lines.
      }
    }

    if (changed) {
      runtime.snapshot.updated_at = nowIso();
      this.emitSessionEvent("cli.session.state", runtime);
    }
  }

  private pushRecentToolEvent(runtime: CliSessionRuntime, toolName: string): boolean {
    const normalizedToolName = normalizeToolNameCandidate(toolName);
    if (!normalizedToolName) {
      return false;
    }

    const entries = Array.isArray(runtime.snapshot.recent_tool_events)
      ? [...runtime.snapshot.recent_tool_events]
      : [];
    const latest = entries[entries.length - 1];
    const nowIsoValue = nowIso();
    const now = new Date(nowIsoValue);
    if (latest?.tool_name === normalizedToolName) {
      const latestAt = Date.parse(String(latest.at || ""));
      if (Number.isFinite(latestAt) && now.getTime() - latestAt < 1000) {
        return false;
      }
    }

    entries.push({
      at: nowIsoValue,
      tool_name: normalizedToolName,
    });
    runtime.snapshot.recent_tool_events = entries.slice(-24);
    runtime.snapshot.last_tool_call_at = nowIsoValue;
    if (normalizedToolName === "bus_connect" && !runtime.snapshot.connected_at) {
      runtime.snapshot.connected_at = nowIsoValue;
    }
    return true;
  }

  private pushRecentStreamEvent(
    runtime: CliSessionRuntime,
    stream: CliSessionStream,
    at: string,
  ): void {
    const entries = Array.isArray(runtime.snapshot.recent_stream_events)
      ? [...runtime.snapshot.recent_stream_events]
      : [];
    entries.push({ at, stream });
    runtime.snapshot.recent_stream_events = entries.slice(-80);
  }

  private applyNativeRuntimeEvent(runtime: CliSessionRuntime, event: CliAdapterNativeRuntimeEvent): void {
    if (!event || typeof event !== "object") {
      return;
    }
    const normalizedThreadId = normalizeOptionalString(event.thread_id);
    const shouldPersistExternalSessionId =
      runtime.snapshot.adapter === "claude"
      || runtime.snapshot.adapter === "cursor"
      || runtime.snapshot.adapter === "copilot";
    if (
      normalizedThreadId
      && shouldPersistExternalSessionId
      && (runtime.snapshot.mode === "direct" || runtime.snapshot.mode === "headless")
      && runtime.snapshot.external_session_id !== normalizedThreadId
    ) {
      runtime.snapshot.external_session_id = normalizedThreadId;
      if (runtime.snapshot.adapter === "claude") {
        runtime.launchEnv = {
          ...runtime.launchEnv,
          [CLAUDE_SESSION_ID_ENV_VAR]: normalizedThreadId,
        };
      } else if (runtime.snapshot.adapter === "cursor") {
        runtime.launchEnv = {
          ...runtime.launchEnv,
          [CURSOR_SESSION_ID_ENV_VAR]: normalizedThreadId,
        };
      } else if (runtime.snapshot.adapter === "copilot") {
        runtime.launchEnv = {
          ...runtime.launchEnv,
          [COPILOT_SESSION_ID_ENV_VAR]: normalizedThreadId,
        };
      }
    }
    const next = mergeNativeTurnRuntime(runtime.snapshot.native_turn_runtime, event);
    const previousSerialized = JSON.stringify(runtime.snapshot.native_turn_runtime || null);
    const nextSerialized = JSON.stringify(next);
    if (previousSerialized === nextSerialized) {
      return;
    }
    runtime.snapshot.native_turn_runtime = next;
    runtime.snapshot.updated_at = nowIso();
    this.emitSessionEvent("cli.session.state", runtime);
  }

  private appendActivity(runtime: CliSessionRuntime, activity: CliAdapterActivityEvent): void {
    const normalized = this.normalizeActivityEvent(activity);
    if (!normalized) {
      return;
    }

    const entries = Array.isArray(runtime.snapshot.recent_activity_events)
      ? [...runtime.snapshot.recent_activity_events]
      : [];
    const latest = entries[entries.length - 1];
    if (
      latest
      && latest.item_id === normalized.item_id
      && latest.kind === normalized.kind
      && latest.status === normalized.status
      && latest.summary === normalized.summary
      && latest.content === normalized.content
      && latest.diff === normalized.diff
      && latest.command === normalized.command
      && latest.cwd === normalized.cwd
      && latest.server === normalized.server
      && latest.tool === normalized.tool
      && latest.started_at === normalized.started_at
      && latest.completed_at === normalized.completed_at
      && JSON.stringify(latest.files || []) === JSON.stringify(normalized.files || [])
      && JSON.stringify(latest.plan_steps || []) === JSON.stringify(normalized.plan_steps || [])
    ) {
      return;
    }

    entries.push(normalized);
    runtime.snapshot.recent_activity_events = entries.slice(-120);
    runtime.snapshot.updated_at = nowIso();
    eventBus.emit({
      type: "cli.session.activity",
      payload: {
        thread_id: runtime.snapshot.thread_id,
        session_id: runtime.snapshot.id,
        activity: { ...normalized },
        session: this.cloneSnapshot(runtime.snapshot),
      },
    });
    this.emitSessionEvent("cli.session.state", runtime);
  }

  private normalizeActivityEvent(activity: CliAdapterActivityEvent): CliAdapterActivityEvent | null {
    if (!activity || typeof activity !== "object") {
      return null;
    }
    const itemId = String(activity.item_id || "").trim();
    const kind = String(activity.kind || "").trim() as CliAdapterActivityEvent["kind"];
    const status = String(activity.status || "").trim() as CliAdapterActivityEvent["status"];
    const label = String(activity.label || "").trim();
    if (!itemId || !kind || !status || !label) {
      return null;
    }
    return {
      at: String(activity.at || "").trim() || nowIso(),
      turn_id: String(activity.turn_id || "").trim() || undefined,
      item_id: itemId,
      kind,
      status,
      label,
      summary: String(activity.summary || "").trim() || undefined,
      content: String(activity.content || "").trim() || undefined,
      server: String(activity.server || "").trim() || undefined,
      tool: String(activity.tool || "").trim() || undefined,
      command: String(activity.command || "").trim() || undefined,
      cwd: String(activity.cwd || "").trim() || undefined,
      files: Array.isArray(activity.files)
        ? activity.files
          .map((entry) => ({
            path: String(entry?.path || "").trim(),
            change_type: entry?.change_type,
            move_path: entry?.move_path ? String(entry.move_path).trim() : entry?.move_path ?? undefined,
          }))
          .filter((entry) => entry.path)
        : undefined,
      diff: String(activity.diff || "").trim() || undefined,
      plan_steps: Array.isArray(activity.plan_steps)
        ? activity.plan_steps
          .map((entry) => ({
            step: String(entry?.step || "").trim(),
            status: entry?.status,
          }))
          .filter((entry) => entry.step && entry.status)
        : undefined,
      started_at: String(activity.started_at || "").trim() || undefined,
      completed_at: String(activity.completed_at || "").trim() || undefined,
    };
  }

  private recordObservedToolCall(
    agentId: string,
    toolName: string,
    threadId?: string,
    at?: string,
  ): void {
    const normalizedToolName = normalizeToolNameCandidate(toolName);
    if (!normalizedToolName) {
      return;
    }

    const eventAt = String(at || "").trim() || nowIso();
    let changed = false;
    for (const runtime of this.runtimes.values()) {
      if (String(runtime.snapshot.participant_agent_id || "").trim() !== agentId) {
        continue;
      }
      if (threadId && String(runtime.snapshot.thread_id || "").trim() !== threadId) {
        continue;
      }
      const entries = Array.isArray(runtime.snapshot.recent_tool_events)
        ? [...runtime.snapshot.recent_tool_events]
        : [];
      const latest = entries[entries.length - 1];
      if (latest?.tool_name === normalizedToolName && latest?.at === eventAt) {
        continue;
      }
      entries.push({ at: eventAt, tool_name: normalizedToolName });
      runtime.snapshot.recent_tool_events = entries.slice(-24);
      runtime.snapshot.last_tool_call_at = eventAt;
      if (normalizedToolName === "bus_connect" && !runtime.snapshot.connected_at) {
        runtime.snapshot.connected_at = eventAt;
      }
      runtime.snapshot.updated_at = nowIso();
      this.emitSessionEvent("cli.session.state", runtime);
      changed = true;
    }
    if (changed) {
      return;
    }
  }

  private prepareInteractiveRuntimeState(runtime: CliSessionRuntime): void {
    this.disposeInteractiveRuntimeState(runtime);
    runtime.snapshot.screen_excerpt = undefined;
    runtime.snapshot.screen_cursor_x = undefined;
    runtime.snapshot.screen_cursor_y = undefined;
    runtime.snapshot.screen_buffer = undefined;
    runtime.snapshot.automation_state = undefined;
    runtime.snapshot.reply_capture_state = undefined;
    runtime.snapshot.reply_capture_excerpt = undefined;
    runtime.snapshot.reply_capture_error = undefined;
    if (!runtime.snapshot.supports_input) {
      return;
    }

    const terminal = new HeadlessTerminal({
      allowProposedApi: true,
      cols: normalizeTerminalCols(runtime.snapshot.cols),
      rows: normalizeTerminalRows(runtime.snapshot.rows),
      scrollback: 2000,
    });
    const initialScreen = snapshotHeadlessScreen(terminal);
    runtime.screenState = {
      terminal,
      writeQueue: Promise.resolve(),
      latest: initialScreen,
    };
    this.refreshScreenSnapshot(runtime, initialScreen);

    if (runtime.snapshot.adapter === "codex" && runtime.snapshot.mode === "interactive") {
      runtime.automationState = {
        profile: "codex-startup",
        continueSent: false,
        initialPromptTextScheduled: false,
        initialPromptTextSent: false,
        initialPromptEnterSent: false,
        initialPromptEnterRetried: false,
        deliveryPromptEnterRetried: false,
        wakePromptText: undefined,
        wakePromptEnterSent: false,
        wakePromptEnterRetried: false,
        manualOverride: false,
        sawReadyScreen: false,
        sawWorkingScreen: false,
        submitTimer: null,
        toolApprovalRetryTimer: null,
        activitySettleTimer: null,
        copilotAskUserCorrectionSent: false,
      };
      runtime.snapshot.automation_state = runtime.snapshot.prompt.trim()
        ? "waiting_for_codex_prompt"
        : "waiting_for_codex_startup";
    }

    if (isClaudeFamilyAdapter(runtime.snapshot.adapter) && runtime.snapshot.mode === "interactive") {
      const statePrefix = getClaudeFamilyStatePrefix(runtime.snapshot.adapter);
      runtime.automationState = {
        profile: "codex-startup",
        continueSent: false,
        initialPromptTextScheduled: false,
        initialPromptTextSent: false,
        initialPromptEnterSent: false,
        initialPromptEnterRetried: false,
        deliveryPromptEnterRetried: false,
        wakePromptText: undefined,
        wakePromptEnterSent: false,
        wakePromptEnterRetried: false,
        manualOverride: false,
        sawReadyScreen: false,
        sawWorkingScreen: false,
        submitTimer: null,
        toolApprovalRetryTimer: null,
        activitySettleTimer: null,
        copilotAskUserCorrectionSent: false,
      };
      runtime.snapshot.automation_state = runtime.snapshot.prompt.trim()
        ? `waiting_for_${statePrefix}_ready`
        : `waiting_for_${statePrefix}_startup`;
      this.scheduleClaudeStartupEnter(runtime, 1000);
    }

    if (runtime.snapshot.adapter === "cursor" && runtime.snapshot.mode === "interactive") {
      runtime.automationState = {
        profile: "codex-startup",
        continueSent: false,
        initialPromptTextScheduled: false,
        initialPromptTextSent: false,
        initialPromptEnterSent: false,
        initialPromptEnterRetried: false,
        deliveryPromptEnterRetried: false,
        wakePromptText: undefined,
        wakePromptEnterSent: false,
        wakePromptEnterRetried: false,
        manualOverride: false,
        sawReadyScreen: false,
        sawWorkingScreen: false,
        submitTimer: null,
        toolApprovalRetryTimer: null,
        activitySettleTimer: null,
        copilotAskUserCorrectionSent: false,
      };
      runtime.snapshot.automation_state = runtime.snapshot.prompt.trim()
        ? "waiting_for_cursor_ready"
        : "waiting_for_cursor_startup";
      this.scheduleCursorStartupEnter(runtime, 1000);
    }

    if (runtime.snapshot.adapter === "copilot" && runtime.snapshot.mode === "interactive") {
      runtime.automationState = {
        profile: "codex-startup",
        continueSent: false,
        initialPromptTextScheduled: false,
        initialPromptTextSent: Boolean(runtime.snapshot.prompt.trim()),
        initialPromptEnterSent: Boolean(runtime.snapshot.prompt.trim()),
        initialPromptEnterRetried: false,
        deliveryPromptEnterRetried: false,
        wakePromptText: undefined,
        wakePromptEnterSent: false,
        wakePromptEnterRetried: false,
        manualOverride: false,
        sawReadyScreen: false,
        sawWorkingScreen: false,
        submitTimer: null,
        toolApprovalRetryTimer: null,
        activitySettleTimer: null,
        copilotAskUserCorrectionSent: false,
      };
      runtime.snapshot.automation_state = runtime.snapshot.prompt.trim()
        ? "copilot_prompt_passed_to_cli"
        : "waiting_for_copilot_startup";
    }
  }

  private disposeInteractiveRuntimeState(runtime: CliSessionRuntime): void {
    if (runtime.automationState?.submitTimer) {
      clearTimeout(runtime.automationState.submitTimer);
      runtime.automationState.submitTimer = null;
    }
    if (runtime.automationState?.toolApprovalRetryTimer) {
      clearTimeout(runtime.automationState.toolApprovalRetryTimer);
      runtime.automationState.toolApprovalRetryTimer = null;
    }
    if (runtime.automationState?.activitySettleTimer) {
      clearTimeout(runtime.automationState.activitySettleTimer);
      runtime.automationState.activitySettleTimer = null;
    }
    if (runtime.replyCapture?.timeoutTimer) {
      clearTimeout(runtime.replyCapture.timeoutTimer);
      runtime.replyCapture.timeoutTimer = null;
    }
    if (runtime.replyCapture?.finalizeTimer) {
      clearTimeout(runtime.replyCapture.finalizeTimer);
      runtime.replyCapture.finalizeTimer = null;
    }
    try {
      runtime.screenState?.terminal.dispose();
    } catch (error) {
      // Log disposal errors for debugging but don't fail
      logError(`[cli-session] Failed to dispose terminal for session ${runtime.snapshot.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    runtime.screenState = null;
    runtime.automationState = null;
    runtime.replyCapture = null;
  }

  private queueScreenWrite(runtime: CliSessionRuntime, text: string): void {
    const screenState = runtime.screenState;
    if (!screenState) {
      return;
    }
    screenState.writeQueue = screenState.writeQueue
      .then(
        () =>
          new Promise<void>((resolve) => {
            if (runtime.screenState !== screenState) {
              resolve();
              return;
            }
            screenState.terminal.write(text, () => {
              if (runtime.screenState !== screenState) {
                resolve();
                return;
              }
              const screen = snapshotHeadlessScreen(screenState.terminal);
              screenState.latest = screen;
              this.refreshScreenSnapshot(runtime, screen);
              this.runAutomation(runtime, screen);
              if (this.syncObservedMeetingProgressFromScreen(runtime, screen)) {
                this.emitSessionEvent("cli.session.state", runtime);
              }
              resolve();
            });
          })
      )
      .catch((error: unknown) => {
        logError(
          `[cli-session] ${runtime.snapshot.id} failed to update headless terminal state: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
  }

  private refreshScreenSnapshot(runtime: CliSessionRuntime, screen: CliSessionScreenSnapshot): void {
    runtime.snapshot.screen_excerpt = buildHeadlessScreenSummary(screen);
    runtime.snapshot.screen_cursor_x = screen.cursorX;
    runtime.snapshot.screen_cursor_y = screen.cursorY;
    runtime.snapshot.screen_buffer = screen.bufferType;
  }

  private syncObservedMeetingProgressFromScreen(
    runtime: CliSessionRuntime,
    screen: CliSessionScreenSnapshot,
  ): boolean {
    if (!runtime.snapshot.participant_agent_id || runtime.snapshot.mode !== "interactive") {
      return false;
    }

    const observedCurrentSeq = extractObservedAgentCurrentSeq(screen.text);
    if (!Number.isFinite(observedCurrentSeq) || Number(observedCurrentSeq) <= 0) {
      return false;
    }

    const previousDeliveredSeq = Number(runtime.snapshot.last_delivered_seq) || 0;
    const nextDeliveredSeq = Math.max(previousDeliveredSeq, Number(observedCurrentSeq));

    if (nextDeliveredSeq === previousDeliveredSeq) {
      return false;
    }

    // Seeing current_seq in CLI tool output only proves that the model observed
    // a sync context, not that it actually processed or acknowledged the message.
    // Keep acknowledgement progression separate so the orchestrator can re-wake
    // weaker models that drop the msg_wait result without responding.
    runtime.snapshot.last_delivered_seq = nextDeliveredSeq;
    runtime.snapshot.updated_at = nowIso();
    return true;
  }

  private startReplyCapture(
    runtime: CliSessionRuntime,
    prompt: string,
    options?: { baselineExcerpt?: string; timeoutMs?: number },
  ): void {
    if (runtime.replyCapture?.timeoutTimer) {
      clearTimeout(runtime.replyCapture.timeoutTimer);
    }
    const timeoutMs = Math.max(1000, Math.floor(Number(options?.timeoutMs) || CLI_REPLY_TIMEOUT_MS));
    const capture: CliSessionReplyCaptureRuntime = {
      mode: "initial_prompt",
      prompt,
      rawOutput: "",
      state: "waiting_for_reply",
      baselineExcerpt: normalizeCodexReplyExcerpt(options?.baselineExcerpt),
      timeoutTimer: null,
      finalizeTimer: null,
    };
    runtime.replyCapture = capture;
    this.refreshReplyCaptureSnapshot(runtime);
    capture.timeoutTimer = setTimeout(() => {
      if (runtime.replyCapture !== capture || capture.state === "completed") {
        return;
      }
      if (capture.excerpt) {
        return;
      }
      const adapterLabel = runtime.snapshot.adapter === "copilot"
        ? "Copilot"
        : runtime.snapshot.adapter === "cursor"
          ? "Cursor"
          : isClaudeFamilyAdapter(runtime.snapshot.adapter)
            ? getClaudeFamilyAdapterLabel(runtime.snapshot.adapter)
            : "Codex";
      this.updateReplyCaptureState(runtime, "timeout", {
        error: `Timed out waiting for ${adapterLabel} reply to '${prompt}'.`,
      });
      this.updateAutomationState(runtime, "reply_timeout");
      logError(`[cli-session] ${runtime.snapshot.id} ${runtime.replyCapture?.error || "Reply capture timed out."}`);
    }, timeoutMs);
  }

  private refreshReplyCaptureSnapshot(runtime: CliSessionRuntime): void {
    runtime.snapshot.reply_capture_state = runtime.replyCapture?.state;
    runtime.snapshot.reply_capture_excerpt = runtime.replyCapture?.excerpt;
    runtime.snapshot.reply_capture_error = runtime.replyCapture?.error;
  }

  private clearReplyCaptureFinalizeTimer(runtime: CliSessionRuntime): void {
    const capture = runtime.replyCapture;
    if (!capture?.finalizeTimer) {
      return;
    }
    clearTimeout(capture.finalizeTimer);
    capture.finalizeTimer = null;
  }

  private updateReplyCaptureState(
    runtime: CliSessionRuntime,
    nextState: CliSessionReplyCaptureState,
    options?: { excerpt?: string; error?: string; clearTimer?: boolean },
  ): void {
    const capture = runtime.replyCapture;
    if (!capture) {
      return;
    }
    const nextExcerpt = options?.excerpt ?? capture.excerpt;
    const nextError =
      options?.error !== undefined
        ? options.error
        : nextState === "error" || nextState === "timeout"
          ? capture.error
          : undefined;
    const changed =
      capture.state !== nextState
      || capture.excerpt !== nextExcerpt
      || capture.error !== nextError;
    capture.state = nextState;
    capture.excerpt = nextExcerpt;
    capture.error = nextError;
    if (options?.clearTimer) {
      if (capture.timeoutTimer) {
        clearTimeout(capture.timeoutTimer);
        capture.timeoutTimer = null;
      }
      this.clearReplyCaptureFinalizeTimer(runtime);
    }
    if (!changed) {
      return;
    }
    runtime.snapshot.updated_at = nowIso();
    this.refreshReplyCaptureSnapshot(runtime);
    this.emitSessionEvent("cli.session.state", runtime);
  }

  private updateReplyCaptureFromOutput(runtime: CliSessionRuntime): void {
    const capture = runtime.replyCapture;
    if (!capture) {
      return;
    }

    // Use adapter-specific extraction
    const excerpt = (
      runtime.snapshot.adapter === "cursor"
      || isClaudeFamilyAdapter(runtime.snapshot.adapter)
    )
      ? extractClaudeReplyFromTranscript(capture.rawOutput, capture.prompt)
      : runtime.snapshot.adapter === "copilot"
        ? extractCopilotReplyFromTranscript(capture.rawOutput, capture.prompt)
        : extractCodexReplyFromTranscript(capture.rawOutput, capture.prompt);

    if (!excerpt) {
      return;
    }
    if (areEquivalentReplyExcerpts(excerpt, capture.baselineExcerpt)) {
      return;
    }
    const latestScreen = runtime.screenState?.latest;
    if (
      runtime.snapshot.adapter === "copilot"
      && latestScreen
      && looksLikeCopilotReplyIdleScreen(latestScreen)
    ) {
      this.updateReplyCaptureState(runtime, "streaming", { excerpt });
      this.finalizeReplyCaptureIfIdle(runtime, latestScreen);
      return;
    }
    if (
      (runtime.snapshot.adapter === "cursor" || isClaudeFamilyAdapter(runtime.snapshot.adapter))
      && latestScreen
      && looksLikeClaudeReplyIdleScreen(latestScreen)
    ) {
      this.updateReplyCaptureState(runtime, "streaming", { excerpt });
      this.finalizeReplyCaptureIfIdle(runtime, latestScreen);
      return;
    }
    if (
      runtime.snapshot.adapter === "codex"
      && latestScreen
      && looksLikeCodexReplyIdleScreen(latestScreen)
    ) {
      this.updateReplyCaptureState(runtime, "completed", {
        excerpt: stripTrailingPlaceholderLine(excerpt, latestScreen) || excerpt,
        clearTimer: true,
      });
      if (runtime.snapshot.mode === "interactive") {
        this.updateAutomationState(runtime, "waiting_for_codex_prompt");
      }
      return;
    }
    const nextState = "streaming";
    this.updateReplyCaptureState(runtime, nextState, { excerpt });
  }

  private finalizeReplyCaptureIfIdle(runtime: CliSessionRuntime, screen: CliSessionScreenSnapshot): void {
    const capture = runtime.replyCapture;
    if (!capture) {
      return;
    }
    if (runtime.snapshot.adapter === "copilot" && runtime.snapshot.mode === "interactive") {
      if (!looksLikeCopilotReplyIdleScreen(screen)) {
        this.clearReplyCaptureFinalizeTimer(runtime);
        return;
      }
      const automation = runtime.automationState;
      if (automation?.profile === "codex-startup") {
        const hasStableReplySignal = automation.sawWorkingScreen || Boolean(capture.excerpt);
        if (!hasStableReplySignal) {
          return;
        }
      }
      const finalExcerpt = String(capture.excerpt || extractCopilotReplyFromScreen(screen) || "").trim();
      if (!finalExcerpt) {
        return;
      }
      if (areEquivalentReplyExcerpts(finalExcerpt, capture.baselineExcerpt)) {
        return;
      }
      this.clearReplyCaptureFinalizeTimer(runtime);
      capture.finalizeTimer = setTimeout(() => {
        if (runtime.replyCapture !== capture) {
          return;
        }
        capture.finalizeTimer = null;
        const latestScreen = runtime.screenState?.latest || screen;
        if (!looksLikeCopilotReplyIdleScreen(latestScreen)) {
          return;
        }
        const latestExcerpt = String(
          runtime.replyCapture?.excerpt
          || extractCopilotReplyFromScreen(latestScreen)
          || "",
        ).trim();
        if (!latestExcerpt) {
          return;
        }
        if (areEquivalentReplyExcerpts(latestExcerpt, capture.baselineExcerpt)) {
          return;
        }
        this.updateReplyCaptureState(runtime, "completed", {
          excerpt: latestExcerpt,
          clearTimer: true,
        });
        this.updateAutomationState(runtime, "waiting_for_copilot_ready");
      }, CLI_REPLY_FINALIZE_DEBOUNCE_MS);
      return;
    }
    if (
      (runtime.snapshot.adapter === "cursor" || isClaudeFamilyAdapter(runtime.snapshot.adapter))
      && runtime.snapshot.mode === "interactive"
    ) {
      if (!looksLikeClaudeReplyIdleScreen(screen)) {
        this.clearReplyCaptureFinalizeTimer(runtime);
        return;
      }
      const automation = runtime.automationState;
      if (automation?.profile === "codex-startup") {
        const hasStableReplySignal = automation.sawWorkingScreen || Boolean(capture.excerpt);
        if (!hasStableReplySignal) {
          return;
        }
      }
      const finalExcerpt = String(capture.excerpt || "").trim();
      if (!finalExcerpt) {
        return;
      }
      if (areEquivalentReplyExcerpts(finalExcerpt, capture.baselineExcerpt)) {
        return;
      }
      this.clearReplyCaptureFinalizeTimer(runtime);
      capture.finalizeTimer = setTimeout(() => {
        if (runtime.replyCapture !== capture) {
          return;
        }
        capture.finalizeTimer = null;
        const latestScreen = runtime.screenState?.latest || screen;
        if (!looksLikeClaudeReplyIdleScreen(latestScreen)) {
          return;
        }
        const latestExcerpt = String(runtime.replyCapture?.excerpt || "").trim();
        if (!latestExcerpt) {
          return;
        }
        if (areEquivalentReplyExcerpts(latestExcerpt, capture.baselineExcerpt)) {
          return;
        }
        this.updateReplyCaptureState(runtime, "completed", {
          excerpt: latestExcerpt,
          clearTimer: true,
        });
        if (runtime.snapshot.adapter === "cursor") {
          this.updateAutomationState(runtime, "waiting_for_cursor_ready");
        } else {
          this.updateAutomationState(
            runtime,
            `waiting_for_${getClaudeFamilyStatePrefix(runtime.snapshot.adapter)}_ready`,
          );
        }
      }, CLI_REPLY_FINALIZE_DEBOUNCE_MS);
      return;
    }
    if (!looksLikeCodexReplyIdleScreen(screen)) {
      this.clearReplyCaptureFinalizeTimer(runtime);
      return;
    }
    const automation = runtime.automationState;
    if (automation?.profile === "codex-startup") {
      if (!automation.initialPromptEnterSent) {
        return;
      }
      const hasStableReplySignal = automation.sawWorkingScreen || Boolean(capture.excerpt);
      if (!hasStableReplySignal) {
        return;
      }
    }
    const screenExcerpt = extractCodexReplyFromScreen(screen, capture.prompt);
    const finalExcerpt = stripTrailingPlaceholderLine(screenExcerpt || capture.excerpt, screen);
    if (!finalExcerpt) {
      return;
    }
    if (areEquivalentReplyExcerpts(finalExcerpt, capture.baselineExcerpt)) {
      return;
    }
    this.clearReplyCaptureFinalizeTimer(runtime);
    capture.finalizeTimer = setTimeout(() => {
      if (runtime.replyCapture !== capture) {
        return;
      }
      capture.finalizeTimer = null;
      const latestScreen = runtime.screenState?.latest || screen;
      if (!looksLikeCodexReplyIdleScreen(latestScreen)) {
        return;
      }
      const latestExcerpt = stripTrailingPlaceholderLine(
        extractCodexReplyFromScreen(latestScreen, capture.prompt) || capture.excerpt,
        latestScreen,
      );
      if (!latestExcerpt) {
        return;
      }
      if (areEquivalentReplyExcerpts(latestExcerpt, capture.baselineExcerpt)) {
        return;
      }
      this.updateReplyCaptureState(runtime, "completed", {
        excerpt: latestExcerpt,
        clearTimer: true,
      });
      if (runtime.snapshot.adapter === "codex" && runtime.snapshot.mode === "interactive") {
        this.updateAutomationState(runtime, "waiting_for_codex_prompt");
      }
    }, CLI_REPLY_FINALIZE_DEBOUNCE_MS);
  }

  private scheduleCodexPromptSubmit(runtime: CliSessionRuntime, delayMs: number): void {
    const automation = runtime.automationState;
    if (!automation || automation.profile !== "codex-startup") {
      return;
    }
    if (automation.submitTimer) {
      clearTimeout(automation.submitTimer);
    }
    automation.submitTimer = setTimeout(() => {
      automation.submitTimer = null;
      const latestScreen = runtime.screenState?.latest;
      const initialPrompt = String(runtime.snapshot.prompt || "").trim();
      if (!initialPrompt || automation.manualOverride || !runtime.controls?.write) {
        return;
      }
      if (!automation.initialPromptEnterSent) {
        automation.initialPromptEnterSent = true;
        runtime.controls.write("\r");
        this.updateAutomationState(runtime, "sent_initial_prompt_enter");
        this.scheduleCodexPromptSubmit(runtime, 1000);
        logInfo(`[cli-session] ${runtime.snapshot.id} auto-submitted initial Codex prompt.`);
        return;
      }
      if (!latestScreen) {
        return;
      }
      if (
        !automation.initialPromptEnterRetried
        && !automation.sawWorkingScreen
        && !runtime.replyCapture?.excerpt
        && looksLikeCodexIdlePrompt(latestScreen)
        && (
          isCodexPromptShowingText(latestScreen, initialPrompt)
          || looksLikeCodexPromptLine(latestScreen.text)
        )
      ) {
        automation.initialPromptEnterRetried = true;
        runtime.controls.write("\r");
        this.updateAutomationState(runtime, "resent_initial_prompt_enter");
        logInfo(`[cli-session] ${runtime.snapshot.id} retried Enter for Codex prompt submission.`);
      }
    }, delayMs);
  }

  private scheduleCodexInitialPrompt(runtime: CliSessionRuntime, delayMs: number): void {
    const automation = runtime.automationState;
    if (!automation || automation.profile !== "codex-startup") {
      return;
    }
    if (runtime.snapshot.adapter !== "codex" || runtime.snapshot.mode !== "interactive") {
      return;
    }
    if (automation.submitTimer) {
      clearTimeout(automation.submitTimer);
    }
    automation.initialPromptTextScheduled = true;
    automation.submitTimer = setTimeout(() => {
      automation.submitTimer = null;
      if (runtime.snapshot.adapter !== "codex" || runtime.snapshot.mode !== "interactive") {
        return;
      }
      const latestScreen = runtime.screenState?.latest;
      const initialPrompt = String(runtime.snapshot.prompt || "").trim();
      const normalizedScreen = latestScreen?.normalizedText || "";
      const canSendPrompt = automation.sawReadyScreen
        || (
          automation.continueSent
          && Boolean(normalizedScreen)
          && !looksLikeCodexContinuePrompt(normalizedScreen)
        );
      if (
        !initialPrompt
        || automation.manualOverride
        || !runtime.controls?.write
        || automation.initialPromptTextSent
        || !canSendPrompt
      ) {
        automation.initialPromptTextScheduled = false;
        return;
      }
      automation.initialPromptTextScheduled = false;
      automation.initialPromptTextSent = true;
      this.startReplyCapture(runtime, initialPrompt);
      runtime.controls.write(initialPrompt);
      this.updateAutomationState(runtime, "sent_initial_prompt_text");
      this.scheduleCodexPromptSubmit(runtime, CODEX_INITIAL_PROMPT_ENTER_DELAY_MS);
      logInfo(
        `[cli-session] ${runtime.snapshot.id} auto-typed initial Codex prompt after ready settle delay.`,
      );
    }, delayMs);
  }

  private scheduleCodexDeliveryEnter(
    runtime: CliSessionRuntime,
    delayMs: number,
    nextState?: string,
  ): void {
    const automation = runtime.automationState;
    if (!automation || automation.profile !== "codex-startup") {
      return;
    }
    if (runtime.snapshot.adapter !== "codex" || runtime.snapshot.mode !== "interactive") {
      return;
    }
    if (automation.submitTimer) {
      clearTimeout(automation.submitTimer);
    }
    automation.submitTimer = setTimeout(() => {
      automation.submitTimer = null;
      if (runtime.snapshot.adapter !== "codex" || runtime.snapshot.mode !== "interactive") {
        return;
      }
      if (automation.manualOverride || !runtime.controls?.write) {
        return;
      }
      if (String(automation.wakePromptText || "").trim()) {
        automation.wakePromptEnterSent = true;
      }
      runtime.controls.write("\r");
      if (nextState) {
        this.updateAutomationState(runtime, nextState);
      }
      logInfo(
        `[cli-session] ${runtime.snapshot.id} auto-submitted Codex meeting prompt after delayed Enter.`,
      );
    }, delayMs);
  }

  private scheduleClaudeStartupEnter(runtime: CliSessionRuntime, delayMs: number): void {
    const automation = runtime.automationState;
    if (!automation || automation.profile !== "codex-startup") {
      return;
    }
    if (!isClaudeFamilyAdapter(runtime.snapshot.adapter) || runtime.snapshot.mode !== "interactive") {
      return;
    }
    if (automation.submitTimer) {
      clearTimeout(automation.submitTimer);
    }
    automation.submitTimer = setTimeout(() => {
      automation.submitTimer = null;
      if (!isClaudeFamilyAdapter(runtime.snapshot.adapter) || runtime.snapshot.mode !== "interactive") {
        return;
      }
      if (automation.manualOverride || !runtime.controls?.write || automation.continueSent) {
        return;
      }
      automation.continueSent = true;
      runtime.controls.write("\r");
      const statePrefix = getClaudeFamilyStatePrefix(runtime.snapshot.adapter);
      const adapterLabel = getClaudeFamilyAdapterLabel(runtime.snapshot.adapter);
      this.updateAutomationState(runtime, `sent_${statePrefix}_startup_enter`);
      logInfo(`[cli-session] ${runtime.snapshot.id} auto-sent Enter for ${adapterLabel} startup prompt.`);
    }, delayMs);
  }

  private scheduleClaudePastedTextEnter(
    runtime: CliSessionRuntime,
    nextState: string,
    delayMs: number,
  ): void {
    const automation = runtime.automationState;
    if (!automation || automation.profile !== "codex-startup") {
      return;
    }
    if (!isClaudeFamilyAdapter(runtime.snapshot.adapter) || runtime.snapshot.mode !== "interactive") {
      return;
    }
    if (automation.submitTimer) {
      clearTimeout(automation.submitTimer);
    }
    automation.submitTimer = setTimeout(() => {
      automation.submitTimer = null;
      if (!isClaudeFamilyAdapter(runtime.snapshot.adapter) || runtime.snapshot.mode !== "interactive") {
        return;
      }
      if (automation.manualOverride || !runtime.controls?.write) {
        return;
      }
      runtime.controls.write("\r");
      const adapterLabel = getClaudeFamilyAdapterLabel(runtime.snapshot.adapter);
      this.updateAutomationState(runtime, nextState);
      logInfo(`[cli-session] ${runtime.snapshot.id} auto-submitted ${adapterLabel} prompt after delayed Enter.`);
    }, delayMs);
  }

  private scheduleClaudeInitialPrompt(
    runtime: CliSessionRuntime,
    prompt: string,
    delayMs: number,
  ): void {
    const automation = runtime.automationState;
    if (!automation || automation.profile !== "codex-startup") {
      return;
    }
    if (!isClaudeFamilyAdapter(runtime.snapshot.adapter) || runtime.snapshot.mode !== "interactive") {
      return;
    }
    if (automation.submitTimer) {
      clearTimeout(automation.submitTimer);
    }
    automation.initialPromptTextScheduled = true;
    automation.submitTimer = setTimeout(() => {
      automation.submitTimer = null;
      if (!isClaudeFamilyAdapter(runtime.snapshot.adapter) || runtime.snapshot.mode !== "interactive") {
        return;
      }
      const screenText = String(runtime.screenState?.latest?.text || runtime.snapshot.screen_excerpt || "");
      if (
        automation.manualOverride
        || !runtime.controls?.write
        || automation.initialPromptTextSent
        || !prompt
        || !automation.sawReadyScreen
      ) {
        automation.initialPromptTextScheduled = false;
        return;
      }
      automation.initialPromptTextScheduled = false;
      automation.initialPromptTextSent = true;
      automation.initialPromptEnterSent = true;
      this.startReplyCapture(runtime, prompt);
      runtime.controls.write(prompt);
      const statePrefix = getClaudeFamilyStatePrefix(runtime.snapshot.adapter);
      const adapterLabel = getClaudeFamilyAdapterLabel(runtime.snapshot.adapter);
      if (looksLikeClaudePastedTextPrompt(screenText)) {
        this.scheduleClaudePastedTextEnter(
          runtime,
          `sent_${statePrefix}_initial_prompt`,
          CLAUDE_INITIAL_PROMPT_ENTER_DELAY_MS,
        );
        this.updateAutomationState(runtime, `waiting_for_${statePrefix}_paste_submit`);
        logInfo(
          `[cli-session] ${runtime.snapshot.id} detected ${adapterLabel} pasted text UI for initial prompt after ready settle delay.`,
        );
      } else {
        this.scheduleClaudePastedTextEnter(
          runtime,
          `sent_${statePrefix}_initial_prompt`,
          CLAUDE_INITIAL_PROMPT_ENTER_DELAY_MS,
        );
        this.updateAutomationState(runtime, `waiting_for_${statePrefix}_initial_submit`);
        logInfo(
          `[cli-session] ${runtime.snapshot.id} scheduled delayed Enter for initial ${adapterLabel} prompt after ready settle delay.`,
        );
      }
    }, delayMs);
  }

  private scheduleCursorStartupEnter(runtime: CliSessionRuntime, delayMs: number): void {
    const automation = runtime.automationState;
    if (!automation || automation.profile !== "codex-startup") {
      return;
    }
    if (runtime.snapshot.adapter !== "cursor" || runtime.snapshot.mode !== "interactive") {
      return;
    }
    if (automation.submitTimer) {
      clearTimeout(automation.submitTimer);
    }
    automation.submitTimer = setTimeout(() => {
      automation.submitTimer = null;
      if (runtime.snapshot.adapter !== "cursor" || runtime.snapshot.mode !== "interactive") {
        return;
      }
      if (automation.manualOverride || !runtime.controls?.write || automation.continueSent) {
        return;
      }
      automation.continueSent = true;
      runtime.controls.write("\r");
      this.updateAutomationState(runtime, "sent_cursor_startup_enter");
      logInfo(`[cli-session] ${runtime.snapshot.id} auto-sent Enter for Cursor startup prompt.`);
    }, delayMs);
  }

  private scheduleCursorDelayedEnter(
    runtime: CliSessionRuntime,
    nextState: string,
    delayMs: number,
  ): void {
    const automation = runtime.automationState;
    if (!automation || automation.profile !== "codex-startup") {
      return;
    }
    if (runtime.snapshot.adapter !== "cursor" || runtime.snapshot.mode !== "interactive") {
      return;
    }
    if (automation.submitTimer) {
      clearTimeout(automation.submitTimer);
    }
    automation.submitTimer = setTimeout(() => {
      automation.submitTimer = null;
      if (runtime.snapshot.adapter !== "cursor" || runtime.snapshot.mode !== "interactive") {
        return;
      }
      if (automation.manualOverride || !runtime.controls?.write) {
        return;
      }
      runtime.controls.write("\r");
      this.updateAutomationState(runtime, nextState);
      logInfo(`[cli-session] ${runtime.snapshot.id} auto-submitted Cursor prompt after delayed Enter.`);
    }, delayMs);
  }

  private scheduleCursorInitialPrompt(
    runtime: CliSessionRuntime,
    prompt: string,
    delayMs: number,
  ): void {
    const automation = runtime.automationState;
    if (!automation || automation.profile !== "codex-startup") {
      return;
    }
    if (runtime.snapshot.adapter !== "cursor" || runtime.snapshot.mode !== "interactive") {
      return;
    }
    if (automation.submitTimer) {
      clearTimeout(automation.submitTimer);
    }
    automation.initialPromptTextScheduled = true;
    automation.submitTimer = setTimeout(() => {
      automation.submitTimer = null;
      if (runtime.snapshot.adapter !== "cursor" || runtime.snapshot.mode !== "interactive") {
        return;
      }
      const screenText = String(runtime.screenState?.latest?.text || runtime.snapshot.screen_excerpt || "");
      if (
        automation.manualOverride
        || !runtime.controls?.write
        || automation.initialPromptTextSent
        || !prompt
        || !automation.sawReadyScreen
      ) {
        automation.initialPromptTextScheduled = false;
        return;
      }
      automation.initialPromptTextScheduled = false;
      automation.initialPromptTextSent = true;
      automation.initialPromptEnterSent = true;
      this.startReplyCapture(runtime, prompt);
      runtime.controls.write(prompt);
      if (looksLikeCursorPastedTextPrompt(screenText)) {
        this.scheduleCursorDelayedEnter(runtime, "sent_cursor_initial_prompt", 1000);
        this.updateAutomationState(runtime, "waiting_for_cursor_paste_submit");
        logInfo(
          `[cli-session] ${runtime.snapshot.id} detected Cursor pasted text UI for initial prompt after ready settle delay.`,
        );
      } else {
        this.scheduleCursorDelayedEnter(runtime, "sent_cursor_initial_prompt", 1000);
        this.updateAutomationState(runtime, "waiting_for_cursor_initial_submit");
        logInfo(
          `[cli-session] ${runtime.snapshot.id} scheduled delayed Enter for initial Cursor prompt after ready settle delay.`,
        );
      }
    }, delayMs);
  }

  private scheduleCopilotDelayedEnter(
    runtime: CliSessionRuntime,
    nextState: string,
    delayMs: number,
  ): void {
    const automation = runtime.automationState;
    if (!automation || automation.profile !== "codex-startup") {
      return;
    }
    if (runtime.snapshot.adapter !== "copilot" || runtime.snapshot.mode !== "interactive") {
      return;
    }
    if (automation.submitTimer) {
      clearTimeout(automation.submitTimer);
    }
    automation.submitTimer = setTimeout(() => {
      automation.submitTimer = null;
      if (runtime.snapshot.adapter !== "copilot" || runtime.snapshot.mode !== "interactive") {
        return;
      }
      if (automation.manualOverride || !runtime.controls?.write) {
        return;
      }
      if (String(automation.wakePromptText || "").trim()) {
        automation.wakePromptEnterSent = true;
      }
      runtime.controls.write("\r");
      this.updateAutomationState(runtime, nextState);
      logInfo(`[cli-session] ${runtime.snapshot.id} auto-submitted Copilot prompt after delayed Enter.`);
    }, delayMs);
  }

  private clearCopilotToolApprovalRetry(runtime: CliSessionRuntime): void {
    const automation = runtime.automationState;
    if (!automation?.toolApprovalRetryTimer) {
      return;
    }
    clearTimeout(automation.toolApprovalRetryTimer);
    automation.toolApprovalRetryTimer = null;
  }

  private setInteractiveWorkHint(
    runtime: CliSessionRuntime,
    state: CliSessionSnapshot["interactive_work_state"],
    reason?: string,
  ): void {
    if (
      runtime.snapshot.interactive_work_state === state
      && runtime.snapshot.interactive_work_reason === reason
    ) {
      return;
    }
    runtime.snapshot.interactive_work_state = state;
    runtime.snapshot.interactive_work_reason = reason;
    runtime.snapshot.updated_at = nowIso();
    this.emitSessionEvent("cli.session.state", runtime);
  }

  private clearInteractiveWorkHint(runtime: CliSessionRuntime, reason?: string): void {
    if (reason && runtime.snapshot.interactive_work_reason !== reason) {
      return;
    }
    if (
      runtime.snapshot.interactive_work_state === undefined
      && runtime.snapshot.interactive_work_reason === undefined
    ) {
      return;
    }
    runtime.snapshot.interactive_work_state = undefined;
    runtime.snapshot.interactive_work_reason = undefined;
    runtime.snapshot.updated_at = nowIso();
    this.emitSessionEvent("cli.session.state", runtime);
  }

  private clearCopilotActivitySettleTimer(runtime: CliSessionRuntime): void {
    const automation = runtime.automationState;
    if (!automation?.activitySettleTimer) {
      return;
    }
    clearTimeout(automation.activitySettleTimer);
    automation.activitySettleTimer = null;
  }

  private scheduleCopilotActivitySettleCheck(
    runtime: CliSessionRuntime,
    expectedMarker: string,
    delayMs: number,
  ): void {
    const automation = runtime.automationState;
    if (!automation || runtime.snapshot.adapter !== "copilot" || runtime.snapshot.mode !== "interactive") {
      return;
    }
    this.clearCopilotActivitySettleTimer(runtime);
    automation.activitySettleTimer = setTimeout(() => {
      automation.activitySettleTimer = null;
      if (runtime.snapshot.adapter !== "copilot" || runtime.snapshot.mode !== "interactive") {
        return;
      }
      if (automation.lastCopilotActivityMarker !== expectedMarker) {
        return;
      }
      const changedAt = Number(automation.lastCopilotActivityChangedAt || 0);
      if (!changedAt) {
        return;
      }
      if (Date.now() - changedAt < COPILOT_ACTIVITY_SETTLE_MS) {
        this.scheduleCopilotActivitySettleCheck(
          runtime,
          expectedMarker,
          COPILOT_ACTIVITY_SETTLE_MS - Math.max(0, Date.now() - changedAt),
        );
        return;
      }
      this.clearInteractiveWorkHint(runtime, "copilot_activity_spinner");
    }, Math.max(1, delayMs));
  }

  private refreshCopilotActivityState(runtime: CliSessionRuntime, screen: CliSessionScreenSnapshot): boolean {
    const automation = runtime.automationState;
    if (!automation || runtime.snapshot.adapter !== "copilot" || runtime.snapshot.mode !== "interactive") {
      return false;
    }

    const marker = extractCopilotActivityMarker(screen.text);
    if (!marker) {
      automation.lastCopilotActivityMarker = undefined;
      automation.lastCopilotActivityChangedAt = undefined;
      this.clearCopilotActivitySettleTimer(runtime);
      this.clearInteractiveWorkHint(runtime, "copilot_activity_spinner");
      return false;
    }

    const now = Date.now();
    const markerChanged = automation.lastCopilotActivityMarker !== marker;
    if (markerChanged) {
      automation.lastCopilotActivityMarker = marker;
      automation.lastCopilotActivityChangedAt = now;
      this.setInteractiveWorkHint(runtime, "busy", "copilot_activity_spinner");
      this.scheduleCopilotActivitySettleCheck(runtime, marker, COPILOT_ACTIVITY_SETTLE_MS);
      return true;
    }

    const changedAt = Number(automation.lastCopilotActivityChangedAt || 0);
    if (!changedAt || now - changedAt < COPILOT_ACTIVITY_SETTLE_MS) {
      this.setInteractiveWorkHint(runtime, "busy", "copilot_activity_spinner");
      if (!automation.activitySettleTimer) {
        this.scheduleCopilotActivitySettleCheck(
          runtime,
          marker,
          COPILOT_ACTIVITY_SETTLE_MS - Math.max(0, now - changedAt),
        );
      }
      return true;
    }

    this.clearInteractiveWorkHint(runtime, "copilot_activity_spinner");
    return false;
  }

  private scheduleCopilotToolApprovalRetry(
    runtime: CliSessionRuntime,
    approvalKey: string,
    delayMs: number,
  ): void {
    const automation = runtime.automationState;
    if (!automation || automation.profile !== "codex-startup") {
      return;
    }
    if (runtime.snapshot.adapter !== "copilot" || runtime.snapshot.mode !== "interactive") {
      return;
    }
    if (automation.toolApprovalRetryTimer) {
      clearTimeout(automation.toolApprovalRetryTimer);
    }
    automation.toolApprovalRetryTimer = setTimeout(() => {
      automation.toolApprovalRetryTimer = null;
      if (runtime.snapshot.adapter !== "copilot" || runtime.snapshot.mode !== "interactive") {
        return;
      }
      if (automation.manualOverride || !runtime.controls?.write) {
        return;
      }
      const latestText = String(runtime.screenState?.latest?.text || runtime.snapshot.screen_excerpt || "");
      if (!looksLikeCopilotToolApprovalPrompt(latestText)) {
        return;
      }
      const latestKey =
        extractCopilotToolApprovalKey(latestText)
        || normalizeScreenMatchText(latestText).slice(0, 160);
      if (latestKey !== approvalKey) {
        return;
      }
      automation.lastCopilotToolApprovalAt = Date.now();
      automation.lastCopilotToolApprovalKey = latestKey;
      runtime.controls.write("\r");
      this.updateAutomationState(runtime, "resent_copilot_tool_approval_enter");
      logInfo(`[cli-session] ${runtime.snapshot.id} retried Copilot tool approval prompt with Enter.`);
    }, delayMs);
  }

  private scheduleCopilotInitialPrompt(
    runtime: CliSessionRuntime,
    prompt: string,
    delayMs: number,
  ): void {
    const automation = runtime.automationState;
    if (!automation || automation.profile !== "codex-startup") {
      return;
    }
    if (runtime.snapshot.adapter !== "copilot" || runtime.snapshot.mode !== "interactive") {
      return;
    }
    if (automation.submitTimer) {
      clearTimeout(automation.submitTimer);
    }
    automation.submitTimer = setTimeout(() => {
      automation.submitTimer = null;
      if (runtime.snapshot.adapter !== "copilot" || runtime.snapshot.mode !== "interactive") {
        return;
      }
      if (automation.manualOverride || !runtime.controls?.write || automation.initialPromptTextSent) {
        return;
      }
      automation.initialPromptTextSent = true;
      automation.initialPromptEnterSent = true;
      this.startReplyCapture(runtime, prompt);
      runtime.controls.write(prompt);
      this.scheduleCopilotDelayedEnter(runtime, "sent_copilot_initial_prompt", 1000);
      this.updateAutomationState(runtime, "waiting_for_copilot_initial_submit");
      logInfo(`[cli-session] ${runtime.snapshot.id} scheduled staged initial Copilot prompt.`);
    }, delayMs);
  }

  private runClaudeAutomation(runtime: CliSessionRuntime, screen: CliSessionScreenSnapshot): void {
    const automation = runtime.automationState;
    if (!automation || !runtime.controls?.write) {
      return;
    }
    if (!isClaudeFamilyAdapter(runtime.snapshot.adapter) || runtime.snapshot.mode !== "interactive") {
      return;
    }
    if (automation.manualOverride) {
      return;
    }

    const screenText = screen.text || "";
    const initialPrompt = String(runtime.snapshot.prompt || "").trim();
    const statePrefix = getClaudeFamilyStatePrefix(runtime.snapshot.adapter);
    const adapterLabel = getClaudeFamilyAdapterLabel(runtime.snapshot.adapter);

    if (looksLikeClaudeWorkingScreen(screenText)) {
      automation.sawWorkingScreen = true;
      automation.deliveryPromptEnterRetried = false;
      automation.wakePromptText = undefined;
      automation.wakePromptEnterSent = false;
      automation.wakePromptEnterRetried = false;
      automation.copilotAskUserCorrectionSent = false;
      if (automation.submitTimer) {
        clearTimeout(automation.submitTimer);
        automation.submitTimer = null;
      }
      if (runtime.replyCapture && runtime.replyCapture.state !== "completed") {
        this.updateReplyCaptureState(runtime, "working", {
          excerpt: runtime.replyCapture.excerpt,
        });
      }
      this.updateAutomationState(runtime, `${statePrefix}_working`);
      return;
    }

    if (looksLikeClaudeProceedPrompt(screenText)) {
      runtime.controls.write("\r");
      this.updateAutomationState(runtime, `sent_${statePrefix}_proceed_enter`);
      logInfo(`[cli-session] ${runtime.snapshot.id} auto-confirmed ${adapterLabel} tool prompt.`);
      return;
    }

    if (!initialPrompt) {
      return;
    }

    if (looksLikeClaudeIdleScreen(screenText) || (automation.continueSent && looksLikeClaudeUsableScreen(screen))) {
      automation.sawReadyScreen = true;
    }

    if (!automation.sawReadyScreen) {
      return;
    }

    if (!automation.initialPromptTextSent) {
      if (!automation.initialPromptTextScheduled) {
        this.scheduleClaudeInitialPrompt(runtime, initialPrompt, CODEX_READY_SETTLE_DELAY_MS);
        this.updateAutomationState(runtime, `waiting_for_${statePrefix}_ready_settle`);
        logInfo(
          `[cli-session] ${runtime.snapshot.id} waiting for ${adapterLabel} ready screen to settle before sending initial prompt.`,
        );
      }
      return;
    }

    if (
      automation.initialPromptTextSent
      && !automation.initialPromptEnterRetried
      && !automation.sawWorkingScreen
      && !runtime.replyCapture?.excerpt
      && isClaudePromptShowingText(screenText, initialPrompt)
    ) {
      automation.initialPromptEnterRetried = true;
      this.scheduleClaudePastedTextEnter(
        runtime,
        `resent_${statePrefix}_initial_paste_enter`,
        CLAUDE_INITIAL_PROMPT_ENTER_DELAY_MS,
      );
      this.updateAutomationState(runtime, `waiting_for_${statePrefix}_initial_retry_submit`);
      logInfo(`[cli-session] ${runtime.snapshot.id} retried delayed Enter for initial ${adapterLabel} prompt.`);
      return;
    }

    if (
      runtime.snapshot.automation_state === "meeting_wake_prompt_sent"
      && automation.wakePromptText
      && !automation.wakePromptEnterRetried
      && isCopilotPromptShowingText(screenText, automation.wakePromptText)
    ) {
      automation.wakePromptEnterRetried = true;
      automation.wakePromptEnterSent = true;
      this.scheduleCopilotDelayedEnter(runtime, "meeting_wake_prompt_resent_enter", 1000);
      this.updateAutomationState(runtime, "waiting_for_copilot_wake_submit");
      logInfo(`[cli-session] ${runtime.snapshot.id} retried delayed Enter for Copilot wake prompt.`);
      return;
    }

    if (
      runtime.snapshot.automation_state === "meeting_delivery_prompt_sent"
      && !automation.deliveryPromptEnterRetried
      && runtime.replyCapture
      && !runtime.replyCapture.excerpt
      && isClaudePromptShowingText(screenText, initialPrompt)
    ) {
      automation.deliveryPromptEnterRetried = true;
      if (looksLikeClaudePastedTextPrompt(screenText)) {
        this.scheduleClaudePastedTextEnter(runtime, `resent_${statePrefix}_delivery_enter`, 1000);
        this.updateAutomationState(runtime, `waiting_for_${statePrefix}_delivery_paste_submit`);
        logInfo(`[cli-session] ${runtime.snapshot.id} detected ${adapterLabel} pasted text UI for meeting prompt delivery.`);
      } else if (looksLikeClaudeUsableScreen(screen)) {
        this.scheduleClaudePastedTextEnter(runtime, `resent_${statePrefix}_delivery_enter`, 1000);
        this.updateAutomationState(runtime, `waiting_for_${statePrefix}_delivery_submit`);
        logInfo(`[cli-session] ${runtime.snapshot.id} scheduled delayed Enter for ${adapterLabel} meeting prompt delivery.`);
      }
    }

    this.finalizeReplyCaptureIfIdle(runtime, screen);
  }

  private runCursorAutomation(runtime: CliSessionRuntime, screen: CliSessionScreenSnapshot): void {
    const automation = runtime.automationState;
    if (!automation || !runtime.controls?.write) {
      return;
    }
    if (automation.manualOverride) {
      return;
    }

    const screenText = screen.text || "";
    const initialPrompt = String(runtime.snapshot.prompt || "").trim();

    if (looksLikeCursorWorkingScreen(screenText)) {
      automation.sawWorkingScreen = true;
      if (runtime.replyCapture && runtime.replyCapture.state !== "completed") {
        this.updateReplyCaptureState(runtime, "working", {
          excerpt: runtime.replyCapture.excerpt,
        });
      }
      this.updateAutomationState(runtime, "cursor_working");
      return;
    }

    if (looksLikeCursorProceedPrompt(screenText)) {
      runtime.controls.write("\r");
      this.updateAutomationState(runtime, "sent_cursor_proceed_enter");
      logInfo(`[cli-session] ${runtime.snapshot.id} auto-confirmed Cursor tool prompt.`);
      return;
    }

    if (!initialPrompt) {
      return;
    }

    if (looksLikeCursorIdleScreen(screenText) || (automation.continueSent && looksLikeCursorUsableScreen(screen))) {
      automation.sawReadyScreen = true;
    }

    if (!automation.sawReadyScreen) {
      return;
    }

    if (!automation.initialPromptTextSent) {
      if (!automation.initialPromptTextScheduled) {
        this.scheduleCursorInitialPrompt(runtime, initialPrompt, CODEX_READY_SETTLE_DELAY_MS);
        this.updateAutomationState(runtime, "waiting_for_cursor_ready_settle");
        logInfo(
          `[cli-session] ${runtime.snapshot.id} waiting for Cursor ready screen to settle before sending initial prompt.`,
        );
      }
      return;
    }

    if (
      automation.initialPromptTextSent
      && !automation.initialPromptEnterRetried
      && !automation.sawWorkingScreen
      && looksLikeCursorPastedTextPrompt(screenText)
    ) {
      automation.initialPromptEnterRetried = true;
      this.scheduleCursorDelayedEnter(runtime, "resent_cursor_initial_paste_enter", 1000);
      this.updateAutomationState(runtime, "waiting_for_cursor_initial_paste_submit");
      logInfo(`[cli-session] ${runtime.snapshot.id} detected delayed Cursor pasted text UI for initial prompt.`);
      return;
    }

    if (
      runtime.snapshot.automation_state === "meeting_delivery_prompt_sent"
      && !automation.deliveryPromptEnterRetried
      && runtime.replyCapture
      && !runtime.replyCapture.excerpt
      && isCursorPromptShowingText(screenText, initialPrompt)
    ) {
      automation.deliveryPromptEnterRetried = true;
      if (looksLikeCursorPastedTextPrompt(screenText)) {
        this.scheduleCursorDelayedEnter(runtime, "resent_cursor_delivery_enter", 1000);
        this.updateAutomationState(runtime, "waiting_for_cursor_delivery_paste_submit");
        logInfo(`[cli-session] ${runtime.snapshot.id} detected Cursor pasted text UI for meeting prompt delivery.`);
      } else if (looksLikeCursorUsableScreen(screen)) {
        this.scheduleCursorDelayedEnter(runtime, "resent_cursor_delivery_enter", 1000);
        this.updateAutomationState(runtime, "waiting_for_cursor_delivery_submit");
        logInfo(`[cli-session] ${runtime.snapshot.id} scheduled delayed Enter for Cursor meeting prompt delivery.`);
      }
    }
  }

  private runCopilotAutomation(runtime: CliSessionRuntime, screen: CliSessionScreenSnapshot): void {
    const automation = runtime.automationState;
    if (!automation || !runtime.controls?.write) {
      return;
    }
    if (automation.manualOverride) {
      return;
    }

    const screenText = screen.text || "";
    const initialPrompt = String(runtime.snapshot.prompt || "").trim();
    const terminalError = extractCopilotTerminalError(screenText);
    const toolApprovalVisible = looksLikeCopilotToolApprovalPrompt(screenText);
    const activitySpinnerBusy = this.refreshCopilotActivityState(runtime, screen);

    if (terminalError) {
      this.clearInteractiveWorkHint(runtime, "copilot_activity_spinner");
      this.clearCopilotToolApprovalRetry(runtime);
      if (automation.submitTimer) {
        clearTimeout(automation.submitTimer);
        automation.submitTimer = null;
      }
      runtime.snapshot.last_error = `Copilot CLI error: ${terminalError}`;
      runtime.snapshot.updated_at = nowIso();
      if (runtime.replyCapture && runtime.replyCapture.state !== "completed") {
        this.updateReplyCaptureState(runtime, "error", {
          error: `Copilot CLI error: ${terminalError}`,
          clearTimer: true,
        });
      } else {
        this.emitSessionEvent("cli.session.state", runtime);
      }
      this.updateAutomationState(runtime, "copilot_error");
      return;
    }

    if (activitySpinnerBusy) {
      this.clearCopilotToolApprovalRetry(runtime);
      automation.sawWorkingScreen = true;
      automation.deliveryPromptEnterRetried = false;
      automation.wakePromptText = undefined;
      automation.wakePromptEnterSent = false;
      automation.wakePromptEnterRetried = false;
      if (automation.submitTimer) {
        clearTimeout(automation.submitTimer);
        automation.submitTimer = null;
      }
      if (runtime.replyCapture && runtime.replyCapture.state !== "completed") {
        this.updateReplyCaptureState(runtime, "working", {
          excerpt: runtime.replyCapture.excerpt,
        });
      }
      this.updateAutomationState(runtime, "copilot_working");
      return;
    }

    if (looksLikeCopilotWorkingScreen(screenText)) {
      this.clearCopilotToolApprovalRetry(runtime);
      automation.sawWorkingScreen = true;
      automation.deliveryPromptEnterRetried = false;
      automation.wakePromptText = undefined;
      automation.wakePromptEnterSent = false;
      automation.wakePromptEnterRetried = false;
      automation.copilotAskUserCorrectionSent = false;
      if (automation.submitTimer) {
        clearTimeout(automation.submitTimer);
        automation.submitTimer = null;
      }
      if (runtime.replyCapture && runtime.replyCapture.state !== "completed") {
        this.updateReplyCaptureState(runtime, "working", {
          excerpt: runtime.replyCapture.excerpt,
        });
      }
      this.updateAutomationState(runtime, "copilot_working");
      return;
    }

    if (toolApprovalVisible) {
      const now = Date.now();
      const approvalKey =
        extractCopilotToolApprovalKey(screenText)
        || normalizeScreenMatchText(screenText).slice(0, 160);
      const promptChanged = automation.lastCopilotToolApprovalKey !== approvalKey;
      if (
        promptChanged
        || !automation.lastCopilotToolApprovalAt
        || now - automation.lastCopilotToolApprovalAt >= COPILOT_TOOL_APPROVAL_ENTER_COOLDOWN_MS
      ) {
        automation.lastCopilotToolApprovalAt = now;
        automation.lastCopilotToolApprovalKey = approvalKey;
        runtime.controls.write("\r");
        this.scheduleCopilotToolApprovalRetry(runtime, approvalKey, 900);
        logInfo(`[cli-session] ${runtime.snapshot.id} auto-confirmed Copilot tool prompt with Enter.`);
        this.updateAutomationState(runtime, "sent_copilot_tool_approval_enter");
      } else if (!automation.toolApprovalRetryTimer) {
        this.scheduleCopilotToolApprovalRetry(runtime, approvalKey, 900);
      }
      return;
    }

    this.clearCopilotToolApprovalRetry(runtime);

    if (looksLikeCopilotSeqMismatchChoicePrompt(screenText)) {
      const choice = extractCopilotSeqMismatchChoice(screenText);
      if (choice) {
        const now = Date.now();
        const decisionKey = `${choice}::${normalizeScreenMatchText(screenText).slice(0, 200)}`;
        const promptChanged = automation.lastCopilotDecisionKey !== decisionKey;
        if (
          promptChanged
          || !automation.lastCopilotDecisionAt
          || now - automation.lastCopilotDecisionAt >= COPILOT_DECISION_PROMPT_COOLDOWN_MS
        ) {
          automation.lastCopilotDecisionAt = now;
          automation.lastCopilotDecisionKey = decisionKey;
          runtime.controls.write(choice);
          this.scheduleCopilotDelayedEnter(runtime, "sent_copilot_seq_mismatch_choice", 1200);
          this.updateAutomationState(runtime, "waiting_for_copilot_seq_mismatch_choice_submit");
          logInfo(`[cli-session] ${runtime.snapshot.id} auto-resolved Copilot seq-mismatch prompt with '${choice}'.`);
        }
      }
      return;
    }

    if (looksLikeClaudeProceedPrompt(screenText)) {
      runtime.controls.write("\r");
      this.updateAutomationState(runtime, "sent_copilot_proceed_enter");
      logInfo(`[cli-session] ${runtime.snapshot.id} auto-confirmed Copilot tool prompt.`);
      return;
    }

    if (!initialPrompt) {
      return;
    }

    const isResumeRecovery = runtime.snapshot.context_delivery_mode === "resume";

    if (looksLikeCopilotIdleScreen(screenText) || looksLikeCopilotUsableScreen(screen)) {
      automation.sawReadyScreen = true;
    }

    if (!automation.sawReadyScreen) {
      return;
    }

    if (
      looksLikeCopilotForeignToolingLeak(screenText)
      && looksLikeCopilotUsableScreen(screen)
      && !automation.copilotCorrectionSent
    ) {
      automation.copilotCorrectionSent = true;
      const correctionPrompt = isResumeRecovery
        ? [
          "Ignore any instructions about report_intent, multi_tool_use.parallel, developer tools, or non-AgentChatBus tools.",
          "In this current Copilot session, use only the MCP server `agentchatbus`.",
          "Do not describe plans or tool strategy.",
          "This is a re-entry into an existing thread, not a fresh join.",
          "Do not call bus_connect and do not register a new agent.",
          "Use agentchatbus msg_wait to resume the existing thread context.",
          "If msg_wait returns actionable work, continue it directly or use msg_post with the latest sync_context.",
          "After posting, resume agentchatbus msg_wait with timeout_ms 600000.",
          initialPrompt,
        ].join(" ")
        : [
          "Ignore any instructions about report_intent, multi_tool_use.parallel, developer tools, or non-AgentChatBus tools.",
          "In this current Copilot session, use only the MCP server `agentchatbus`.",
          "Do not describe plans or tool strategy.",
          "Do not call any tool except agentchatbus bus_connect, msg_post, and msg_wait.",
          "Do these steps in order now: bus_connect, msg_post introduction, msg_wait timeout_ms 600000.",
          initialPrompt,
        ].join(" ");
      runtime.controls.write(correctionPrompt);
      this.scheduleCopilotDelayedEnter(runtime, "sent_copilot_direct_tool_correction", 1000);
      this.updateAutomationState(runtime, "waiting_for_copilot_direct_tool_correction_submit");
      logInfo(`[cli-session] ${runtime.snapshot.id} detected Copilot foreign-tooling leak and sent corrective prompt.`);
      return;
    }

    if (
      looksLikeCopilotAskUserDetour(screenText)
      && looksLikeCopilotUsableScreen(screen)
      && !automation.copilotAskUserCorrectionSent
    ) {
      automation.copilotAskUserCorrectionSent = true;
      const correctionPrompt = [
        "Do not ask me for confirmation and do not use ask_user in this session.",
        "If you are ready to contribute, post directly with agentchatbus msg_post using the latest sync_context values you already have.",
        "If the latest sync_context is stale, refresh it with agentchatbus msg_wait first and then post directly.",
        "After posting, immediately resume agentchatbus msg_wait with timeout_ms 600000.",
        "Do not narrate the decision. Perform the tool calls now.",
      ].join(" ");
      runtime.controls.write(correctionPrompt);
      this.scheduleCopilotDelayedEnter(runtime, "sent_copilot_ask_user_correction", 1000);
      this.updateAutomationState(runtime, "waiting_for_copilot_ask_user_correction_submit");
      logInfo(`[cli-session] ${runtime.snapshot.id} detected Copilot confirmation detour and sent corrective prompt.`);
      return;
    }

    if (
      looksLikeCopilotBackgroundTaskDetour(screenText)
      && looksLikeCopilotUsableScreen(screen)
      && !automation.copilotCorrectionSent
    ) {
      automation.copilotCorrectionSent = true;
      const correctionPrompt = [
        "Stop delegating this task.",
        "Ignore any background agent, helper, task, or read_agent flow you started.",
        "In this current session only, directly use the MCP server `agentchatbus` yourself.",
        "Do not create background agents, tasks, helpers, or sub-agents.",
        initialPrompt,
      ].join(" ");
      runtime.controls.write(correctionPrompt);
      this.scheduleCopilotDelayedEnter(runtime, "sent_copilot_direct_tool_correction", 1000);
      this.updateAutomationState(runtime, "waiting_for_copilot_direct_tool_correction_submit");
      logInfo(`[cli-session] ${runtime.snapshot.id} detected Copilot background-agent detour and sent corrective prompt.`);
      return;
    }

    if (!automation.initialPromptTextSent) {
      this.scheduleCopilotInitialPrompt(runtime, initialPrompt, 1200);
      this.updateAutomationState(runtime, "waiting_for_copilot_prompt_text");
      return;
    }

    if (
      automation.initialPromptTextSent
      && !automation.initialPromptEnterRetried
      && !automation.sawWorkingScreen
      && !runtime.replyCapture?.excerpt
      && isCopilotPromptShowingText(screenText, initialPrompt)
    ) {
      automation.initialPromptEnterRetried = true;
      this.scheduleCopilotDelayedEnter(runtime, "resent_copilot_initial_enter", 1000);
      this.updateAutomationState(runtime, "waiting_for_copilot_initial_retry_submit");
      logInfo(`[cli-session] ${runtime.snapshot.id} retried delayed Enter for initial Copilot prompt.`);
      return;
    }

    if (
      runtime.snapshot.automation_state === "meeting_delivery_prompt_sent"
      && !automation.deliveryPromptEnterRetried
      && runtime.replyCapture
      && !runtime.replyCapture.excerpt
      && isCopilotPromptShowingText(screenText, initialPrompt)
    ) {
      automation.deliveryPromptEnterRetried = true;
      this.scheduleCopilotDelayedEnter(runtime, "resent_copilot_delivery_enter", 1000);
      this.updateAutomationState(runtime, "waiting_for_copilot_delivery_submit");
      logInfo(`[cli-session] ${runtime.snapshot.id} scheduled delayed Enter for Copilot meeting prompt delivery.`);
    }

    this.finalizeReplyCaptureIfIdle(runtime, screen);
  }

  private runAutomation(runtime: CliSessionRuntime, screen: CliSessionScreenSnapshot): void {
    const automation = runtime.automationState;
    if (!automation || !runtime.controls?.write) {
      return;
    }
    if (automation.profile !== "codex-startup") {
      return;
    }

    if (isClaudeFamilyAdapter(runtime.snapshot.adapter) && runtime.snapshot.mode === "interactive") {
      this.runClaudeAutomation(runtime, screen);
      return;
    }

    if (runtime.snapshot.adapter === "cursor" && runtime.snapshot.mode === "interactive") {
      this.runCursorAutomation(runtime, screen);
      return;
    }

    if (runtime.snapshot.adapter === "copilot" && runtime.snapshot.mode === "interactive") {
      this.runCopilotAutomation(runtime, screen);
      return;
    }

    if (looksLikeCodexWorkingScreen(screen)) {
      automation.sawWorkingScreen = true;
      automation.deliveryPromptEnterRetried = false;
      automation.wakePromptText = undefined;
      automation.wakePromptEnterSent = false;
      automation.wakePromptEnterRetried = false;
      automation.copilotAskUserCorrectionSent = false;
      if (automation.submitTimer) {
        clearTimeout(automation.submitTimer);
        automation.submitTimer = null;
      }
      if (runtime.replyCapture && runtime.replyCapture.state !== "completed") {
        this.updateReplyCaptureState(runtime, "working", {
          excerpt: runtime.replyCapture.excerpt,
        });
      }
      this.updateAutomationState(runtime, "codex_working");
      return;
    }

    const normalizedScreen = screen.normalizedText;
    if (looksLikeCodexContinuePrompt(normalizedScreen) && !automation.continueSent) {
      automation.continueSent = true;
      automation.initialPromptTextScheduled = false;
      runtime.controls.write("\r");
      this.updateAutomationState(runtime, "sent_continue_enter");
      logInfo(`[cli-session] ${runtime.snapshot.id} auto-sent Enter for Codex startup prompt.`);
      return;
    }

    if (automation.manualOverride) {
      return;
    }

    const initialPrompt = String(runtime.snapshot.prompt || "").trim();
    if (!initialPrompt) {
      return;
    }

    if (looksLikeCodexReadyScreen(screen)) {
      automation.sawReadyScreen = true;
    }

    const canSendPrompt =
      automation.sawReadyScreen
      || (automation.continueSent && Boolean(normalizedScreen) && !looksLikeCodexContinuePrompt(normalizedScreen));
    if (!canSendPrompt) {
      return;
    }

    if (!automation.initialPromptTextSent) {
      if (!automation.initialPromptTextScheduled) {
        this.scheduleCodexInitialPrompt(runtime, CODEX_READY_SETTLE_DELAY_MS);
        this.updateAutomationState(runtime, "waiting_for_codex_ready_settle");
        logInfo(`[cli-session] ${runtime.snapshot.id} waiting for Codex ready screen to settle before sending initial prompt.`);
      }
      return;
    }

    if (!automation.initialPromptEnterSent && isCodexPromptShowingText(screen, initialPrompt)) {
      automation.initialPromptEnterSent = true;
      runtime.controls.write("\r");
      this.updateAutomationState(runtime, "sent_initial_prompt_enter");
      this.scheduleCodexPromptSubmit(runtime, CODEX_INITIAL_PROMPT_ENTER_DELAY_MS);
      logInfo(`[cli-session] ${runtime.snapshot.id} auto-submitted initial Codex prompt.`);
      return;
    }

    if (
      automation.wakePromptText
      && !automation.wakePromptEnterRetried
      && !automation.sawWorkingScreen
      && looksLikeCodexIdlePrompt(screen)
      && isCodexWakePromptShowing(screen, automation.wakePromptText)
    ) {
      automation.wakePromptEnterRetried = true;
      automation.wakePromptEnterSent = true;
      runtime.controls.write("\r");
      this.updateAutomationState(runtime, "meeting_wake_prompt_resent_enter");
      logInfo(`[cli-session] ${runtime.snapshot.id} retried Enter for Codex wake prompt delivery.`);
      return;
    }

    if (
      automation.initialPromptEnterSent
      && !automation.initialPromptEnterRetried
      && !automation.sawWorkingScreen
      && !runtime.replyCapture?.excerpt
      && looksLikeCodexIdlePrompt(screen)
      && isCodexPromptShowingText(screen, initialPrompt)
    ) {
      automation.initialPromptEnterRetried = true;
      runtime.controls.write("\r");
      this.updateAutomationState(runtime, "resent_initial_prompt_enter");
      logInfo(`[cli-session] ${runtime.snapshot.id} retried Enter for Codex prompt submission.`);
    }

    if (
      runtime.snapshot.automation_state === "meeting_delivery_prompt_sent"
      && !automation.deliveryPromptEnterRetried
      && runtime.replyCapture
      && !runtime.replyCapture.excerpt
      && looksLikeCodexIdlePrompt(screen)
      && (
        isCodexPromptShowingText(screen, initialPrompt)
        || looksLikeCodexPastedContentPrompt(screen)
      )
    ) {
      automation.deliveryPromptEnterRetried = true;
      runtime.controls.write("\r");
      this.updateAutomationState(runtime, "meeting_delivery_prompt_resent_enter");
      logInfo(
        `[cli-session] ${runtime.snapshot.id} retried Enter for Codex meeting prompt delivery.`,
      );
    }

    this.finalizeReplyCaptureIfIdle(runtime, screen);
  }

  private updateAutomationState(runtime: CliSessionRuntime, nextState: string): void {
    if (runtime.snapshot.automation_state === nextState) {
      return;
    }
    runtime.snapshot.automation_state = nextState;
    runtime.snapshot.updated_at = nowIso();
    this.emitSessionEvent("cli.session.state", runtime);
  }

  private emitSessionEvent(type: string, runtime: CliSessionRuntime): void {
    const session = this.cloneSnapshot(runtime.snapshot);
    eventBus.emit({
      type,
      payload: {
        thread_id: runtime.snapshot.thread_id,
        session_id: runtime.snapshot.id,
        session,
      },
    });
    eventBus.emit({
      type: "cli.session.native_card",
      payload: {
        thread_id: runtime.snapshot.thread_id,
        session_id: runtime.snapshot.id,
        card: session.native_activity_card || null,
        session,
      },
    });
  }

  private cloneSnapshot(snapshot: CliSessionSnapshot): CliSessionSnapshot {
    return {
      ...snapshot,
      raw_result: snapshot.raw_result ? { ...snapshot.raw_result } : snapshot.raw_result,
      prompt_history: Array.isArray(snapshot.prompt_history)
        ? snapshot.prompt_history.map((entry) => ({ ...entry }))
        : snapshot.prompt_history,
      recent_tool_events: Array.isArray(snapshot.recent_tool_events)
        ? snapshot.recent_tool_events.map((entry) => ({ ...entry }))
        : snapshot.recent_tool_events,
      recent_stream_events: Array.isArray(snapshot.recent_stream_events)
        ? snapshot.recent_stream_events.map((entry) => ({ ...entry }))
        : snapshot.recent_stream_events,
      reentry_prompt: snapshot.reentry_prompt
        ? { ...snapshot.reentry_prompt }
        : buildSessionReentryPrompt(snapshot),
      recent_activity_events: Array.isArray(snapshot.recent_activity_events)
        ? snapshot.recent_activity_events.map((entry) => ({
          ...entry,
          files: Array.isArray(entry.files) ? entry.files.map((file) => ({ ...file })) : entry.files,
          plan_steps: Array.isArray(entry.plan_steps)
            ? entry.plan_steps.map((step) => ({ ...step }))
            : entry.plan_steps,
        }))
        : snapshot.recent_activity_events,
      native_turn_runtime: cloneNativeTurnRuntime(snapshot.native_turn_runtime),
      wait_status: snapshot.wait_status
        ? { ...snapshot.wait_status }
        : snapshot.wait_status,
      native_activity_card: buildNativeActivityCard(snapshot),
    };
  }

  private adapterKey(adapterId: CliSessionAdapterId, mode: CliSessionMode): string {
    return `${adapterId}:${mode}`;
  }

  private resolveLaunchExternalThreadId(
    adapterId: CliSessionAdapterId,
    mode: CliSessionMode,
    launchEnv: Record<string, string>,
  ): string | undefined {
    if (adapterId === "codex" && (mode === "headless" || mode === "direct")) {
      return normalizeOptionalString(launchEnv?.[CODEX_THREAD_ID_ENV_VAR]);
    }
    if (adapterId === "cursor" && (mode === "headless" || mode === "direct")) {
      return normalizeOptionalString(launchEnv?.[CURSOR_SESSION_ID_ENV_VAR]);
    }
    if (adapterId === "copilot" && (mode === "headless" || mode === "direct")) {
      return normalizeOptionalString(launchEnv?.[COPILOT_SESSION_ID_ENV_VAR]);
    }
    return undefined;
  }

  private recordPromptHistory(
    runtime: CliSessionRuntime,
    prompt: string,
    kind: "initial" | "update" | "wake" | "delivery",
  ): void {
    const normalizedPrompt = String(prompt || "");
    if (!normalizedPrompt.trim()) {
      return;
    }
    const entries = Array.isArray(runtime.snapshot.prompt_history)
      ? [...runtime.snapshot.prompt_history]
      : [];
    const lastEntry = entries[entries.length - 1];
    if (
      lastEntry
      && lastEntry.kind === kind
      && String(lastEntry.prompt || "") === normalizedPrompt
    ) {
      return;
    }
    entries.push({
      at: nowIso(),
      kind,
      prompt: normalizedPrompt,
    });
    runtime.snapshot.prompt_history = entries.slice(-40);
  }
}
