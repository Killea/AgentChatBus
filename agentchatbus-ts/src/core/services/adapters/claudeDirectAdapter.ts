import { dirname } from "node:path";
import { existsSync } from "node:fs";
import spawn from "cross-spawn";
import type { Writable } from "node:stream";
import type {
  CliAdapterActivityEvent,
  CliAdapterNativeRuntimeEvent,
  CliSessionActivityFile,
  CliSessionAdapter,
  CliAdapterRunHooks,
  CliAdapterRunInput,
  CliAdapterRunResult,
} from "./types.js";
import { normalizeWorkspacePath, terminateChildProcessTree } from "./utils.js";
import { WINDOWS_POWERSHELL } from "./constants.js";
import { CLAUDE_SESSION_ID_ENV_VAR, resolveClaudeCommand } from "./claudeHeadlessAdapter.js";

type ClaudeDirectCommandRequest = {
  command: string;
  prompt: string;
  workspace: string;
  model?: string;
  permissionMode?: string;
  env?: Record<string, string>;
};

type ClaudeDirectCommandExecutionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type ClaudeDirectResultEnvelope = {
  resultText?: string;
  rawResult?: Record<string, unknown> | null;
  sessionId?: string;
  requestId?: string;
};

type ClaudeContentBlockState = {
  id: string;
  type: string;
  name?: string;
  text?: string;
  thinking?: string;
  partialJson?: string;
  input?: Record<string, unknown>;
  toolUseId?: string;
};

type ClaudeSdkMessageContentBlock = {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  id?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
  summary?: unknown;
  message?: unknown;
};

type ClaudeToolState = {
  id: string;
  type: string;
  name?: string;
  input?: Record<string, unknown>;
  partialJson?: string;
  toolUseId?: string;
  resolved?: boolean;
};

type ClaudeToolActivityInfo = {
  kind: CliAdapterActivityEvent["kind"];
  label: string;
  summary?: string;
  server?: string;
  tool?: string;
  command?: string;
  cwd?: string;
  files?: CliSessionActivityFile[];
};

export type ClaudeDirectCollectedStream = {
  envelope: ClaudeDirectResultEnvelope;
  activities: CliAdapterActivityEvent[];
  runtimeEvents: CliAdapterNativeRuntimeEvent[];
};

