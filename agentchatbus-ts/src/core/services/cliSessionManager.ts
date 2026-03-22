import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import xtermHeadless from "@xterm/headless";
import { getConfig } from "../config/registry.js";
import { eventBus } from "../../shared/eventBus.js";
import { logError, logInfo } from "../../shared/logger.js";

type HeadlessTerminalInstance = import("@xterm/headless").Terminal;
const { Terminal: HeadlessTerminal } = xtermHeadless;

export type CliSessionAdapterId = "cursor" | "codex";
export type CliSessionMode = "headless" | "interactive";
export type CliSessionState =
  | "created"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "stopped";
export type CliSessionStream = "stdout" | "stderr";

export interface CliSessionSnapshot {
  id: string;
  thread_id: string;
  adapter: CliSessionAdapterId;
  mode: CliSessionMode;
  state: CliSessionState;
  prompt: string;
  initial_instruction?: string;
  workspace: string;
  requested_by_agent_id: string;
  participant_agent_id?: string;
  participant_display_name?: string;
  participant_role?: "administrator" | "participant";
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
}

export interface CliSessionOutputEntry {
  seq: number;
  stream: CliSessionStream;
  text: string;
  created_at: string;
}

export interface CreateCliSessionInput {
  threadId: string;
  adapter: CliSessionAdapterId;
  mode?: CliSessionMode;
  prompt?: string;
  initialInstruction?: string;
  workspace?: string;
  requestedByAgentId: string;
  participantAgentId?: string;
  participantDisplayName?: string;
  participantRole?: "administrator" | "participant";
  contextDeliveryMode?: "join" | "resume" | "incremental";
  lastDeliveredSeq?: number;
  cols?: number;
  rows?: number;
}