interface ClaudeDirectCommandExecutor {
  run(
    request: ClaudeDirectCommandRequest,
    hooks: CliAdapterRunHooks,
  ): Promise<ClaudeDirectCommandExecutionResult>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clipText(value: unknown, maxLength = 280): string | undefined {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function extractRawString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function appendRawDelta(current: string | undefined, delta: string | undefined): string | undefined {
  if (typeof delta !== "string" || !delta.length) {
    return current;
  }
  return `${current || ""}${delta}`;
}

function normalizeRuntimePhase(
  phase: CliAdapterNativeRuntimeEvent["phase"] | undefined,
): CliAdapterNativeRuntimeEvent["phase"] {
  if (
    phase === "starting"
    || phase === "running"
    || phase === "interrupting"
    || phase === "completed"
    || phase === "interrupted"
    || phase === "failed"
    || phase === "idle"
  ) {
    return phase;
  }
  return "idle";
}

function extractString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function classifyToolActivityKind(toolName: string | undefined): CliAdapterActivityEvent["kind"] {
  const normalized = String(toolName || "").trim().toLowerCase();
  if (
    normalized.includes("bash")
    || normalized.includes("terminal")
    || normalized.includes("command")
    || normalized.includes("shell")
    || normalized.includes("exec")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit")
    || normalized.includes("write")
    || normalized.includes("file")
    || normalized.includes("patch")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  return "dynamic_tool_call";
}

function normalizeToolName(toolName: string | undefined): string {
  return String(toolName || "").trim() || "Tool";
}

function isToolUseBlockType(type: string | undefined): boolean {
  const normalized = String(type || "").trim().toLowerCase();
  return normalized === "tool_use" || normalized.endsWith("_tool_use");
}

function isToolResultBlockType(type: string | undefined): boolean {
  const normalized = String(type || "").trim().toLowerCase();
  return normalized === "tool_result" || normalized.endsWith("_tool_result");
}

function safeParseJsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(normalized);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractQuotedJsonField(source: string, fieldNames: string[]): string | undefined {
  const input = String(source || "");
  if (!input) {
    return undefined;
  }
  for (const fieldName of fieldNames) {
    const escapedField = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = input.match(new RegExp(`"${escapedField}"\\s*:\\s*"((?:\\\\.|[^"])*)"`, "i"));
    if (!match?.[1]) {
      continue;
    }
    try {
      const decoded = JSON.parse(`"${match[1]}"`);
      if (typeof decoded === "string" && decoded.trim()) {
        return decoded.trim();
      }
    } catch {
      const normalized = match[1]
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\")
        .trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

function extractStringArrayJsonField(source: string, fieldNames: string[]): string[] {
  const input = String(source || "");
  if (!input) {
    return [];
  }
  for (const fieldName of fieldNames) {
    const escapedField = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = input.match(new RegExp(`"${escapedField}"\\s*:\\s*\\[([^\\]]*)\\]`, "i"));
    if (!match?.[1]) {
      continue;
    }
    const values = Array.from(match[1].matchAll(/"((?:\\.|[^"])*)"/g))
      .map((entry) => {
        try {
          return JSON.parse(`"${entry[1]}"`);
        } catch {
          return entry[1];
        }
      })
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
    if (values.length) {
      return values;
    }
  }
  return [];
}

function extractToolHintsFromPartialJson(partialJson: string | undefined): {
  command?: string;
  cwd?: string;
  files?: CliSessionActivityFile[];
  searchTarget?: string;
} {
  const normalized = String(partialJson || "").trim();
  if (!normalized) {
    return {};
  }
  const command = extractQuotedJsonField(normalized, ["command", "cmd", "shell_command", "shellCommand"]);
  const cwd = extractQuotedJsonField(normalized, ["cwd", "working_directory", "workingDirectory", "dir", "directory"]);
  const directFilePath = extractQuotedJsonField(
    normalized,
    ["file_path", "filePath", "path", "filename", "notebook_path", "notebookPath"],
  );
  const listPaths = extractStringArrayJsonField(normalized, ["paths", "file_paths", "filePaths"]);
  const query = extractQuotedJsonField(normalized, ["query", "pattern", "url", "description", "prompt"]);
  const fileCandidates = [directFilePath, ...listPaths]
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  return {
    command,
    cwd,
    files: fileCandidates.length
      ? fileCandidates.slice(0, 8).map((path) => ({ path, change_type: "update" as const }))
      : undefined,
    searchTarget: query,
  };
}

function pickFirstString(
  value: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!value) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function flattenStringValues(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenStringValues(entry, depth + 1));
  }
  if (!isRecord(value)) {
    return [];
  }
  const preferredKeys = ["text", "summary", "message", "detail", "error", "output", "content"];
  const collected: string[] = [];
  for (const key of preferredKeys) {
    if (key in value) {
      collected.push(...flattenStringValues(value[key], depth + 1));
    }
  }
  return collected;
}

function extractToolResultSummary(result: unknown): string | undefined {
  const fragments = flattenStringValues(result);
  if (!fragments.length) {
    if (isRecord(result)) {
      return clipText(JSON.stringify(result), 280);
    }
    return clipText(result, 280);
  }
  return clipText(fragments.join(" "), 280);
}

function extractFilesFromInput(input: Record<string, unknown> | undefined): CliSessionActivityFile[] | undefined {
  if (!input) {
    return undefined;
  }
  const candidates = new Set<string>();
  const directKeys = ["file_path", "filePath", "path", "filename", "notebook_path", "notebookPath"];
  for (const key of directKeys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      candidates.add(value.trim());
    }
  }

  const listKeys = ["paths", "file_paths", "filePaths", "files"];
  for (const key of listKeys) {
    const value = input[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) {
        candidates.add(entry.trim());
        continue;
      }
      if (isRecord(entry)) {
        const path = pickFirstString(entry, ["path", "file_path", "filePath", "filename"]);
        if (path) {
          candidates.add(path);
        }
      }
    }
  }

  if (!candidates.size) {
    return undefined;
  }
  return [...candidates].slice(0, 8).map((path) => ({ path, change_type: "update" }));
}

function formatDurationMs(value: unknown): string | undefined {
  const durationMs = Number(value);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }
  if (durationMs < 1000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function buildTaskUsageSuffix(usage: unknown): string | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }
  const parts: string[] = [];
  const duration = formatDurationMs(usage.duration_ms);
  const toolUses = Number(usage.tool_uses);
  if (duration) {
    parts.push(duration);
  }
  if (Number.isFinite(toolUses) && toolUses >= 0) {
    parts.push(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
  }
  return parts.length ? parts.join(" · ") : undefined;
}

function joinSummaryParts(parts: Array<string | undefined>, maxLength = 300): string | undefined {
  const joined = parts
    .map((part) => clipText(part, maxLength))
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return clipText(joined, maxLength);
}

const CLAUDE_TOOL_VERBS: Record<string, string> = {
  read: "Reading",
  filereadtool: "Reading",
  write: "Writing",
  filewritetool: "Writing",
  edit: "Editing",
  multiedit: "Editing",
  fileedittool: "Editing",
  notebookedittool: "Editing notebook",
  bash: "Running",
  bashtool: "Running",
  terminal: "Running",
  grep: "Searching",
  greptool: "Searching",
  glob: "Searching",
  globtool: "Searching",
  websearch: "Searching",
  webfetch: "Fetching",
  task: "Running task",
};

function buildClaudeToolActivityInfo(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
  partialJson?: string,
  fallbackSummary?: string,
): ClaudeToolActivityInfo {
  const label = normalizeToolName(toolName);
  const normalizedLabel = label.toLowerCase();
  const mcpMatch = /^mcp__([^_]+(?:_[^_]+)*)__([^_].+)$/.exec(label);
  const server = mcpMatch?.[1]?.replace(/_/g, "-");
  const tool = mcpMatch?.[2]?.replace(/_/g, " ");
  const partialHints = extractToolHintsFromPartialJson(partialJson);
  const command = pickFirstString(input, ["command", "cmd", "shell_command", "shellCommand"])
    || partialHints.command;
  const cwd = pickFirstString(input, ["cwd", "working_directory", "workingDirectory", "dir", "directory"])
    || partialHints.cwd;
  const files = extractFilesFromInput(input) || partialHints.files;
  const searchTarget = pickFirstString(input, [
    "query",
    "pattern",
    "url",
    "description",
    "prompt",
  ]) || partialHints.searchTarget;
  const normalizedKey = normalizedLabel.replace(/[^a-z0-9]/g, "");
  const verb = CLAUDE_TOOL_VERBS[normalizedKey] || CLAUDE_TOOL_VERBS[normalizedLabel] || label;
  const target = command
    ? clipText(command, 140)
    : files?.[0]?.path
      ? `${files[0].path}${files.length > 1 ? ` (+${files.length - 1} more)` : ""}`
      : searchTarget;
  const summary = clipText(
    target
      ? `${verb} ${target}`
      : fallbackSummary
        || [server, tool].filter(Boolean).join(" / ")
        || label,
    280,
  );

  let kind = classifyToolActivityKind(label);
  if (command) {
    kind = "command_execution";
  } else if (files?.length) {
    kind = "file_change";
  } else if (server || normalizedLabel.startsWith("mcp__")) {
    kind = "mcp_tool_call";
  }

  return {
    kind,
    label,
    summary,
    server,
    tool: tool || (kind === "mcp_tool_call" ? label : undefined),
    command,
    cwd,
    files,
  };
}

function buildDefaultSchemaValue(schema: unknown): unknown {
  if (!isRecord(schema)) {
    return "";
  }
  const schemaType = String(schema.type || "").trim().toLowerCase();
  if (schemaType === "boolean") {
    return false;
  }
  if (schemaType === "integer" || schemaType === "number") {
    return 0;
  }
  if (schemaType === "array") {
    const minItems = Math.max(0, Number(schema.minItems) || 0);
    const itemValue = buildDefaultSchemaValue(schema.items);
    return Array.from({ length: minItems }, () => itemValue);
  }
  if (schemaType === "object") {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      result[key] = buildDefaultSchemaValue(value);
    }
    return result;
  }
  return "";
}

function buildClaudeElicitationContent(request: Record<string, unknown>): Record<string, unknown> {
  const requestedSchema = isRecord(request.requested_schema)
    ? request.requested_schema
    : (isRecord(request.requestedSchema) ? request.requestedSchema : null);
  const properties = requestedSchema && isRecord(requestedSchema.properties)
    ? requestedSchema.properties
    : null;
  if (!properties) {
    return {};
  }
  const content: Record<string, unknown> = {};
  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    content[fieldName] = buildDefaultSchemaValue(fieldSchema);
  }
  return content;
}

function writeJsonLine(stream: Writable | null | undefined, payload: Record<string, unknown>): void {
  if (!stream || stream.destroyed || stream.writableEnded) {
    return;
  }
  stream.write(`${JSON.stringify(payload)}\n`);
}

function buildClaudeUserMessagePayload(text: string): Record<string, unknown> | null {
  const normalized = String(text || "").replace(/\r/g, "").trim();
  if (!normalized) {
    return null;
  }
  return {
    type: "user",
    session_id: "",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: normalized,
        },
      ],
    },
    parent_tool_use_id: null,
  };
}

function createControlRequestId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildClaudeControlResponse(
  message: Record<string, unknown>,
): { response: Record<string, unknown>; logLine: string } | null {
  if (message.type !== "control_request") {
    return null;
  }
  const requestId = typeof message.request_id === "string" ? message.request_id.trim() : "";
  const request = isRecord(message.request) ? message.request : null;
  const subtype = String(request?.subtype || "").trim().toLowerCase();
  if (!requestId || !request || !subtype) {
    return null;
  }

  if (subtype === "can_use_tool") {
    const toolName = extractString(request, ["tool_name", "toolName"]) || "unknown_tool";
    const toolUseId = extractString(request, ["tool_use_id", "toolUseID"]);
    return {
      response: {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: {
            behavior: "allow",
            updatedInput: isRecord(request.input) ? request.input : {},
            ...(toolUseId ? { toolUseID: toolUseId } : {}),
          },
        },
      },
      logLine: `[claude-direct] Auto-approved tool permission for '${toolName}'.`,
    };
  }

  if (subtype === "elicitation") {
    const serverName = extractString(request, ["mcp_server_name", "server_name"]) || "unknown-server";
    return {
      response: {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: {
            action: "accept",
            content: buildClaudeElicitationContent(request),
          },
        },
      },
      logLine: `[claude-direct] Auto-accepted elicitation from '${serverName}'.`,
    };
  }

  return null;
}

class ClaudeDirectStreamParser {
  private readonly blocks = new Map<number, ClaudeContentBlockState>();
  private readonly toolStates = new Map<string, ClaudeToolState>();
  private lineBuffer = "";
  private sessionId?: string;
  private requestId?: string;
  private resultText?: string;
  private eventCount = 0;
  private ignoredLineCount = 0;
  private errorMessages: string[] = [];
  private emittedRunning = false;
  private partialAssistantText = "";
  private firstResultSeen = false;
  private lastSessionState: "idle" | "running" | "requires_action" | undefined;

  constructor(private readonly hooks: CliAdapterRunHooks) {}

  push(text: string): void {
    this.lineBuffer += text;
    while (true) {
      const newlineIndex = this.lineBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      this.consumeLine(line);
    }
  }

  hasFirstResult(): boolean {
    return this.firstResultSeen;
  }

  finalize(): ClaudeDirectResultEnvelope {
    const trailing = this.lineBuffer.trim();
    if (trailing) {
      this.consumeLine(trailing);
      this.lineBuffer = "";
    }
    return {
      resultText: this.resultText || this.partialAssistantText || "",
      sessionId: this.sessionId,
      requestId: this.requestId,
      rawResult: {
        session_id: this.sessionId || null,
        request_id: this.requestId || null,
        event_count: this.eventCount,
        result: this.resultText || this.partialAssistantText || null,
        errors: [...this.errorMessages],
        ignored_line_count: this.ignoredLineCount,
      },
    };
  }