export interface CliSessionMeetingStatePatch {
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

type CliSessionControls = {
  kill?: () => void;
  write?: (text: string) => void;
  resize?: (cols: number, rows: number) => void;
};

type CliSessionRuntime = {
  snapshot: CliSessionSnapshot;
  output: CliSessionOutputEntry[];
  stopRequested: boolean;
  abortController: AbortController | null;
  runPromise: Promise<void> | null;
  controls: CliSessionControls | null;
  screenState: CliSessionScreenRuntime | null;
  automationState: CliSessionAutomationRuntime | null;
  replyCapture: CliSessionReplyCaptureRuntime | null;
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
  initialPromptTextSent: boolean;
  initialPromptEnterSent: boolean;
  initialPromptEnterRetried: boolean;
  manualOverride: boolean;
  sawReadyScreen: boolean;
  sawWorkingScreen: boolean;
  submitTimer: NodeJS.Timeout | null;
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

type CliAdapterRunInput = {
  prompt: string;
  workspace: string;
  cols: number;
  rows: number;
};

type CliAdapterRunHooks = {
  signal: AbortSignal;
  onOutput: (stream: CliSessionStream, text: string) => void;
  onProcessStart: (pid: number) => void;
  onControls: (controls: CliSessionControls) => void;
};

type CliAdapterRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  resultText?: string;
  rawResult?: Record<string, unknown> | null;
  externalSessionId?: string;
  externalRequestId?: string;
};

type NodePtyModule = typeof import("node-pty");
type PtyInstance = import("node-pty").IPty;

interface CliSessionAdapter {
  readonly adapterId: CliSessionAdapterId;
  readonly mode: CliSessionMode;
  readonly supportsInput: boolean;
  readonly supportsRestart: boolean;
  readonly supportsResize: boolean;
  readonly requiresPrompt: boolean;
  readonly shell?: string;
  run(input: CliAdapterRunInput, hooks: CliAdapterRunHooks): Promise<CliAdapterRunResult>;
}

type CursorCommandRequest = {
  command: string;
  prompt: string;
  workspace: string;
};

type CursorCommandExecutionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type CursorResultEnvelope = {
  resultText?: string;
  rawResult?: Record<string, unknown> | null;
  sessionId?: string;
  requestId?: string;
};

interface CursorCommandExecutor {
  run(request: CursorCommandRequest, hooks: CliAdapterRunHooks): Promise<CursorCommandExecutionResult>;
}

const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 32;
const INITIAL_CODEX_REPLY_TIMEOUT_MS = 20000;
const CODEX_REPLY_FINALIZE_DEBOUNCE_MS = 900;
const WINDOWS_POWERSHELL =
  `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const DEFAULT_HEADLESS_SCREEN_SNAPSHOT: CliSessionScreenSnapshot = {
  text: "",
  normalizedText: "",
  cursorX: 0,
  cursorY: 0,
  bufferType: "normal",
};
const ANSI_CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const ANSI_SINGLE_CHAR_SEQUENCE = /\u001b[@-_]/g;
let nodePtyModulePromise: Promise<NodePtyModule> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function clipText(input: string, maxChars = 4000): string {
  const value = String(input || "");
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}

function stripTerminalControlSequences(input: string): string {
  return String(input || "")
    .replace(ANSI_OSC_SEQUENCE, "")
    .replace(ANSI_CSI_SEQUENCE, "")
    .replace(ANSI_SINGLE_CHAR_SEQUENCE, "")
    .replace(/\r/g, "");
}

function summarizeInteractiveTranscript(input: string): string | undefined {
  const normalized = stripTerminalControlSequences(input)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  if (!normalized) {
    return undefined;
  }
  return clipText(normalized, 1200);
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
      && normalizedText.includes("100 left")
      && looksLikeCodexPromptLine(screen.text)
    )
    || (
      normalizedText.includes("build anything")
      && normalizedText.includes("plan")
      && normalizedText.includes("search")
    )
  );
}

function looksLikeCodexWorkingScreen(screen: CliSessionScreenSnapshot): boolean {
  const normalizedText = screen.normalizedText;
  if (!normalizedText) {
    return false;
  }
  return normalizedText.includes("working") && normalizedText.includes("esc to interrupt");
}

function isCodexWorkingLine(line: string): boolean {
  const normalizedText = normalizePromptMatchText(line);
  return normalizedText.includes("working") && normalizedText.includes("esc to interrupt");
}

function isCodexFooterLine(line: string): boolean {
  const normalized = normalizePromptMatchText(line);
  return (
    normalized.includes("100 left")
    && (
      normalized.includes("gpt 5")
      || normalized.includes("gpt-5")
      || normalized.includes("documents")
      || normalized.includes("agentchatbus")
    )
  );
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

function normalizeWorkspacePath(explicitPath?: string): string {
  const direct = String(explicitPath || "").trim();
  if (direct) {
    return direct;
  }
  const configuredWorkspace = String(getConfig().cliWorkspace || "").trim();
  if (configuredWorkspace) {
    return configuredWorkspace;
  }
  return process.cwd();
}

function normalizeTerminalCols(value?: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_TERMINAL_COLS;
  }
  return Math.min(Math.max(Math.floor(numeric), 40), 320);
}

function normalizeTerminalRows(value?: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_TERMINAL_ROWS;
  }
  return Math.min(Math.max(Math.floor(numeric), 10), 120);
}

function toPowerShellSingleQuoted(value: string): string {
  return `'${String(value || "").replaceAll("'", "''")}'`;
}