  private consumeLine(line: string): void {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      this.eventCount += 1;
      this.captureIds(parsed);
      this.handleEvent(parsed);
    } catch {
      this.ignoredLineCount += 1;
    }
  }

  private captureIds(event: Record<string, unknown>): void {
    const sessionId = extractString(event, ["session_id", "sessionId", "conversation_id", "conversationId"]);
    const requestId = extractString(event, ["request_id", "requestId"]);
    if (!this.sessionId && sessionId) {
      this.sessionId = sessionId;
    }
    if (!this.requestId && requestId) {
      this.requestId = requestId;
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = String(event.type || "").trim().toLowerCase();
    if (!type || type === "ping") {
      return;
    }
    if (!this.emittedRunning) {
      this.emittedRunning = true;
      this.hooks.onNativeRuntime?.({
        at: nowIso(),
        active_turn_id: this.requestId,
        last_turn_id: this.requestId,
        phase: "running",
      });
    }

    if (type === "message_start" || type === "session.started" || type === "session_start") {
      this.emitTask("in_progress", "Response started", "Claude started responding.");
      return;
    }

    if (type === "assistant") {
      this.handleAssistantMessage(event);
      return;
    }

    if (type === "user") {
      this.handleUserMessage(event);
      return;
    }

    if (type === "system") {
      this.handleSystemMessage(event);
      return;
    }

    if (type === "stream_event") {
      const nested = isRecord(event.event) ? event.event : null;
      if (nested) {
        this.handleEvent(nested);
      }
      return;
    }

    if (type === "control_request") {
      this.handleControlRequest(event);
      return;
    }

    if (type === "control_cancel_request" || type === "control_response") {
      this.hooks.onNativeRuntime?.({
        at: nowIso(),
        active_turn_id: this.requestId,
        last_turn_id: this.requestId,
        thread_status_type: "active",
        thread_active_flags: [],
        phase: this.lastSessionState === "running" ? "running" : "idle",
      });
      return;
    }

    if (type === "tool_progress") {
      this.handleToolProgress(event);
      return;
    }

    if (type === "tool_use_summary") {
      const summary = extractString(event, ["summary"]) || "Claude finished a batch of tool work.";
      const precedingIds = Array.isArray(event.preceding_tool_use_ids)
        ? event.preceding_tool_use_ids
        : [];
      for (const entry of precedingIds) {
        if (typeof entry === "string" && entry.trim()) {
          this.resolveToolState(entry.trim(), "completed", summary);
        }
      }
      this.emitTask(
        "completed",
        "Tool summary",
        summary,
      );
      return;
    }

    if (type === "message_stop") {
      return;
    }

    if (type === "result") {
      this.firstResultSeen = true;
      const subtype = String(event.subtype || "").trim().toLowerCase();
      const resultText = extractString(event, ["result", "text", "message"]);
      if (resultText) {
        this.resultText = resultText;
      }
      if (subtype === "success") {
        this.resolveOutstandingTools("completed", resultText || "Tool completed.");
        this.emitTask("completed", "Completed", resultText || this.partialAssistantText || "Claude completed the task.");
      } else {
        const errorSummary = clipText(
          extractString(event, ["errors", "error", "message"])
            || (Array.isArray(event.errors) ? String(event.errors[0] || "") : "")
            || resultText
            || "Claude direct session failed.",
          360,
        ) || "Claude direct session failed.";
        this.errorMessages.push(errorSummary);
        this.resolveOutstandingTools("failed", errorSummary);
        this.emitTask("failed", "Error", errorSummary);
      }
      this.hooks.onNativeRuntime?.({
        at: nowIso(),
        active_turn_id: this.requestId,
        last_turn_id: this.requestId,
        turn_status: subtype === "success" ? "completed" : "failed",
        phase: subtype === "success"
          ? (this.lastSessionState === "idle" ? "completed" : "running")
          : "failed",
        last_error: subtype === "success" ? undefined : this.errorMessages[this.errorMessages.length - 1],
      });
      return;
    }

    if (type === "error") {
      const message = extractString(event, ["message", "error", "detail"]) || "Claude direct session failed.";
      this.errorMessages.push(message);
      this.resolveOutstandingTools("failed", message);
      this.emitTask("failed", "Error", message);
      this.hooks.onNativeRuntime?.({
        at: nowIso(),
        active_turn_id: this.requestId,
        last_turn_id: this.requestId,
        turn_status: "failed",
        phase: "failed",
        last_error: message,
      });
      return;
    }

    if (type === "content_block_start") {
      this.handleContentBlockStart(event);
      return;
    }

    if (type === "content_block_delta") {
      this.handleContentBlockDelta(event);
      return;
    }

    if (type === "content_block_stop") {
      this.handleContentBlockStop(event);
      return;
    }

    if (type === "message_delta") {
      const delta = isRecord(event.delta) ? event.delta : undefined;
      const stopReason = delta ? extractString(delta, ["stop_reason", "stopReason"]) : undefined;
      if (stopReason) {
        this.emitTask("in_progress", "Response updated", stopReason);
      }
    }
  }

  private handleAssistantMessage(event: Record<string, unknown>): void {
    const message = isRecord(event.message) ? event.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];
    let sawText = false;
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      const normalizedBlock = block as ClaudeSdkMessageContentBlock;
      const blockType = String(normalizedBlock.type || "").trim().toLowerCase();
      if (blockType === "text") {
        const text = clipText(normalizedBlock.text, 2000);
        if (text) {
          this.partialAssistantText = `${this.partialAssistantText || ""}${text}`;
          this.emitTask("in_progress", "Drafting response", text);
          sawText = true;
        }
        continue;
      }
      if (blockType === "thinking") {
        const thinking = clipText(normalizedBlock.thinking, 280) || "Thinking...";
        this.emitThinking("in_progress", thinking);
        continue;
      }
      if (isToolUseBlockType(blockType)) {
        this.trackToolFromBlock(block, "in_progress");
        continue;
      }
      if (isToolResultBlockType(blockType)) {
        this.resolveToolFromBlock(block);
      }
    }
    if (sawText) {
      this.hooks.onNativeRuntime?.({
        at: nowIso(),
        active_turn_id: this.requestId,
        last_turn_id: this.requestId,
        thread_status_type: "active",
        thread_active_flags: [],
        phase: "running",
      });
    }
  }

  private handleUserMessage(event: Record<string, unknown>): void {
    const message = isRecord(event.message) ? event.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];
    let sawToolResult = false;
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      const blockType = String(block.type || "").trim().toLowerCase();
      if (!isToolResultBlockType(blockType)) {
        continue;
      }
      sawToolResult = true;
      this.resolveToolFromBlock(block);
    }

    if (!sawToolResult) {
      const parentToolUseId = extractString(event, ["parent_tool_use_id", "parentToolUseId"]);
      if (parentToolUseId && Object.prototype.hasOwnProperty.call(event, "tool_use_result")) {
        const resultSummary = extractToolResultSummary(event.tool_use_result);
        this.resolveToolState(parentToolUseId, "completed", resultSummary);
      }
    }
  }

  private handleSystemMessage(event: Record<string, unknown>): void {
    const subtype = String(event.subtype || "").trim().toLowerCase();
    if (subtype === "init") {
      this.hooks.onNativeRuntime?.({
        at: nowIso(),
        thread_id: extractString(event, ["session_id", "sessionId"]) || this.sessionId,
        active_turn_id: this.requestId,
        last_turn_id: this.requestId,
        thread_status_type: "active",
        thread_active_flags: [],
        phase: "starting",
      });
      this.emitTask("in_progress", "Connected", "Claude direct session initialized.");
      return;
    }
    if (subtype === "session_state_changed") {
      const state = String(event.state || "").trim().toLowerCase() as "idle" | "running" | "requires_action";
      this.lastSessionState = state;
      if (state === "running") {
        this.hooks.onNativeRuntime?.({
          at: nowIso(),
          active_turn_id: this.requestId,
          last_turn_id: this.requestId,
          thread_status_type: "active",
          thread_active_flags: [],
          phase: "running",
        });
        return;
      }
      if (state === "requires_action") {
        this.hooks.onNativeRuntime?.({
          at: nowIso(),
          active_turn_id: this.requestId,
          last_turn_id: this.requestId,
          thread_status_type: "active",
          thread_active_flags: ["waitingOnApproval"],
          phase: "running",
        });
        return;
      }
      this.resolveOutstandingTools("completed");
      this.hooks.onNativeRuntime?.({
        at: nowIso(),
        active_turn_id: this.requestId,
        last_turn_id: this.requestId,
        thread_status_type: "idle",
        thread_active_flags: [],
        phase: this.firstResultSeen ? "completed" : "idle",
      });
      return;
    }
    if (subtype === "status") {
      const status = isRecord(event.status) ? event.status : null;
      const statusType = extractString(status || {}, ["type"]);
      const summary = clipText(
        extractString(status || {}, ["message", "summary", "detail"])
          || extractString(event, ["message", "description"]),
        280,
      );
      if (summary) {
        this.emitTask("in_progress", "Status", summary);
      }
      this.hooks.onNativeRuntime?.({
        at: nowIso(),
        active_turn_id: this.requestId,
        last_turn_id: this.requestId,
        thread_status_type: "active",
        thread_active_flags: statusType === "requires_action" ? ["waitingOnApproval"] : [],
        phase: statusType === "requires_action" ? "running" : normalizeRuntimePhase(this.lastSessionState === "running" ? "running" : "idle"),
      });
      return;
    }
    if (subtype === "task_started") {
      const toolUseId = extractString(event, ["tool_use_id", "toolUseID"]);
      if (toolUseId) {
        this.startToolState({
          id: toolUseId,
          type: "task",
          name: "Task",
        }, extractString(event, ["description", "prompt"]) || "Claude started a task.");
      }
      this.emitTask(
        "in_progress",
        "Task started",
        extractString(event, ["description", "prompt"]) || "Claude started a task.",
      );
      return;
    }
    if (subtype === "task_progress") {
      const toolUseId = extractString(event, ["tool_use_id", "toolUseID"]);
      const usageSuffix = buildTaskUsageSuffix(event.usage);
      const progressSummary = joinSummaryParts([
        extractString(event, ["summary", "description"]) || "Claude updated task progress.",
        extractString(event, ["last_tool_name"]) ? `Last tool: ${extractString(event, ["last_tool_name"])}` : undefined,
        usageSuffix,
      ], 300) || "Claude updated task progress.";
      if (toolUseId) {
        this.startToolState({
          id: toolUseId,
          type: "task",
          name: extractString(event, ["last_tool_name"]) || "Task",
        }, progressSummary);
      }
      this.emitTask(
        "in_progress",
        "Task progress",
        progressSummary,
      );
      return;
    }
    if (subtype === "task_notification") {
      const status = String(event.status || "").trim().toLowerCase();
      const toolUseId = extractString(event, ["tool_use_id", "toolUseID"]);
      const completionSummary = joinSummaryParts([
        extractString(event, ["summary"]) || "Claude finished a task.",
        buildTaskUsageSuffix(event.usage),
      ], 320) || "Claude finished a task.";
      if (toolUseId) {
        this.resolveToolState(
          toolUseId,
          status === "failed" ? "failed" : "completed",
          completionSummary,
        );
      }
      this.emitTask(
        status === "failed" ? "failed" : "completed",
        status === "failed" ? "Task failed" : "Task completed",
        completionSummary,
      );
      return;
    }
    if (subtype === "post_turn_summary") {
      const statusCategory = String(event.status_category || "").trim().toLowerCase();
      const summary = joinSummaryParts([
        extractString(event, ["title"]),
        extractString(event, ["description", "status_detail"]),
        extractString(event, ["recent_action"]) ? `Recent action: ${extractString(event, ["recent_action"])}` : undefined,
        extractString(event, ["needs_action"]) ? `Needs action: ${extractString(event, ["needs_action"])}` : undefined,
      ], 320) || "Claude updated the latest turn summary.";
      this.emitTask(
        statusCategory === "failed" || statusCategory === "blocked" ? "failed" : "completed",
        "Turn summary",
        summary,
      );
      return;
    }
    if (subtype === "local_command_output") {
      this.hooks.onActivity?.({
        at: nowIso(),
        turn_id: this.requestId,
        item_id: `command:${this.eventCount}`,
        kind: "command_execution",
        status: "in_progress",
        label: "Command",
        summary: clipText(extractString(event, ["content"]) || "Local command output", 280),
      });
      return;
    }
    if (subtype === "files_persisted") {
      const files = Array.isArray(event.files) ? event.files : [];
      const failedFiles = Array.isArray(event.failed) ? event.failed : [];
      const persistedSummary = joinSummaryParts([
        files.length
          ? `Persisted ${files.length} file${files.length === 1 ? "" : "s"}`
          : undefined,
        failedFiles.length
          ? `${failedFiles.length} failed`
          : undefined,
        extractString(event, ["processed_at"]) ? `Processed at ${extractString(event, ["processed_at"])}` : undefined,
      ], 240) || "Files persisted.";
      this.hooks.onActivity?.({
        at: nowIso(),
        turn_id: this.requestId,
        item_id: `files:${this.eventCount}`,
        kind: "file_change",
        status: "completed",
        label: "Files",
        summary: persistedSummary,
        files: files
          .filter(isRecord)
          .slice(0, 8)
          .map((file) => ({
            path: extractString(file, ["filename"]) || "unknown",
            change_type: "update" as const,
          })),
      });
      if (failedFiles.length) {
        this.emitTask(
          "failed",
          "File persist issue",
          joinSummaryParts([
            `Failed to persist ${failedFiles.length} file${failedFiles.length === 1 ? "" : "s"}`,
            failedFiles
              .filter(isRecord)
              .slice(0, 3)
              .map((file) => {
                const filename = extractString(file, ["filename"]) || "unknown";
                const error = extractString(file, ["error"]) || "unknown error";
                return `${filename}: ${error}`;
              })
              .join(" · "),
          ], 320) || "Claude reported file persistence failures.",
        );
      }
    }
  }

  private handleControlRequest(event: Record<string, unknown>): void {
    const request = isRecord(event.request) ? event.request : null;
    const subtype = String(request?.subtype || "").trim().toLowerCase();
    if (subtype === "can_use_tool") {
      const toolName = extractString(request || {}, ["tool_name", "toolName"]) || "Tool";
      this.startToolState(
        {
          id: extractString(request || {}, ["tool_use_id", "toolUseID"]) || `tool:${this.eventCount}`,
          type: "tool_use",
          name: toolName,
          input: isRecord(request?.input) ? request.input : undefined,
        },
        clipText(JSON.stringify(request?.input || {}), 280) || toolName,
      );
      return;
    }
    if (subtype === "elicitation") {
      const serverName = extractString(request || {}, ["mcp_server_name", "server_name"]) || "MCP";
      this.hooks.onActivity?.({
        at: nowIso(),
        turn_id: this.requestId,
        item_id: `mcp:${this.eventCount}`,
        kind: "mcp_tool_call",
        status: "in_progress",
        label: "MCP request",
        server: serverName,
        summary: clipText(extractString(request || {}, ["title", "description", "message"]) || "MCP elicitation", 280),
      });
    }
  }

  private handleToolProgress(event: Record<string, unknown>): void {
    const toolName = extractString(event, ["tool_name", "toolName"]) || "Tool";
    const elapsedSeconds = Number(event.elapsed_time_seconds);
    const toolUseId = extractString(event, ["tool_use_id", "toolUseID"]) || `${this.eventCount}`;
    this.startToolState(
      {
        id: toolUseId,
        type: "tool_use",
        name: toolName,
      },
      Number.isFinite(elapsedSeconds)
        ? `${toolName} running for ${Math.round(elapsedSeconds)}s`
        : `${toolName} is running`,
    );
  }

  private handleContentBlockStart(event: Record<string, unknown>): void {
    const index = Number(event.index);
    const block = isRecord(event.content_block) ? event.content_block : {};
    const type = String(block.type || "").trim().toLowerCase() || "unknown";
    const id = extractString(block, ["id"]) || `${type}:${Number.isFinite(index) ? index : this.blocks.size}`;
    const name = extractString(block, ["name", "tool_name", "toolName"]);
    const toolUseId = extractString(block, ["tool_use_id", "toolUseID"]);
    const input = isRecord(block.input) ? block.input : undefined;
    const state: ClaudeContentBlockState = { id, type, name, toolUseId, input };
    this.blocks.set(Number.isFinite(index) ? index : this.blocks.size, state);

    if (type === "thinking") {
      this.emitThinking("in_progress", "Thinking...");
      return;
    }
    if (isToolUseBlockType(type)) {
      this.startToolState(
        {
          id,
          type,
          name,
          input,
          toolUseId,
        },
        name || "Using tool",
      );
      return;
    }
    if (isToolResultBlockType(type) && toolUseId) {
      this.resolveToolState(toolUseId, Boolean(block.is_error) ? "failed" : "completed");
    }
  }

  private handleContentBlockDelta(event: Record<string, unknown>): void {
    const index = Number(event.index);
    const state = this.blocks.get(index);
    const delta = isRecord(event.delta) ? event.delta : undefined;
    if (!state || !delta) {
      return;
    }
    const deltaType = String(delta.type || "").trim().toLowerCase();

    if (deltaType === "thinking_delta") {
      state.thinking = appendRawDelta(state.thinking, extractRawString(delta, ["thinking"]));
      this.emitThinking("in_progress", state.thinking || "Thinking...");
      return;
    }

    if (deltaType === "text_delta") {
      const textDelta = extractRawString(delta, ["text"]);
      state.text = appendRawDelta(state.text, textDelta);
      this.partialAssistantText = appendRawDelta(this.partialAssistantText, textDelta) || this.partialAssistantText;
      this.emitTask("in_progress", "Drafting response", state.text || "Drafting response");
      return;
    }

    if (deltaType === "input_json_delta") {
      state.partialJson = appendRawDelta(
        state.partialJson,
        extractRawString(delta, ["partial_json", "partialJson"]),
      );
      this.startToolState(
        {
          id: state.id,
          type: state.type,
          name: state.name,
          input: state.input,
          partialJson: state.partialJson,
          toolUseId: state.toolUseId,
        },
        state.partialJson || state.name || "Using tool",
      );
      return;
    }
  }

  private handleContentBlockStop(event: Record<string, unknown>): void {
    const index = Number(event.index);
    const state = this.blocks.get(index);
    if (!state) {
      return;
    }
    if (state.type === "thinking") {
      this.emitThinking("completed", state.thinking || "Thinking");
      return;
    }
    if (isToolUseBlockType(state.type)) {
      this.startToolState(
        {
          id: state.id,
          type: state.type,
          name: state.name,
          input: state.input,
          partialJson: state.partialJson,
          toolUseId: state.toolUseId,
        },
        state.partialJson || state.name || "Using tool",
      );
      return;
    }
    if (state.type === "text") {
      this.emitTask("in_progress", "Drafting response", state.text || this.partialAssistantText || "Drafting response");
    }
  }

  private emitThinking(status: CliAdapterActivityEvent["status"], summary: string): void {
    this.hooks.onActivity?.({
      at: nowIso(),
      turn_id: this.requestId,
      item_id: "thinking:root",
      kind: "thinking",
      status,
      label: "Thinking",
      summary: clipText(summary, 280),
    });
  }

  private emitTask(status: CliAdapterActivityEvent["status"], label: string, summary?: string): void {
    this.hooks.onActivity?.({
      at: nowIso(),
      turn_id: this.requestId,
      item_id: "task:response",
      kind: "task",
      status,
      label,
      summary: clipText(summary, status === "completed" ? 360 : 280),
    });
  }

  private startToolState(state: ClaudeToolState, summary?: string): void {
    const next = this.upsertToolState(state);
    this.emitTool(next, "in_progress", summary);
  }

  private upsertToolState(state: ClaudeToolState): ClaudeToolState {
    const existing = this.toolStates.get(state.id);
    const next: ClaudeToolState = {
      ...(existing || {}),
      ...state,
      name: state.name || existing?.name,
      input: state.input || existing?.input || safeParseJsonRecord(state.partialJson) || safeParseJsonRecord(existing?.partialJson),
      partialJson: state.partialJson ?? existing?.partialJson,
      toolUseId: state.toolUseId || existing?.toolUseId,
      resolved: state.resolved ?? existing?.resolved ?? false,
    };
    this.toolStates.set(next.id, next);
    if (next.toolUseId && next.toolUseId !== next.id) {
      this.toolStates.set(next.toolUseId, next);
    }
    return next;
  }

  private resolveToolState(
    toolId: string,
    status: Extract<CliAdapterActivityEvent["status"], "completed" | "failed">,
    summary?: string,
  ): void {
    const key = String(toolId || "").trim();
    if (!key) {
      return;
    }
    const existing = this.toolStates.get(key) || {
      id: key,
      type: "tool_use",
    };
    const resolved = this.upsertToolState({
      ...existing,
      id: key,
      resolved: true,
    });
    this.emitTool(resolved, status, summary);
  }

  private resolveOutstandingTools(
    status: Extract<CliAdapterActivityEvent["status"], "completed" | "failed">,
    summary?: string,
  ): void {
    const seen = new Set<string>();
    for (const state of this.toolStates.values()) {
      if (!state || state.resolved) {
        continue;
      }
      if (seen.has(state.id)) {
        continue;
      }
      seen.add(state.id);
      this.resolveToolState(state.id, status, summary);
    }
  }

  private trackToolFromBlock(
    block: Record<string, unknown>,
    status: Extract<CliAdapterActivityEvent["status"], "in_progress" | "completed" | "failed">,
  ): void {
    const blockType = String(block.type || "").trim().toLowerCase() || "tool_use";
    const toolId = extractString(block, ["id", "tool_use_id", "toolUseID"]) || `tool:${this.eventCount}`;
    const state = this.upsertToolState({
      id: toolId,
      type: blockType,
      name: extractString(block, ["name", "tool_name", "toolName"]),
      input: isRecord(block.input) ? block.input : undefined,
      toolUseId: extractString(block, ["tool_use_id", "toolUseID"]),
      resolved: status !== "in_progress",
    });
    this.emitTool(
      state,
      status,
      extractToolResultSummary(block.content)
        || extractToolResultSummary(block.input)
        || extractString(block, ["summary", "message"]),
    );
  }

  private resolveToolFromBlock(block: Record<string, unknown>): void {
    const toolUseId = extractString(block, ["tool_use_id", "toolUseID", "id"]);
    if (!toolUseId) {
      return;
    }
    const summary = extractToolResultSummary(block.content)
      || extractToolResultSummary(block.message)
      || extractString(block, ["summary", "message", "error"]);
    this.resolveToolState(
      toolUseId,
      Boolean(block.is_error) ? "failed" : "completed",
      summary,
    );
  }

  private emitTool(
    state: ClaudeToolState,
    status: CliAdapterActivityEvent["status"],
    summary?: string,
  ): void {
    const input = state.input || safeParseJsonRecord(state.partialJson);
    const info = buildClaudeToolActivityInfo(
      state.name,
      input,
      state.partialJson,
      summary || state.partialJson || state.name,
    );
    this.hooks.onActivity?.({
      at: nowIso(),
      turn_id: this.requestId,
      item_id: `tool:${state.id}`,
      kind: info.kind,
      status,
      label: info.label,
      summary: clipText(summary || info.summary || state.name || "Using tool", 280),
      server: info.server,
      tool: info.tool || state.name,
      command: info.command,
      cwd: info.cwd,
      files: info.files,
    });
  }
}