function resolveCursorAgentCommand(): string {
  const configured = String(getConfig().cursorAgentCommand || "").trim();
  if (configured) {
    return configured;
  }
  if (process.platform === "win32") {
    try {
      const output = execFileSync("where.exe", ["cursor-agent"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const firstMatch = String(output || "")
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find(Boolean);
      if (firstMatch) {
        const ps1Match = firstMatch.replace(/\.cmd$/i, ".ps1");
        if (ps1Match !== firstMatch && existsSync(ps1Match)) {
          return ps1Match;
        }
        return firstMatch;
      }
    } catch {
      // Fall back to PATH lookup below.
    }
  }
  return "cursor-agent";
}

function resolveCodexCommand(): string {
  const configured = String(getConfig().codexCommand || "").trim();
  return configured || "codex";
}

function shouldUseConpty(): boolean {
  return getConfig().ptyUseConpty;
}

function isConptyOrWinptyStartupError(error: unknown): boolean {
  const message = error instanceof Error
    ? `${error.message}\n${error.stack || ""}`
    : String(error);
  return (
    message.includes("\\\\.\\pipe\\conpty") ||
    message.includes("WindowsPtyAgent") ||
    message.includes("WinPTY") ||
    message.includes("winpty") ||
    message.includes("conpty")
  );
}

async function loadNodePty(): Promise<NodePtyModule> {
  if (!nodePtyModulePromise) {
    nodePtyModulePromise = import("node-pty").catch((error: unknown) => {
      nodePtyModulePromise = null;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Interactive PTY sessions require the optional 'node-pty' runtime. ` +
        `Rebuild the bundled server resources so 'resources/bundled-server/node_modules' is present. ` +
        `Original error: ${detail}`
      );
    });
  }
  return await nodePtyModulePromise;
}

export function parseCursorHeadlessResult(stdout: string): CursorResultEnvelope {
  const rawText = String(stdout || "").trim();
  if (!rawText) {
    return {
      rawResult: null,
      resultText: "",
    };
  }

  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    return {
      rawResult: parsed,
      resultText: typeof parsed.result === "string" ? parsed.result : rawText,
      sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
      requestId: typeof parsed.request_id === "string" ? parsed.request_id : undefined,
    };
  } catch {
    return {
      rawResult: null,
      resultText: rawText,
    };
  }
}

class CursorHeadlessExecutor implements CursorCommandExecutor {
  async run(request: CursorCommandRequest, hooks: CliAdapterRunHooks): Promise<CursorCommandExecutionResult> {
    return await new Promise<CursorCommandExecutionResult>((resolve, reject) => {
      const cursorArgs = [
        "-p",
        "--output-format",
        "json",
        "-f",
        "--trust",
        "--workspace",
        request.workspace,
        request.prompt,
      ];
      const isWindows = process.platform === "win32";
      const isPowerShellShim = isWindows && /\.ps1$/i.test(request.command);
      const command = isWindows
        ? (isPowerShellShim ? WINDOWS_POWERSHELL : "cmd.exe")
        : request.command;
      const args = isWindows
        ? (isPowerShellShim
          ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", request.command, ...cursorArgs]
          : ["/d", "/s", "/c", "cursor-agent", ...cursorArgs])
        : cursorArgs;
      const env = { ...process.env };
      if (isWindows) {
        const commandDir = dirname(request.command);
        const currentPath = String(env.Path || env.PATH || "");
        if (commandDir && !currentPath.toLowerCase().includes(commandDir.toLowerCase())) {
          env.Path = `${commandDir};${currentPath}`;
          env.PATH = env.Path;
        }
      }

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, args, {
          cwd: request.workspace,
          env,
          shell: false,
        });
      } catch (error) {
        reject(error);
        return;
      }

      hooks.onControls({
        kill: () => {
          try {
            child.kill();
          } catch {
            // Best effort shutdown.
          }
        },
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finalize = (result: CursorCommandExecutionResult) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      if (typeof child.pid === "number" && child.pid > 0) {
        hooks.onProcessStart(child.pid);
      }

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        hooks.onOutput("stdout", text);
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        hooks.onOutput("stderr", text);
      });

      child.on("error", (error) => {
        fail(error);
      });

      child.on("close", (code) => {
        finalize({
          exitCode: typeof code === "number" ? code : null,
          stdout,
          stderr,
        });
      });

      hooks.signal.addEventListener(
        "abort",
        () => {
          try {
            child.kill();
          } catch {
            // Best effort shutdown.
          }
        },
        { once: true }
      );
    });
  }
}

class CursorHeadlessAdapter implements CliSessionAdapter {
  readonly adapterId = "cursor";
  readonly mode = "headless";
  readonly supportsInput = false;
  readonly supportsRestart = true;
  readonly supportsResize = false;
  readonly requiresPrompt = true;

  constructor(
    private readonly executor: CursorCommandExecutor = new CursorHeadlessExecutor(),
    private readonly command = resolveCursorAgentCommand(),
  ) {}

  async run(input: CliAdapterRunInput, hooks: CliAdapterRunHooks): Promise<CliAdapterRunResult> {
    const workspace = normalizeWorkspacePath(input.workspace);
    let execution: CursorCommandExecutionResult;
    try {
      execution = await this.executor.run(
        {
          command: this.command,
          prompt: input.prompt,
          workspace,
        },
        hooks
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cursor headless launch failed via '${this.command}': ${detail}`);
    }
    const parsed = parseCursorHeadlessResult(execution.stdout);
    return {
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      resultText: parsed.resultText,
      rawResult: parsed.rawResult,
      externalSessionId: parsed.sessionId,
      externalRequestId: parsed.requestId,
    };
  }
}

class CodexInteractiveAdapter implements CliSessionAdapter {
  readonly adapterId = "codex";
  readonly mode = "interactive";
  readonly supportsInput = true;
  readonly supportsRestart = true;
  readonly supportsResize = true;
  readonly requiresPrompt = false;
  readonly shell = "powershell";

  constructor(
    private readonly shellCommand = WINDOWS_POWERSHELL,
    private readonly codexCommand = resolveCodexCommand(),
  ) {}

  async run(input: CliAdapterRunInput, hooks: CliAdapterRunHooks): Promise<CliAdapterRunResult> {
    if (process.platform !== "win32") {
      throw new Error("Codex interactive PTY mode currently requires Windows PowerShell.");
    }

    const preferConpty = shouldUseConpty();
    try {
      return await this.runWithBackend(input, hooks, preferConpty);
    } catch (error) {
      if (!preferConpty || !isConptyOrWinptyStartupError(error)) {
        throw error;
      }
      logInfo("[cli-session] Codex PTY ConPTY startup failed, retrying with WinPTY fallback.");
      return await this.runWithBackend(input, hooks, false);
    }
  }

  private async runWithBackend(
    input: CliAdapterRunInput,
    hooks: CliAdapterRunHooks,
    useConpty: boolean,
  ): Promise<CliAdapterRunResult> {
    const nodePty = await loadNodePty();
    return await new Promise<CliAdapterRunResult>((resolve, reject) => {
      const commandParts = [
        `& ${toPowerShellSingleQuoted(this.codexCommand)}`,
        "--no-alt-screen",
        "-C",
        toPowerShellSingleQuoted(input.workspace),
      ];

      let terminal: PtyInstance | null = null;
      let stdout = "";
      let settled = false;
      let startupGuardTimer: NodeJS.Timeout | null = null;

      const disposeStartupGuard = () => {
        if (startupGuardTimer) {
          clearTimeout(startupGuardTimer);
          startupGuardTimer = null;
        }
        process.off("uncaughtException", handleUncaughtException);
      };

      const finalize = (result: CliAdapterRunResult) => {
        if (settled) {
          return;
        }
        settled = true;
        disposeStartupGuard();
        resolve(result);
      };

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        if (!isConptyOrWinptyStartupError(error)) {
          disposeStartupGuard();
        }
        reject(error);
      };

      const handleUncaughtException = (error: unknown) => {
        if (settled) {
          return;
        }
        if (isConptyOrWinptyStartupError(error)) {
          try {
            terminal?.kill();
          } catch {
            // Best effort shutdown.
          }
          fail(error);
          return;
        }
        disposeStartupGuard();
        setImmediate(() => {
          throw error;
        });
      };

      process.on("uncaughtException", handleUncaughtException);
      startupGuardTimer = setTimeout(() => {
        disposeStartupGuard();
      }, 5000);

      try {
        terminal = nodePty.spawn(
          this.shellCommand,
          [
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            commandParts.join(" "),
          ],
          {
            name: "xterm-256color",
            cwd: input.workspace,
            env: process.env,
            cols: normalizeTerminalCols(input.cols),
            rows: normalizeTerminalRows(input.rows),
            useConpty,
          }
        );
      } catch (error) {
        fail(error);
        return;
      }

      hooks.onControls({
        kill: () => {
          try {
            terminal?.kill();
          } catch {
            // Best effort shutdown.
          }
        },
        write: (text) => {
          terminal?.write(text);
        },
        resize: (cols, rows) => {
          terminal?.resize(normalizeTerminalCols(cols), normalizeTerminalRows(rows));
        },
      });

      if (typeof terminal.pid === "number" && terminal.pid > 0) {
        hooks.onProcessStart(terminal.pid);
      }

      terminal.onData((data) => {
        disposeStartupGuard();
        stdout += data;
        hooks.onOutput("stdout", data);
      });

      terminal.onExit(({ exitCode }) => {
        finalize({
          exitCode,
          stdout,
          stderr: "",
          resultText: summarizeInteractiveTranscript(stdout),
          rawResult: null,
        });
      });

      hooks.signal.addEventListener(
        "abort",
        () => {
          try {
            terminal?.kill();
          } catch {
            // Best effort shutdown.
          }
        },
        { once: true }
      );
    });
  }
}

export class CliSessionManager {
  private readonly runtimes = new Map<string, CliSessionRuntime>();
  private readonly adapters = new Map<string, CliSessionAdapter>();

  constructor(adapters: CliSessionAdapter[] = [new CursorHeadlessAdapter(), new CodexInteractiveAdapter()]) {
    for (const adapter of adapters) {
      this.adapters.set(this.adapterKey(adapter.adapterId, adapter.mode), adapter);
    }
  }

  createSession(input: CreateCliSessionInput): CliSessionSnapshot {
    const prompt = String(input.prompt || "");
    const adapterId = String(input.adapter || "").trim() as CliSessionAdapterId;
    const mode = (String(input.mode || "headless").trim() || "headless") as CliSessionMode;
    const adapter = this.adapters.get(this.adapterKey(adapterId, mode));
    if (!adapter) {
      throw new Error(`Unsupported CLI adapter '${adapterId}' in mode '${mode}'`);
    }
    if (adapter.requiresPrompt && !prompt.trim()) {
      throw new Error("prompt is required");
    }

    const workspace = normalizeWorkspacePath(input.workspace);
    const cols = adapter.supportsResize ? normalizeTerminalCols(input.cols) : undefined;
    const rows = adapter.supportsResize ? normalizeTerminalRows(input.rows) : undefined;
    const initialInstruction = String(input.initialInstruction || "").trim() || undefined;
    const participantAgentId = String(input.participantAgentId || "").trim() || undefined;
    const participantDisplayName = String(input.participantDisplayName || "").trim() || undefined;
    const participantRole = input.participantRole;
    const contextDeliveryMode = input.contextDeliveryMode;
    const lastDeliveredSeq = Number.isFinite(Number(input.lastDeliveredSeq))
      ? Number(input.lastDeliveredSeq)
      : undefined;
    const snapshot: CliSessionSnapshot = {
      id: randomUUID(),
      thread_id: input.threadId,
      adapter: adapterId,
      mode,
      state: "created",
      prompt,
      initial_instruction: initialInstruction,
      workspace,
      requested_by_agent_id: input.requestedByAgentId,
      participant_agent_id: participantAgentId,
      participant_display_name: participantDisplayName,
      participant_role: participantRole,
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
      context_delivery_mode: contextDeliveryMode,
      last_delivered_seq: lastDeliveredSeq,
      last_acknowledged_seq: lastDeliveredSeq,
      meeting_post_state: participantAgentId ? "pending" : undefined,
    };

    const runtime: CliSessionRuntime = {
      snapshot,
      output: [],
      stopRequested: false,
      abortController: null,
      runPromise: null,
      controls: null,
      screenState: null,
      automationState: null,
      replyCapture: null,
    };

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

  async restartSession(sessionId: string): Promise<CliSessionSnapshot | null> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return null;
    }
    const adapter = this.adapters.get(this.adapterKey(runtime.snapshot.adapter, runtime.snapshot.mode));
    if (!adapter || !adapter.supportsRestart) {
      throw new Error("Session does not support restart");
    }
    if (runtime.runPromise) {
      throw new Error("Session is still running");
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
    runtime.snapshot.automation_state = undefined;
    runtime.snapshot.reply_capture_state = undefined;
    runtime.snapshot.reply_capture_excerpt = undefined;
    runtime.snapshot.reply_capture_error = undefined;
    runtime.snapshot.last_acknowledged_seq = runtime.snapshot.last_delivered_seq;
    runtime.snapshot.last_posted_seq = undefined;
    runtime.snapshot.meeting_post_state = runtime.snapshot.participant_agent_id ? "pending" : undefined;
    runtime.snapshot.meeting_post_error = undefined;
    runtime.snapshot.last_posted_message_id = undefined;
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
    runtime.snapshot.context_delivery_mode = options?.deliveryMode || "incremental";
    if (Number.isFinite(Number(options?.deliveredSeq))) {
      runtime.snapshot.last_delivered_seq = Number(options?.deliveredSeq);
    }
    runtime.snapshot.last_posted_seq = undefined;
    runtime.snapshot.last_posted_message_id = undefined;
    runtime.snapshot.meeting_post_state = runtime.snapshot.participant_agent_id ? "pending" : undefined;
    runtime.snapshot.meeting_post_error = undefined;
    runtime.snapshot.reply_capture_state = undefined;
    runtime.snapshot.reply_capture_excerpt = undefined;
    runtime.snapshot.reply_capture_error = undefined;
    if (runtime.replyCapture?.timeoutTimer) {
      clearTimeout(runtime.replyCapture.timeoutTimer);
    }
    if (runtime.replyCapture?.finalizeTimer) {
      clearTimeout(runtime.replyCapture.finalizeTimer);
    }
    const previousExcerpt = runtime.snapshot.reply_capture_excerpt;
    runtime.replyCapture = null;
    this.startReplyCapture(runtime, normalizedPrompt, {
      baselineExcerpt: previousExcerpt,
    });
    runtime.controls.write(normalizedPrompt);
    runtime.controls.write("\r");
    this.updateAutomationState(runtime, "meeting_delivery_prompt_sent");
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
    if (!runtime.snapshot.supports_resize || !runtime.controls?.resize) {
      return {
        ok: false,
        error: `Session adapter '${runtime.snapshot.adapter}' in mode '${runtime.snapshot.mode}' does not support terminal resize.`,
      };
    }
    const normalizedCols = normalizeTerminalCols(cols);
    const normalizedRows = normalizeTerminalRows(rows);
    runtime.controls.resize(normalizedCols, normalizedRows);
    runtime.snapshot.cols = normalizedCols;
    runtime.snapshot.rows = normalizedRows;
    runtime.screenState?.terminal.resize(normalizedCols, normalizedRows);
    if (runtime.screenState) {
      this.refreshScreenSnapshot(runtime, snapshotHeadlessScreen(runtime.screenState.terminal));
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
    this.prepareInteractiveRuntimeState(runtime);
    runtime.snapshot.run_count += 1;
    runtime.snapshot.state = "starting";
    runtime.snapshot.updated_at = nowIso();
    this.emitSessionEvent("cli.session.started", runtime);

    try {
      runtime.snapshot.state = "running";
      runtime.snapshot.updated_at = nowIso();
      this.emitSessionEvent("cli.session.state", runtime);

      const result = await adapter.run(
        {
          prompt: runtime.snapshot.prompt,
          workspace: runtime.snapshot.workspace,
          cols: normalizeTerminalCols(runtime.snapshot.cols),
          rows: normalizeTerminalRows(runtime.snapshot.rows),
        },
        {
          signal: runtime.abortController.signal,
          onOutput: (stream, text) => this.appendOutput(runtime, stream, text),
          onProcessStart: (pid) => {
            runtime.snapshot.pid = pid;
            runtime.snapshot.updated_at = nowIso();
            this.emitSessionEvent("cli.session.state", runtime);
          },
          onControls: (controls) => {
            runtime.controls = controls;
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

      if (runtime.stopRequested) {
        runtime.snapshot.state = "stopped";
        this.emitSessionEvent("cli.session.stopped", runtime);
      } else if ((result.exitCode ?? 0) === 0) {
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
      logInfo(
        `[cli-session] ${runtime.snapshot.adapter}/${runtime.snapshot.mode} ${runtime.snapshot.id} -> ${runtime.snapshot.state}`
      );
      runtime.abortController = null;
      runtime.controls = null;
      runtime.runPromise = null;
      this.disposeInteractiveRuntimeState(runtime);
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
    runtime.output.push(entry);
    if (runtime.output.length > 5000) {
      runtime.output.splice(0, runtime.output.length - 5000);
    }
    if (stream === "stdout") {
      runtime.snapshot.stdout_excerpt = clipText(`${runtime.snapshot.stdout_excerpt || ""}${normalized}`);
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
        initialPromptTextSent: false,
        initialPromptEnterSent: false,
        initialPromptEnterRetried: false,
        manualOverride: false,
        sawReadyScreen: false,
        sawWorkingScreen: false,
        submitTimer: null,
      };
      runtime.snapshot.automation_state = runtime.snapshot.prompt.trim()
        ? "waiting_for_codex_prompt"
        : "waiting_for_codex_startup";
    }
  }

  private disposeInteractiveRuntimeState(runtime: CliSessionRuntime): void {
    if (runtime.automationState?.submitTimer) {
      clearTimeout(runtime.automationState.submitTimer);
      runtime.automationState.submitTimer = null;
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
    } catch {
      // Best effort cleanup.
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

  private startReplyCapture(
    runtime: CliSessionRuntime,
    prompt: string,
    options?: { baselineExcerpt?: string },
  ): void {
    if (runtime.replyCapture?.timeoutTimer) {
      clearTimeout(runtime.replyCapture.timeoutTimer);
    }
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
      capture.state = "timeout";
      capture.error = `Timed out waiting for Codex reply to '${prompt}'.`;
      this.refreshReplyCaptureSnapshot(runtime);
      this.updateAutomationState(runtime, "reply_timeout");
      logError(`[cli-session] ${runtime.snapshot.id} ${capture.error}`);
    }, INITIAL_CODEX_REPLY_TIMEOUT_MS);
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
    const nextError = options?.error ?? capture.error;
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
    const excerpt = extractCodexReplyFromTranscript(capture.rawOutput, capture.prompt);
    if (!excerpt) {
      return;
    }
    if (areEquivalentReplyExcerpts(excerpt, capture.baselineExcerpt)) {
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
    if (capture.baselineExcerpt && !capture.excerpt) {
      return;
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
    }, CODEX_REPLY_FINALIZE_DEBOUNCE_MS);
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
        this.scheduleCodexPromptSubmit(runtime, 900);
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

  private runAutomation(runtime: CliSessionRuntime, screen: CliSessionScreenSnapshot): void {
    const automation = runtime.automationState;
    if (!automation || !runtime.controls?.write) {
      return;
    }
    if (automation.profile !== "codex-startup") {
      return;
    }

    if (looksLikeCodexWorkingScreen(screen)) {
      automation.sawWorkingScreen = true;
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
      automation.initialPromptTextSent = true;
      this.startReplyCapture(runtime, initialPrompt);
      runtime.controls.write(initialPrompt);
      this.updateAutomationState(runtime, "sent_initial_prompt_text");
      this.scheduleCodexPromptSubmit(runtime, 140);
      logInfo(`[cli-session] ${runtime.snapshot.id} auto-typed initial Codex prompt.`);
      return;
    }

    if (!automation.initialPromptEnterSent && isCodexPromptShowingText(screen, initialPrompt)) {
      automation.initialPromptEnterSent = true;
      runtime.controls.write("\r");
      this.updateAutomationState(runtime, "sent_initial_prompt_enter");
      this.scheduleCodexPromptSubmit(runtime, 900);
      logInfo(`[cli-session] ${runtime.snapshot.id} auto-submitted initial Codex prompt.`);
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
    eventBus.emit({
      type,
      payload: {
        thread_id: runtime.snapshot.thread_id,
        session_id: runtime.snapshot.id,
        session: this.cloneSnapshot(runtime.snapshot),
      },
    });
  }

  private cloneSnapshot(snapshot: CliSessionSnapshot): CliSessionSnapshot {
    return {
      ...snapshot,
      raw_result: snapshot.raw_result ? { ...snapshot.raw_result } : snapshot.raw_result,
    };
  }

  private adapterKey(adapterId: CliSessionAdapterId, mode: CliSessionMode): string {
    return `${adapterId}:${mode}`;
  }
}