class ClaudeDirectExecutor implements ClaudeDirectCommandExecutor {
  async run(
    request: ClaudeDirectCommandRequest,
    hooks: CliAdapterRunHooks,
  ): Promise<ClaudeDirectCommandExecutionResult> {
    return await new Promise<ClaudeDirectCommandExecutionResult>((resolve, reject) => {
      const resumeSessionId = String(request.env?.[CLAUDE_SESSION_ID_ENV_VAR] || "").trim();
      const requestedModel = String(request.model || "").trim();
      const requestedPermissionMode = String(request.permissionMode || "").trim();
      const skipPermissions =
        requestedPermissionMode === "bypassPermissions"
        || requestedPermissionMode === "dontAsk";
      const claudeArgs = [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--permission-prompt-tool",
        "stdio",
        "--include-partial-messages",
        ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
        ...(requestedModel ? ["--model", requestedModel] : []),
        ...(requestedPermissionMode ? ["--permission-mode", requestedPermissionMode] : []),
        ...(skipPermissions ? ["--dangerously-skip-permissions"] : []),
      ];

      const env = { ...process.env, ...(request.env || {}) };
      const isWindows = process.platform === "win32";
      const isPowerShellShim = isWindows && /\.ps1$/i.test(request.command);
      const command = isWindows && isPowerShellShim ? WINDOWS_POWERSHELL : request.command;
      const args = isWindows
        ? (isPowerShellShim
          ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", request.command, ...claudeArgs]
          : claudeArgs)
        : claudeArgs;

      if (isWindows) {
        const commandDir = dirname(request.command);
        if (commandDir && commandDir !== "." && existsSync(commandDir)) {
          const currentPath = String(env.Path || env.PATH || "");
          if (!currentPath.toLowerCase().includes(commandDir.toLowerCase())) {
            env.Path = `${commandDir};${currentPath}`;
            env.PATH = env.Path;
          }
        }
      }

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, args, {
          cwd: request.workspace,
          env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error);
        return;
      }

      const streamParser = new ClaudeDirectStreamParser(hooks);
      let stdout = "";
      let stderr = "";
      let stdoutLineBuffer = "";
      let settled = false;
      let childExited = false;
      let interruptSent = false;
      let forceKillTimer: NodeJS.Timeout | null = null;
      let initialPromptSent = false;

      const finalize = (result: ClaudeDirectCommandExecutionResult) => {
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

      const clearForceKillTimer = () => {
        if (!forceKillTimer) {
          return;
        }
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      };

      const sendUserPrompt = (text: string) => {
        const payload = buildClaudeUserMessagePayload(text);
        if (!payload || childExited) {
          return false;
        }
        writeJsonLine(child.stdin, payload);
        hooks.onNativeRuntime?.({
          at: nowIso(),
          active_turn_id: undefined,
          last_turn_id: undefined,
          thread_status_type: "active",
          thread_active_flags: [],
          phase: "running",
        });
        return true;
      };

      const requestStop = () => {
        if (childExited) {
          return;
        }
        if (!interruptSent) {
          interruptSent = true;
          writeJsonLine(child.stdin, {
            type: "control_request",
            request_id: createControlRequestId("interrupt"),
            request: {
              subtype: "interrupt",
            },
          });
          hooks.onNativeRuntime?.({
            at: nowIso(),
            active_turn_id: undefined,
            last_turn_id: undefined,
            phase: "interrupting",
          });
        }
        if (!forceKillTimer) {
          forceKillTimer = setTimeout(() => {
            if (childExited) {
              return;
            }
            terminateChildProcessTree(child);
          }, 1500);
        }
      };

      hooks.onControls({
        kill: requestStop,
        write: (text) => {
          sendUserPrompt(text);
        },
      });

      if (typeof child.pid === "number" && child.pid > 0) {
        hooks.onProcessStart(child.pid);
      }

      writeJsonLine(child.stdin, {
        type: "control_request",
        request_id: createControlRequestId("init"),
        request: {
          subtype: "initialize",
        },
      });

      initialPromptSent = sendUserPrompt(request.prompt);

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        stdoutLineBuffer += text;
        while (true) {
          const newlineIndex = stdoutLineBuffer.indexOf("\n");
          if (newlineIndex === -1) {
            break;
          }
          const line = stdoutLineBuffer.slice(0, newlineIndex).trim();
          stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
          if (!line) {
            continue;
          }
          const parsed = (() => {
            try {
              return JSON.parse(line) as Record<string, unknown>;
            } catch {
              return null;
            }
          })();
          if (parsed) {
            const controlResponse = buildClaudeControlResponse(parsed);
            if (controlResponse) {
              writeJsonLine(child.stdin, controlResponse.response);
              hooks.onOutput("stderr", `${controlResponse.logLine}\n`);
            }
          }
          streamParser.push(`${line}\n`);
        }
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
        childExited = true;
        clearForceKillTimer();
        const trailingLine = stdoutLineBuffer.trim();
        if (trailingLine) {
          const parsed = (() => {
            try {
              return JSON.parse(trailingLine) as Record<string, unknown>;
            } catch {
              return null;
            }
          })();
          if (parsed) {
            const controlResponse = buildClaudeControlResponse(parsed);
            if (controlResponse) {
              hooks.onOutput("stderr", `${controlResponse.logLine}\n`);
            }
          }
          streamParser.push(`${trailingLine}\n`);
        }
        const parsed = streamParser.finalize();
        const mergedStdout = stdout.trim() ? stdout : JSON.stringify(parsed.rawResult || {});
        finalize({
          exitCode: typeof code === "number" ? code : null,
          stdout: mergedStdout,
          stderr,
        });
      });

      hooks.signal.addEventListener(
        "abort",
        () => {
          requestStop();
        },
        { once: true },
      );

      if (!initialPromptSent && String(request.prompt || "").trim()) {
        hooks.onOutput(
          "stderr",
          "[claude-direct] Initial prompt was empty after normalization and was not sent.\n",
        );
      }
    });
  }
}

export function collectClaudeDirectStream(stdout: string): ClaudeDirectCollectedStream {
  const lines = String(stdout || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const activities: CliAdapterActivityEvent[] = [];
  const runtimeEvents: CliAdapterNativeRuntimeEvent[] = [];
  const parser = new ClaudeDirectStreamParser({
    signal: new AbortController().signal,
    onOutput: () => {},
    onActivity: (activity) => {
      activities.push({ ...activity });
    },
    onNativeRuntime: (event) => {
      runtimeEvents.push({ ...event });
    },
    onProcessStart: () => {},
    onControls: () => {},
  });
  for (const line of lines) {
    parser.push(`${line}\n`);
  }
  return {
    envelope: parser.finalize(),
    activities,
    runtimeEvents,
  };
}

export function parseClaudeDirectResult(stdout: string): ClaudeDirectResultEnvelope {
  return collectClaudeDirectStream(stdout).envelope;
}

export class ClaudeDirectAdapter implements CliSessionAdapter {
  readonly adapterId = "claude" as const;
  readonly mode = "direct" as const;
  readonly supportsInput = true;
  readonly supportsRestart = true;
  readonly supportsResize = false;
  readonly requiresPrompt = true;

  constructor(
    private readonly executor: ClaudeDirectCommandExecutor = new ClaudeDirectExecutor(),
    private readonly command = resolveClaudeCommand(),
  ) {}

  async run(input: CliAdapterRunInput, hooks: CliAdapterRunHooks): Promise<CliAdapterRunResult> {
    const workspace = normalizeWorkspacePath(input.workspace);
    let execution: ClaudeDirectCommandExecutionResult;
    try {
      execution = await this.executor.run(
        {
          command: this.command,
          prompt: input.prompt,
          workspace,
          model: input.model,
          permissionMode: input.permissionMode,
          env: input.env,
        },
        hooks,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Claude direct launch failed via '${this.command}': ${detail}`);
    }

    const parsed = parseClaudeDirectResult(execution.stdout);
    const persistedSessionId = String(input.env?.[CLAUDE_SESSION_ID_ENV_VAR] || "").trim() || undefined;

    return {
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      resultText: parsed.resultText,
      rawResult: parsed.rawResult,
      externalSessionId: parsed.sessionId || persistedSessionId,
      externalRequestId: parsed.requestId,
    };
  }
}
