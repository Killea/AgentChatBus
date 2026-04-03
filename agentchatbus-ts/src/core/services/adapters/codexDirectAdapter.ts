import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import spawn from "cross-spawn";
import { BUS_VERSION } from "../../config/env.js";
import type {
  CliAdapterActivityEvent,
  CliAdapterNativeRuntimeEvent,
  CliSessionActivityFile,
  CliSessionActivityPlanStep,
  CliSessionAdapter,
  CliAdapterRunInput,
  CliAdapterRunHooks,
  CliAdapterRunResult,
} from "./types.js";
import { WINDOWS_POWERSHELL } from "./constants.js";
import { normalizeWorkspacePath, terminateChildProcessTree } from "./utils.js";
import { CODEX_THREAD_ID_ENV_VAR, resolveCodexHeadlessCommand } from "./codexHeadlessAdapter.js";

type JsonRpcId = string | number;

type CodexDirectCommandRequest = {
  command: string;
  prompt: string;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  env?: Record<string, string>;
};

type CodexDirectCommandExecutionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type CodexDirectResultEnvelope = {
  resultText?: string;
  rawResult?: Record<string, unknown> | null;
  threadId?: string;
  turnId?: string;
};

const CODEX_DIRECT_APPROVAL_POLICY = {
  granular: {
    sandbox_approval: false,
    rules: false,
    mcp_elicitations: false,
    request_permissions: false,
    skill_approval: false,
  },
} as const;

interface CodexDirectCommandExecutor {
  run(
    request: CodexDirectCommandRequest,
    hooks: CliAdapterRunHooks,
  ): Promise<CodexDirectCommandExecutionResult>;
}

type JsonRpcResponseEnvelope = {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function splitOutputLines(value: string): string[] {
  return String(value || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractJsonRpcId(value: unknown): JsonRpcId | undefined {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return undefined;
}

function extractThreadIdFromPayload(value: unknown): string | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  if (typeof value.threadId === "string" && value.threadId.trim()) {
    return value.threadId.trim();
  }
  if (typeof value.thread_id === "string" && value.thread_id.trim()) {
    return value.thread_id.trim();
  }
  if (typeof value.conversationId === "string" && value.conversationId.trim()) {
    return value.conversationId.trim();
  }
  if (typeof value.conversation_id === "string" && value.conversation_id.trim()) {
    return value.conversation_id.trim();
  }
  if (isObjectRecord(value.thread) && typeof value.thread.id === "string" && value.thread.id.trim()) {
    return value.thread.id.trim();
  }
  if (isObjectRecord(value.conversation) && typeof value.conversation.id === "string" && value.conversation.id.trim()) {
    return value.conversation.id.trim();
  }
  return undefined;
}

function extractTurnIdFromPayload(value: unknown): string | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  if (typeof value.turnId === "string" && value.turnId.trim()) {
    return value.turnId.trim();
  }
  if (typeof value.turn_id === "string" && value.turn_id.trim()) {
    return value.turn_id.trim();
  }
  if (isObjectRecord(value.turn) && typeof value.turn.id === "string" && value.turn.id.trim()) {
    return value.turn.id.trim();
  }
  return undefined;
}

function extractItemText(value: unknown): string | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  if (value.type !== "agentMessage" || typeof value.text !== "string") {
    return undefined;
  }
  return value.text;
}

function extractItemId(value: unknown): string | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  if (typeof value.id === "string" && value.id.trim()) {
    return value.id.trim();
  }
  if (typeof value.itemId === "string" && value.itemId.trim()) {
    return value.itemId.trim();
  }
  if (typeof value.item_id === "string" && value.item_id.trim()) {
    return value.item_id.trim();
  }
  return undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clipActivityContent(value: unknown, maxLength = 4000): string | undefined {
  const normalized = String(value || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function clipActivityText(value: unknown, maxLength = 260): string | undefined {
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

function appendActivityDelta(previous: string | undefined, delta: string | undefined, maxLength = 260): string | undefined {
  const addition = clipActivityText(delta, maxLength);
  if (!addition) {
    return previous;
  }
  const current = clipActivityText(previous, maxLength);
  if (!current) {
    return addition;
  }
  if (current.includes(addition)) {
    return current;
  }
  return clipActivityText(`${current} ${addition}`, maxLength);
}

function appendActivityContent(previous: string | undefined, delta: string | undefined, maxLength = 4000): string | undefined {
  const addition = clipActivityContent(delta, maxLength);
  if (!addition) {
    return clipActivityContent(previous, maxLength);
  }
  const current = clipActivityContent(previous, maxLength);
  if (!current) {
    return addition;
  }
  return clipActivityContent(`${current}${addition}`, maxLength);
}

function extractDirectString(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (
      (typeof candidate === "number" || typeof candidate === "boolean")
      && String(candidate).trim()
    ) {
      return String(candidate).trim();
    }
  }
  return undefined;
}

function extractCodexEventActivityItemId(
  params: Record<string, unknown>,
  prefix: string,
  fallbackTurnId?: string,
  fallbackThreadId?: string,
): string {
  return extractItemId(params)
    || `${prefix}:${extractTurnIdFromPayload(params) || fallbackTurnId || extractThreadIdFromPayload(params) || fallbackThreadId || "unknown"}`;
}

function extractCodexEventSummary(
  params: Record<string, unknown>,
  maxLength = 260,
): string | undefined {
  return clipActivityText(
    extractDirectString(params, [
      "summary",
      "message",
      "text",
      "delta",
      "content",
      "description",
      "detail",
      "statusText",
      "reason",
    ]),
    maxLength,
  );
}

function extractCodexEventToolServer(params: Record<string, unknown>): string | undefined {
  return extractDirectString(params, ["server", "serverName", "mcpServer", "mcp_server"]);
}

function extractCodexEventToolName(params: Record<string, unknown>): string | undefined {
  return extractDirectString(params, ["tool", "toolName", "name", "functionName", "method"]);
}

function extractCodexEventCommand(params: Record<string, unknown>): string | undefined {
  return extractDirectString(params, ["command", "cmd"]);
}

function extractCodexEventCwd(params: Record<string, unknown>): string | undefined {
  return extractDirectString(params, ["cwd", "workingDirectory", "working_directory"]);
}

function extractCodexEventError(params: Record<string, unknown>, fallbackMethod?: string): string | undefined {
  if (params.error !== undefined && params.error !== null) {
    return formatCodexErrorSummary(params.error, fallbackMethod);
  }
  const direct = extractDirectString(params, ["message", "errorMessage", "reason", "detail"]);
  return direct ? clipActivityText(direct, 260) : undefined;
}

function extractCodexEventActivityStatus(
  params: Record<string, unknown>,
  fallback: CliAdapterActivityEvent["status"] = "completed",
): CliAdapterActivityEvent["status"] {
  if (params.status !== undefined) {
    return normalizeActivityStatus(params.status);
  }
  if (params.success === false || params.error !== undefined && params.error !== null) {
    return "failed";
  }
  return fallback;
}

function extractCodexEventOutputDelta(params: Record<string, unknown>): string | undefined {
  return extractDirectString(params, ["delta", "text", "output", "content"]);
}

function normalizeActivityStatus(value: unknown): CliAdapterActivityEvent["status"] {
  switch (String(value || "").trim()) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    default:
      return "in_progress";
  }
}

function normalizePlanStepStatus(value: unknown): CliSessionActivityPlanStep["status"] {
  switch (String(value || "").trim()) {
    case "completed":
      return "completed";
    case "pending":
      return "pending";
    default:
      return "inProgress";
  }
}

function extractPatchChangeType(value: unknown): CliSessionActivityFile["change_type"] | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  const nextType = String(value.type || "").trim();
  if (nextType === "add" || nextType === "delete" || nextType === "update") {
    return nextType;
  }
  return undefined;
}

function extractThreadStatusFromPayload(value: unknown): Pick<
  CliAdapterNativeRuntimeEvent,
  "thread_status_type" | "thread_active_flags"
> {
  const status = isObjectRecord(value)
    ? (
      isObjectRecord(value.status)
        ? value.status
        : (isObjectRecord(value.thread) && isObjectRecord(value.thread.status) ? value.thread.status : null)
    )
    : null;
  if (!status || typeof status.type !== "string") {
    return {};
  }
  const threadStatusType = ["notLoaded", "idle", "systemError", "active"].includes(status.type)
    ? status.type as CliAdapterNativeRuntimeEvent["thread_status_type"]
    : undefined;
  const threadActiveFlags = Array.isArray(status.activeFlags)
    ? status.activeFlags
      .map((entry) => String(entry || "").trim())
      .filter((entry): entry is NonNullable<CliAdapterNativeRuntimeEvent["thread_active_flags"]>[number] =>
        entry === "waitingOnApproval" || entry === "waitingOnUserInput")
    : undefined;
  return {
    thread_status_type: threadStatusType,
    thread_active_flags: threadActiveFlags,
  };
}

function normalizeTurnStatus(value: unknown): CliAdapterNativeRuntimeEvent["turn_status"] {
  const normalized = String(value || "").trim();
  if (
    normalized === "completed"
    || normalized === "interrupted"
    || normalized === "failed"
    || normalized === "inProgress"
  ) {
    return normalized;
  }
  return undefined;
}

function phaseFromTurnStatus(value: CliAdapterNativeRuntimeEvent["turn_status"]): CliAdapterNativeRuntimeEvent["phase"] {
  if (value === "completed" || value === "interrupted" || value === "failed") {
    return value;
  }
  if (value === "inProgress") {
    return "running";
  }
  return undefined;
}

function extractActivityFiles(value: unknown): CliSessionActivityFile[] | undefined {
  if (!isObjectRecord(value) || !Array.isArray(value.changes)) {
    return undefined;
  }
  const files: CliSessionActivityFile[] = [];
  for (const entry of value.changes) {
    if (!isObjectRecord(entry) || typeof entry.path !== "string" || !entry.path.trim()) {
      continue;
    }
    const changeKind = isObjectRecord(entry.kind) ? entry.kind : null;
    files.push({
      path: entry.path.trim(),
      change_type: extractPatchChangeType(changeKind),
      move_path: changeKind && typeof changeKind.move_path === "string"
        ? changeKind.move_path.trim() || null
        : undefined,
    });
  }
  return files.length ? files : undefined;
}

function extractPlanSteps(value: unknown): CliSessionActivityPlanStep[] | undefined {
  if (!isObjectRecord(value) || !Array.isArray(value.plan)) {
    return undefined;
  }
  const steps = value.plan
    .map((entry) => {
      if (!isObjectRecord(entry) || typeof entry.step !== "string" || !entry.step.trim()) {
        return null;
      }
      return {
        step: entry.step.trim(),
        status: normalizePlanStepStatus(entry.status),
      } satisfies CliSessionActivityPlanStep;
    })
    .filter((entry): entry is CliSessionActivityPlanStep => Boolean(entry));
  return steps.length ? steps : undefined;
}

function summarizePlanSteps(steps: CliSessionActivityPlanStep[] | undefined): string | undefined {
  if (!Array.isArray(steps) || !steps.length) {
    return undefined;
  }
  const inProgress = steps.find((entry) => entry.status === "inProgress");
  if (inProgress) {
    return clipActivityText(inProgress.step, 220);
  }
  const completedCount = steps.filter((entry) => entry.status === "completed").length;
  return clipActivityText(`${completedCount}/${steps.length} plan step(s) completed`, 220);
}

function extractReasoningSummary(value: unknown): string | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  if (Array.isArray(value.summary)) {
    const summary = value.summary
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .join(" ");
    if (summary) {
      return clipActivityText(summary, 260);
    }
  }
  if (Array.isArray(value.content)) {
    const fallback = value.content
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .join(" ");
    if (fallback) {
      return clipActivityText(fallback, 260);
    }
  }
  return undefined;
}

function summarizeMcpToolCallItem(item: Record<string, unknown>): string | undefined {
  const directError = isObjectRecord(item.error) ? item.error.message : undefined;
  const errorSummary = clipActivityText(directError, 260);
  if (errorSummary) {
    return errorSummary;
  }
  const status = normalizeActivityStatus(item.status);
  if (status === "failed") {
    return "Tool call failed";
  }
  if (status === "completed") {
    return "Tool call completed";
  }
  return undefined;
}

function summarizeCommandExecutionItem(item: Record<string, unknown>): string | undefined {
  const aggregatedOutput = clipActivityText(item.aggregatedOutput, 260);
  if (aggregatedOutput) {
    return aggregatedOutput;
  }
  const status = normalizeActivityStatus(item.status);
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : undefined;
  if (status === "failed") {
    return typeof exitCode === "number"
      ? `Command failed with exit code ${exitCode}`
      : "Command failed";
  }
  if (status === "completed") {
    return typeof exitCode === "number"
      ? `Command completed with exit code ${exitCode}`
      : "Command completed";
  }
  if (status === "declined") {
    return "Command declined";
  }
  return undefined;
}

function summarizeFileChangeItem(
  item: Record<string, unknown>,
  files: CliSessionActivityFile[] | undefined,
): string | undefined {
  const status = normalizeActivityStatus(item.status);
  if (status === "failed") {
    return "File changes failed";
  }
  if (status === "declined") {
    return "File changes declined";
  }
  const summary = clipActivityText(
    files?.length
      ? files.slice(0, 3).map((entry) => entry.path).join(", ")
      : undefined,
    220,
  );
  if (summary) {
    return summary;
  }
  if (status === "completed") {
    return files?.length
      ? `Updated ${files.length} file${files.length === 1 ? "" : "s"}`
      : "File changes completed";
  }
  return "Updating files";
}

export function buildCodexDirectActivityFromItem(
  item: unknown,
  fallbackTurnId?: string,
): CliAdapterActivityEvent | null {
  if (!isObjectRecord(item)) {
    return null;
  }
  const itemId = extractItemId(item);
  if (!itemId) {
    return null;
  }
  const turnId = fallbackTurnId;
  const type = String(item.type || "").trim();
  const status = normalizeActivityStatus(item.status);
  const startedAt = extractDirectString(item, ["startedAt", "started_at", "createdAt", "created_at"]);
  const completedAt = status !== "in_progress"
    ? extractDirectString(item, ["completedAt", "completed_at", "finishedAt", "finished_at", "updatedAt", "updated_at"])
      || nowIso()
    : undefined;
  if (type === "reasoning") {
    return {
      at: nowIso(),
      turn_id: turnId,
      item_id: itemId,
      kind: "thinking",
      status,
      label: "Thinking",
      summary: extractReasoningSummary(item) || "Working through the next steps",
      started_at: startedAt,
      completed_at: completedAt,
    };
  }
  if (type === "agentMessage") {
    const content = clipActivityContent(item.text, 6_000);
    return {
      at: nowIso(),
      turn_id: turnId,
      item_id: itemId,
      kind: "agent_message",
      status,
      label: "Message",
      summary: clipActivityText(content, 320),
      content,
      started_at: startedAt,
      completed_at: completedAt,
    };
  }
  if (type === "plan") {
    const planSummary = clipActivityText(item.text, 220);
    return {
      at: nowIso(),
      turn_id: turnId,
      item_id: itemId,
      kind: "plan",
      status,
      label: "Thinking",
      summary: planSummary || "Updating plan",
      started_at: startedAt,
      completed_at: completedAt,
    };
  }
  if (type === "mcpToolCall") {
    return {
      at: nowIso(),
      turn_id: turnId,
      item_id: itemId,
      kind: "mcp_tool_call",
      status,
      label: "Using tool",
      server: typeof item.server === "string" ? item.server.trim() || undefined : undefined,
      tool: typeof item.tool === "string" ? item.tool.trim() || undefined : undefined,
      summary: summarizeMcpToolCallItem(item),
      started_at: startedAt,
      completed_at: completedAt,
    };
  }
  if (type === "dynamicToolCall") {
    return {
      at: nowIso(),
      turn_id: turnId,
      item_id: itemId,
      kind: "dynamic_tool_call",
      status,
      label: "Using tool",
      tool: typeof item.tool === "string" ? item.tool.trim() || undefined : undefined,
      summary: clipActivityText(item.success === false ? "Tool call failed" : undefined, 220),
      started_at: startedAt,
      completed_at: completedAt,
    };
  }
  if (type === "commandExecution") {
    return {
      at: nowIso(),
      turn_id: turnId,
      item_id: itemId,
      kind: "command_execution",
      status,
      label: "Running command",
      command: typeof item.command === "string" ? item.command.trim() || undefined : undefined,
      cwd: typeof item.cwd === "string" ? item.cwd.trim() || undefined : undefined,
      summary: summarizeCommandExecutionItem(item),
      content: clipActivityContent(item.aggregatedOutput, 3_000),
      started_at: startedAt,
      completed_at: completedAt,
    };
  }
  if (type === "fileChange") {
    const files = extractActivityFiles(item);
    const firstChange = Array.isArray(item.changes) && isObjectRecord(item.changes[0])
      ? item.changes[0]
      : null;
    return {
      at: nowIso(),
      turn_id: turnId,
      item_id: itemId,
      kind: "file_change",
      status,
      label: "Editing files",
      files,
      diff: files?.[0]?.path ? clipActivityText(firstChange?.diff, 600) : undefined,
      summary: summarizeFileChangeItem(item, files),
      started_at: startedAt,
      completed_at: completedAt,
    };
  }
  return null;
}

function normalizeRpcError(error: unknown, fallbackMethod?: string): Error {
  if (isObjectRecord(error)) {
    const message = typeof error.message === "string" && error.message.trim()
      ? error.message.trim()
      : `Codex app-server request${fallbackMethod ? ` '${fallbackMethod}'` : ""} failed`;
    const codeSuffix = typeof error.code === "number" ? ` (code ${error.code})` : "";
    return new Error(`${message}${codeSuffix}`);
  }
  return new Error(
    `Codex app-server request${fallbackMethod ? ` '${fallbackMethod}'` : ""} failed: ${String(error)}`,
  );
}

function normalizeServerRequestLabel(method: string): string {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command execution approval";
    case "item/fileChange/requestApproval":
      return "file change approval";
    case "item/permissions/requestApproval":
      return "permissions approval";
    case "item/tool/requestUserInput":
      return "tool user input";
    case "item/tool/call":
      return "dynamic tool call";
    default:
      return method;
  }
}

function formatUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

function appendUniqueSummaryLine(target: string[], value: unknown, label?: string): void {
  if (value === null || value === undefined) {
    return;
  }
  const normalized = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
  if (!normalized.trim()) {
    return;
  }
  for (const line of normalized.split(/\r?\n/g).map((entry) => entry.trim()).filter(Boolean)) {
    const candidate = label ? `${label}: ${line}` : line;
    if (!target.includes(candidate)) {
      target.push(candidate);
    }
  }
}

function tryStringifyCompact(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized && serialized !== "{}" && serialized !== "[]") {
      return serialized;
    }
  } catch {
    // Ignore circular or unserializable payloads.
  }
  return undefined;
}

function isCodexStdinUnavailableError(error: unknown): boolean {
  return /stdin is unavailable/i.test(error instanceof Error ? error.message : String(error));
}

function formatCodexErrorSummary(error: unknown, fallbackMethod?: string): string {
  const lines: string[] = [];

  const visit = (value: unknown, depth = 0): void => {
    if (depth > 3 || value === null || value === undefined) {
      return;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      appendUniqueSummaryLine(lines, value);
      return;
    }
    if (!isObjectRecord(value)) {
      const serialized = tryStringifyCompact(value);
      if (serialized) {
        appendUniqueSummaryLine(lines, serialized);
      }
      return;
    }

    appendUniqueSummaryLine(lines, value.message);
    if (typeof value.httpStatusCode === "number") {
      appendUniqueSummaryLine(lines, value.httpStatusCode, "HTTP status");
    } else if (typeof value.statusCode === "number") {
      appendUniqueSummaryLine(lines, value.statusCode, "HTTP status");
    } else if (typeof value.status === "number") {
      appendUniqueSummaryLine(lines, value.status, "status");
    }
    if (typeof value.code === "number" || typeof value.code === "string") {
      appendUniqueSummaryLine(lines, value.code, "code");
    }
    if (typeof value.type === "string") {
      appendUniqueSummaryLine(lines, value.type, "type");
    }
    appendUniqueSummaryLine(lines, value.additionalDetails, "details");
    appendUniqueSummaryLine(lines, value.details, "details");
    appendUniqueSummaryLine(lines, value.detail, "details");
    appendUniqueSummaryLine(lines, value.url, "url");
    appendUniqueSummaryLine(lines, value.requestId, "request_id");

    visit(value.error, depth + 1);
    visit(value.data, depth + 1);
    visit(value.codexErrorInfo, depth + 1);
    visit(value.cause, depth + 1);
  };

  visit(error);
  if (!lines.length) {
    const serialized = tryStringifyCompact(error);
    if (serialized) {
      appendUniqueSummaryLine(lines, serialized);
    }
  }
  if (!lines.length) {
    lines.push(`Codex app-server request${fallbackMethod ? ` '${fallbackMethod}'` : ""} failed`);
  }
  return lines.join("\n");
}

type CodexDirectElicitationResponse = {
  action: "accept" | "decline" | "cancel";
  content: unknown | null;
  _meta: unknown | null;
  summary: string;
};

function firstConstOption(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const entry of value) {
    if (isObjectRecord(entry) && Object.prototype.hasOwnProperty.call(entry, "const")) {
      return entry.const;
    }
  }
  return undefined;
}

function normalizeNumericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildDefaultElicitationString(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return String(schema.enum[0]);
  }
  const oneOfConst = firstConstOption(schema.oneOf);
  if (oneOfConst !== undefined) {
    return String(oneOfConst);
  }
  const anyOfConst = firstConstOption(schema.anyOf);
  if (anyOfConst !== undefined) {
    return String(anyOfConst);
  }
  const hint = [schema.title, schema.description]
    .filter((entry) => typeof entry === "string")
    .join(" ")
    .toLowerCase();
  if (/(approve|allow|accept|confirm|decision|action)/.test(hint)) {
    return "approve";
  }
  const minLength = normalizeNumericValue(schema.minLength) || 0;
  if (minLength > 0) {
    const seed = "yes";
    return seed.length >= minLength ? seed : seed.padEnd(Math.min(minLength, 8), "y");
  }
  return "";
}

function buildDefaultElicitationValue(schema: unknown): unknown {
  if (!isObjectRecord(schema)) {
    return "";
  }
  if (Object.prototype.hasOwnProperty.call(schema, "default")) {
    return schema.default;
  }

  const type = typeof schema.type === "string" ? schema.type : "";
  if (type === "boolean") {
    return true;
  }
  if (type === "integer") {
    return Math.ceil(normalizeNumericValue(schema.minimum) ?? 0);
  }
  if (type === "number") {
    return normalizeNumericValue(schema.minimum) ?? 0;
  }
  if (type === "array") {
    const minItems = Math.max(0, Math.floor(normalizeNumericValue(schema.minItems) ?? 0));
    const itemValue = buildDefaultElicitationValue(schema.items);
    if (minItems <= 0) {
      return [];
    }
    return Array.from({ length: minItems }, () => itemValue);
  }
  return buildDefaultElicitationString(schema);
}

function buildCodexDirectToolUserInputResponse(
  params: unknown,
): { answers: Record<string, { answers: string[] }> } {
  const answers: Record<string, { answers: string[] }> = {};
  if (!isObjectRecord(params) || !Array.isArray(params.questions)) {
    return { answers };
  }
  for (const question of params.questions) {
    if (!isObjectRecord(question) || typeof question.id !== "string" || !question.id.trim()) {
      continue;
    }
    let nextAnswer = "yes";
    if (Array.isArray(question.options)) {
      const firstOption = question.options.find((entry) =>
        isObjectRecord(entry) && typeof entry.label === "string" && entry.label.trim());
      if (firstOption && typeof firstOption.label === "string" && firstOption.label.trim()) {
        nextAnswer = firstOption.label.trim();
      }
    }
    answers[question.id.trim()] = {
      answers: [nextAnswer],
    };
  }
  return { answers };
}

export function buildCodexDirectElicitationResponse(
  params: unknown,
): CodexDirectElicitationResponse {
  if (!isObjectRecord(params)) {
    return {
      action: "decline",
      content: null,
      _meta: null,
      summary: "Declined malformed MCP elicitation request.",
    };
  }

  const serverName = typeof params.serverName === "string" && params.serverName.trim()
    ? params.serverName.trim()
    : "unknown-mcp-server";
  const message = typeof params.message === "string" && params.message.trim()
    ? params.message.trim()
    : "MCP server requested user input.";
  const mode = typeof params.mode === "string" ? params.mode : "";
  const meta = params._meta ?? null;

  if (mode === "url") {
    return {
      action: "cancel",
      content: null,
      _meta: meta,
      summary: `[codex-direct] Cancelled URL MCP elicitation from '${serverName}': ${message}`,
    };
  }

  const requestedSchema = isObjectRecord(params.requestedSchema) ? params.requestedSchema : null;
  const properties = requestedSchema && isObjectRecord(requestedSchema.properties)
    ? requestedSchema.properties
    : null;
  if (mode !== "form" || !properties) {
    return {
      action: "decline",
      content: null,
      _meta: meta,
      summary: `[codex-direct] Declined unsupported MCP elicitation from '${serverName}': ${message}`,
    };
  }

  const content: Record<string, unknown> = {};
  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    content[fieldName] = buildDefaultElicitationValue(fieldSchema);
  }

  return {
    action: "accept",
    content,
    _meta: meta,
    summary: `[codex-direct] Auto-accepted MCP elicitation from '${serverName}': ${message}`,
  };
}

export function parseCodexDirectAppServerResult(stdout: string): CodexDirectResultEnvelope {
  const lines = splitOutputLines(stdout);
  if (!lines.length) {
    return {
      rawResult: null,
      resultText: "",
    };
  }

  let threadId: string | undefined;
  let turnId: string | undefined;
  const agentMessageByItem = new Map<string, string>();
  let latestAgentMessageItemId: string | undefined;
  const errors: string[] = [];
  let lastErrorSummary: string | undefined;
  let turnStatus: string | undefined;
  let eventCount = 0;
  let ignoredLineCount = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      eventCount += 1;

      const responseThreadId = extractThreadIdFromPayload(parsed.result);
      if (responseThreadId) {
        threadId = responseThreadId;
      }
      const responseTurnId = extractTurnIdFromPayload(parsed.result);
      if (responseTurnId) {
        turnId = responseTurnId;
      }

      if (Object.prototype.hasOwnProperty.call(parsed, "error") && parsed.error !== undefined) {
        const errorSummary = formatCodexErrorSummary(parsed.error);
        errors.push(errorSummary);
        lastErrorSummary = errorSummary;
      }

      const method = typeof parsed.method === "string" ? parsed.method : "";
      const params = parsed.params;
      if (!method || !isObjectRecord(params)) {
        continue;
      }

      const codexEventMethod = method.startsWith("codex/event/")
        ? method.slice("codex/event/".length)
        : "";

      if (method === "thread/started") {
        const nextThreadId = extractThreadIdFromPayload(params);
        if (nextThreadId) {
          threadId = nextThreadId;
        }
        continue;
      }

      if (method === "turn/started" || method === "turn/completed") {
        const nextThreadId = extractThreadIdFromPayload(params);
        if (nextThreadId) {
          threadId = nextThreadId;
        }
        const nextTurnId = extractTurnIdFromPayload(params);
        if (nextTurnId) {
          turnId = nextTurnId;
        }
        if (
          method === "turn/completed"
        ) {
          if (isObjectRecord(params.turn) && typeof params.turn.status === "string" && params.turn.status.trim()) {
            turnStatus = params.turn.status.trim();
          }
          if (isObjectRecord(params.turn) && params.turn.error !== undefined && params.turn.error !== null) {
            const errorSummary = formatCodexErrorSummary(params.turn.error);
            errors.push(errorSummary);
            lastErrorSummary = errorSummary;
          }
        }
        continue;
      }

      if (codexEventMethod === "task_started" || codexEventMethod === "task_complete" || codexEventMethod === "turn_aborted") {
        const nextThreadId = extractThreadIdFromPayload(params);
        if (nextThreadId) {
          threadId = nextThreadId;
        }
        const nextTurnId = extractTurnIdFromPayload(params);
        if (nextTurnId) {
          turnId = nextTurnId;
        }
        if (codexEventMethod === "task_complete") {
          const taskStatus = extractCodexEventActivityStatus(params, "completed");
          if (taskStatus === "failed") {
            turnStatus = "failed";
            const errorSummary = extractCodexEventError(params, method);
            if (errorSummary) {
              errors.push(errorSummary);
              lastErrorSummary = errorSummary;
            }
          }
        } else if (codexEventMethod === "turn_aborted") {
          turnStatus = "interrupted";
        }
        continue;
      }

      if (method === "item/agentMessage/delta" || codexEventMethod === "agent_message_delta" || codexEventMethod === "agent_message_content_delta") {
        const itemId = extractItemId(params) || `agent-message:${turnId || threadId || "unknown"}`;
        const delta = extractCodexEventOutputDelta(params) || "";
        if (itemId) {
          agentMessageByItem.set(itemId, `${agentMessageByItem.get(itemId) || ""}${delta}`);
          latestAgentMessageItemId = itemId;
        }
        continue;
      }

      if (method === "item/completed" && isObjectRecord(params.item)) {
        const itemId = extractItemId(params.item);
        const itemText = extractItemText(params.item);
        if (itemId && typeof itemText === "string") {
          agentMessageByItem.set(itemId, itemText);
          latestAgentMessageItemId = itemId;
          continue;
        }
      }

      if (codexEventMethod === "agent_message") {
        const itemId = extractItemId(params) || `agent-message:${turnId || threadId || "unknown"}`;
        const itemText = extractCodexEventSummary(params, 20_000);
        if (itemId && itemText) {
          agentMessageByItem.set(itemId, itemText);
          latestAgentMessageItemId = itemId;
          continue;
        }
      }

      if (
        (
          method === "error"
          && params.error !== undefined
          && params.error !== null
        )
        || codexEventMethod === "error"
        || codexEventMethod === "stream_error"
      ) {
        const errorSummary = extractCodexEventError(params, method) || formatCodexErrorSummary(params.error, method);
        errors.push(errorSummary);
        lastErrorSummary = errorSummary;
      }
    } catch {
      ignoredLineCount += 1;
    }
  }

  const lastAgentMessage = latestAgentMessageItemId
    ? agentMessageByItem.get(latestAgentMessageItemId) || ""
    : "";

  const rawResult: Record<string, unknown> | null = eventCount > 0
      ? {
          thread_id: threadId || null,
          turn_id: turnId || null,
          turn_status: turnStatus || null,
          event_count: eventCount,
          last_agent_message: lastAgentMessage || null,
          last_error: lastErrorSummary || errors[errors.length - 1] || null,
          error_count: errors.length,
          errors,
          ignored_line_count: ignoredLineCount,
        }
    : null;

  return {
    rawResult,
    resultText: lastAgentMessage,
    threadId,
    turnId,
  };
}

class CodexDirectExecutor implements CodexDirectCommandExecutor {
  async run(
    request: CodexDirectCommandRequest,
    hooks: CliAdapterRunHooks,
  ): Promise<CodexDirectCommandExecutionResult> {
    return await new Promise<CodexDirectCommandExecutionResult>((resolve, reject) => {
      const env = { ...process.env, ...(request.env || {}) };
      const isWindows = process.platform === "win32";
      const isPowerShellShim = isWindows && /\.ps1$/i.test(request.command);
      const command = isWindows && isPowerShellShim ? WINDOWS_POWERSHELL : request.command;
      const appServerArgs = ["app-server", "--listen", "stdio://"];
      const args = isWindows
        ? (isPowerShellShim
          ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", request.command, ...appServerArgs]
          : appServerArgs)
        : appServerArgs;
      let stdout = "";
      let stderr = "";
      const emitStderr = (text: string): void => {
        const normalized = String(text || "");
        if (!normalized) {
          return;
        }
        stderr += normalized;
        hooks.onOutput("stderr", normalized);
      };
      const startupLog = (message: string): void => {
        emitStderr(`[codex-direct][startup] ${message}\n`);
      };

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

      let child: ChildProcessWithoutNullStreams;
      startupLog(`spawn global codex -> start (${command} ${args.join(" ")})`);
      try {
        child = spawn(command, args, {
          cwd: request.workspace,
          env,
          shell: false,
        });
      } catch (error) {
        startupLog(`spawn global codex -> failed: ${formatUnknownErrorMessage(error)}`);
        reject(error);
        return;
      }
      startupLog(
        typeof child.pid === "number" && child.pid > 0
          ? `spawn global codex -> ok (pid ${child.pid})`
          : "spawn global codex -> ok",
      );

      let settled = false;
      let startupCompleted = false;
      let lineBuffer = "";
      let nextRequestId = 1;
      let activeThreadId = String(request.env?.[CODEX_THREAD_ID_ENV_VAR] || "").trim() || undefined;
      let activeTurnId: string | undefined;
      let turnCompleted = false;
      let completedTurnStatus: string | undefined;
      let successfulTurn = false;
      let postTurnActivityCount = 0;
      let shutdownRequested = false;
      let shutdownTimer: NodeJS.Timeout | null = null;
      let postTurnSilenceTimer: NodeJS.Timeout | null = null;
      const streamedAgentMessageItemIds = new Set<string>();
      const activityByItemId = new Map<string, CliAdapterActivityEvent>();
      const fileChangeActivityIdsByTurn = new Map<string, Set<string>>();
      const pendingServerRequestFlags = new Map<string, "waitingOnApproval" | "waitingOnUserInput">();
      const pendingRequests = new Map<
        string,
        {
          method: string;
          resolve: (value: unknown) => void;
          reject: (error: unknown) => void;
          timer: NodeJS.Timeout;
        }
      >();

      const recordFileChangeActivity = (activity: CliAdapterActivityEvent): void => {
        if (activity.kind !== "file_change" || !activity.turn_id) {
          return;
        }
        const existing = fileChangeActivityIdsByTurn.get(activity.turn_id) || new Set<string>();
        existing.add(activity.item_id);
        fileChangeActivityIdsByTurn.set(activity.turn_id, existing);
      };

      const emitActivity = (activity: CliAdapterActivityEvent): void => {
        recordFileChangeActivity(activity);
        activityByItemId.set(activity.item_id, activity);
        hooks.onActivity?.(activity);
      };

      const emitNativeRuntime = (event: CliAdapterNativeRuntimeEvent): void => {
        hooks.onNativeRuntime?.({
          ...event,
          at: event.at || nowIso(),
        });
      };

      const emitPendingServerRequestRuntime = (): void => {
        emitNativeRuntime({
          thread_id: activeThreadId || null,
          active_turn_id: activeTurnId || null,
          last_turn_id: activeTurnId || null,
          turn_status: activeTurnId ? "inProgress" : undefined,
          phase: activeTurnId ? "running" : undefined,
          thread_active_flags: Array.from(new Set(pendingServerRequestFlags.values())),
        });
      };

      const rememberPendingServerRequest = (
        requestId: JsonRpcId,
        flag: "waitingOnApproval" | "waitingOnUserInput",
      ): void => {
        pendingServerRequestFlags.set(String(requestId), flag);
        emitPendingServerRequestRuntime();
      };

      const clearPendingServerRequest = (requestId?: JsonRpcId): void => {
        if (requestId === undefined) {
          if (!pendingServerRequestFlags.size) {
            return;
          }
          pendingServerRequestFlags.clear();
          emitPendingServerRequestRuntime();
          return;
        }
        if (!pendingServerRequestFlags.delete(String(requestId))) {
          return;
        }
        emitPendingServerRequestRuntime();
      };

      const upsertActivity = (next: Partial<CliAdapterActivityEvent> & { item_id: string }): void => {
        const previous = activityByItemId.get(next.item_id);
        const activity: CliAdapterActivityEvent = {
          at: next.at || nowIso(),
          turn_id: next.turn_id || previous?.turn_id || activeTurnId,
          item_id: next.item_id,
          kind: next.kind || previous?.kind || "thinking",
          status: next.status || previous?.status || "in_progress",
          label: next.label || previous?.label || "Thinking",
          summary: next.summary !== undefined ? next.summary : previous?.summary,
          content: next.content !== undefined ? next.content : previous?.content,
          server: next.server !== undefined ? next.server : previous?.server,
          tool: next.tool !== undefined ? next.tool : previous?.tool,
          command: next.command !== undefined ? next.command : previous?.command,
          cwd: next.cwd !== undefined ? next.cwd : previous?.cwd,
          files: next.files !== undefined ? next.files : previous?.files,
          diff: next.diff !== undefined ? next.diff : previous?.diff,
          plan_steps: next.plan_steps !== undefined ? next.plan_steps : previous?.plan_steps,
          started_at: next.started_at !== undefined ? next.started_at : previous?.started_at,
          completed_at: next.completed_at !== undefined ? next.completed_at : previous?.completed_at,
        };
        emitActivity(activity);
      };

      const emitItemActivity = (item: unknown, options?: { status?: CliAdapterActivityEvent["status"] }): void => {
        const baseActivity = buildCodexDirectActivityFromItem(item, activeTurnId);
        if (!baseActivity) {
          return;
        }
        upsertActivity({
          ...baseActivity,
          status: options?.status || baseActivity.status,
          at: nowIso(),
        });
      };

      const clearPendingRequests = (error?: unknown) => {
        const pendingError = error ?? new Error(
          "Codex app-server closed before pending requests could complete.",
        );
        pendingServerRequestFlags.clear();
        for (const [requestId, pending] of pendingRequests.entries()) {
          clearTimeout(pending.timer);
          pending.reject(pendingError);
          pendingRequests.delete(requestId);
        }
      };

      const finalize = (result: CodexDirectCommandExecutionResult) => {
        if (settled) {
          return;
        }
        settled = true;
        if (shutdownTimer) {
          clearTimeout(shutdownTimer);
        }
        if (postTurnSilenceTimer) {
          clearTimeout(postTurnSilenceTimer);
        }
        clearPendingRequests();
        resolve(result);
      };

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        if (shutdownTimer) {
          clearTimeout(shutdownTimer);
        }
        if (postTurnSilenceTimer) {
          clearTimeout(postTurnSilenceTimer);
        }
        clearPendingRequests(error);
        reject(error);
      };

      const resetPostTurnSilenceTimer = (): void => {
        if (!startupCompleted || settled) {
          return;
        }
        if (postTurnSilenceTimer) {
          clearTimeout(postTurnSilenceTimer);
        }
        postTurnSilenceTimer = setTimeout(() => {
          const turnLabel = activeTurnId || "unknown";
          emitStderr(
            `[codex-direct] No app-server notifications received 5000ms after turn/start (turn ${turnLabel}, count ${postTurnActivityCount}).\n`,
          );
        }, 5_000);
      };

      const writeRpcMessage = (message: Record<string, unknown>): void => {
        if (child.stdin.destroyed || child.killed) {
          throw new Error("Codex app-server stdin is unavailable.");
        }
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };

      const sendRequest = (method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> => {
        const requestId = String(nextRequestId++);
        return new Promise((resolveRequest, rejectRequest) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            rejectRequest(new Error(`Timed out waiting for Codex app-server response to '${method}'.`));
          }, timeoutMs);
          pendingRequests.set(requestId, {
            method,
            resolve: resolveRequest,
            reject: rejectRequest,
            timer,
          });
          try {
            writeRpcMessage({
              id: requestId,
              method,
              params,
            });
          } catch (error) {
            clearTimeout(timer);
            pendingRequests.delete(requestId);
            rejectRequest(error);
          }
        });
      };

      const sendNotification = (method: string, params?: unknown): void => {
        const message: Record<string, unknown> = { method };
        if (params !== undefined) {
          message.params = params;
        }
        writeRpcMessage(message);
      };

      const sendResponse = (id: JsonRpcId, result: unknown): void => {
        writeRpcMessage({ id, result });
      };

      const sendErrorResponse = (id: JsonRpcId, message: string, code = -32601): void => {
        writeRpcMessage({
          id,
          error: {
            code,
            message,
          },
        });
      };

      const sendResponseSafe = (id: JsonRpcId, result: unknown): boolean => {
        try {
          sendResponse(id, result);
          return true;
        } catch (error) {
          if (isCodexStdinUnavailableError(error)) {
            emitStderr(`[codex-direct] Dropped late app-server response for request ${String(id)} because stdin is unavailable.\n`);
            return false;
          }
          throw error;
        }
      };

      const sendErrorResponseSafe = (id: JsonRpcId, message: string, code = -32601): boolean => {
        try {
          sendErrorResponse(id, message, code);
          return true;
        } catch (error) {
          if (isCodexStdinUnavailableError(error)) {
            emitStderr(`[codex-direct] Dropped late app-server error response for request ${String(id)} because stdin is unavailable.\n`);
            return false;
          }
          throw error;
        }
      };

      const requestGracefulShutdown = () => {
        if (shutdownRequested) {
          return;
        }
        shutdownRequested = true;
        try {
          child.stdin.end();
        } catch {
          // Best effort shutdown.
        }
        shutdownTimer = setTimeout(() => {
          terminateChildProcessTree(child);
        }, 1_500);
      };

      const requestInterruptAndShutdown = async () => {
        if (shutdownRequested) {
          return;
        }
        if (activeThreadId && activeTurnId) {
          emitNativeRuntime({
            thread_id: activeThreadId,
            active_turn_id: activeTurnId,
            last_turn_id: activeTurnId,
            phase: "interrupting",
          });
          try {
            await sendRequest(
              "turn/interrupt",
              {
                threadId: activeThreadId,
                turnId: activeTurnId,
              },
              5_000,
            );
          } catch {
            // Fall back to shutting the process down directly.
          }
        }
        requestGracefulShutdown();
      };

      const handleServerRequest = (message: Record<string, unknown>) => {
        const requestId = extractJsonRpcId(message.id);
        const method = typeof message.method === "string" ? message.method : "";
        if (requestId === undefined || !method) {
          return;
        }
        try {
          if (method === "item/commandExecution/requestApproval") {
            rememberPendingServerRequest(requestId, "waitingOnApproval");
            sendResponseSafe(requestId, {
              decision: "acceptForSession",
            });
            return;
          }
          if (method === "item/fileChange/requestApproval") {
            rememberPendingServerRequest(requestId, "waitingOnApproval");
            sendResponseSafe(requestId, {
              decision: "acceptForSession",
            });
            return;
          }
          if (method === "item/permissions/requestApproval") {
            rememberPendingServerRequest(requestId, "waitingOnApproval");
            sendResponseSafe(requestId, {
              decision: "acceptForSession",
            });
            return;
          }
          if (method === "item/tool/requestUserInput") {
            rememberPendingServerRequest(requestId, "waitingOnUserInput");
            sendResponseSafe(requestId, buildCodexDirectToolUserInputResponse(message.params));
            return;
          }
          if (method === "mcpServer/elicitation/request") {
            rememberPendingServerRequest(requestId, "waitingOnApproval");
            const elicitation = buildCodexDirectElicitationResponse(message.params);
            emitStderr(`${elicitation.summary}\n`);
            const elicitationDetail = tryStringifyCompact({
              request: message.params,
              auto_response: {
                action: elicitation.action,
                content: elicitation.content,
              },
            });
            if (elicitationDetail) {
              emitStderr(`[codex-direct] MCP elicitation detail: ${elicitationDetail}\n`);
            }
            sendResponseSafe(requestId, {
              action: elicitation.action,
              content: elicitation.content,
              _meta: elicitation._meta,
            });
            return;
          }
          const label = normalizeServerRequestLabel(method);
          emitStderr(`[codex-direct] Unsupported app-server callback: ${label}. Continuing without handling it.\n`);
          sendErrorResponseSafe(
            requestId,
            `AgentChatBus direct adapter does not handle '${method}' yet.`,
          );
        } catch (error) {
          emitStderr(
            `[codex-direct] Failed handling app-server callback '${method}': ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      };

      const handleNotification = (message: Record<string, unknown>) => {
        const method = typeof message.method === "string" ? message.method : "";
        const params = isObjectRecord(message.params) ? message.params : {};
        if (!method) {
          return;
        }
        if (startupCompleted) {
          postTurnActivityCount += 1;
          resetPostTurnSilenceTimer();
        }

        const codexEventMethod = method.startsWith("codex/event/")
          ? method.slice("codex/event/".length)
          : "";
        const nextThreadIdFromParams = extractThreadIdFromPayload(params);
        const nextTurnIdFromParams = extractTurnIdFromPayload(params);
        if (nextThreadIdFromParams) {
          activeThreadId = nextThreadIdFromParams;
        }
        if (nextTurnIdFromParams) {
          activeTurnId = nextTurnIdFromParams;
        }

        if (codexEventMethod) {
          if (codexEventMethod === "task_started") {
            upsertActivity({
              at: nowIso(),
              turn_id: nextTurnIdFromParams || activeTurnId,
              item_id: extractCodexEventActivityItemId(params, "codex-task", activeTurnId, activeThreadId),
              kind: "task",
              status: "in_progress",
              label: "Task",
              summary: extractCodexEventSummary(params, 240) || "Working on the current task",
            });
            emitNativeRuntime({
              thread_id: activeThreadId,
              active_turn_id: activeTurnId || null,
              last_turn_id: activeTurnId || null,
              turn_status: "inProgress",
              phase: "running",
              thread_active_flags: [],
            });
            return;
          }

          if (codexEventMethod === "task_complete") {
            const taskStatus = extractCodexEventActivityStatus(params, "completed");
            const taskError = extractCodexEventError(params, method);
            upsertActivity({
              at: nowIso(),
              turn_id: nextTurnIdFromParams || activeTurnId,
              item_id: extractCodexEventActivityItemId(params, "codex-task", activeTurnId, activeThreadId),
              kind: "task",
              status: taskStatus,
              label: "Task",
              summary: taskError || extractCodexEventSummary(params, 240) || "Task completed",
            });
            emitNativeRuntime({
              thread_id: activeThreadId,
              active_turn_id: taskStatus === "failed" ? null : activeTurnId || null,
              last_turn_id: activeTurnId || null,
              turn_status: taskStatus === "failed" ? "failed" : "inProgress",
              phase: taskStatus === "failed" ? "failed" : "running",
              thread_active_flags: [],
              last_error: taskError || null,
            });
            return;
          }

          if (codexEventMethod === "turn_aborted") {
            upsertActivity({
              at: nowIso(),
              turn_id: nextTurnIdFromParams || activeTurnId,
              item_id: extractCodexEventActivityItemId(params, "codex-task", activeTurnId, activeThreadId),
              kind: "task",
              status: "failed",
              label: "Task",
              summary: extractCodexEventError(params, method) || extractCodexEventSummary(params, 240) || "Turn aborted",
            });
            emitNativeRuntime({
              thread_id: activeThreadId,
              active_turn_id: null,
              last_turn_id: activeTurnId || null,
              turn_status: "interrupted",
              phase: "interrupted",
              thread_active_flags: [],
              last_error: extractCodexEventError(params, method) || null,
            });
            return;
          }

          if (codexEventMethod === "error" || codexEventMethod === "stream_error") {
            const errorSummary = extractCodexEventError(params, method);
            upsertActivity({
              at: nowIso(),
              turn_id: nextTurnIdFromParams || activeTurnId,
              item_id: extractCodexEventActivityItemId(params, "codex-task", activeTurnId, activeThreadId),
              kind: "task",
              status: "failed",
              label: "Task",
              summary: errorSummary || "Task failed",
            });
            emitNativeRuntime({
              thread_id: activeThreadId,
              active_turn_id: null,
              last_turn_id: activeTurnId || null,
              turn_status: "failed",
              phase: "failed",
              thread_active_flags: [],
              last_error: errorSummary || null,
            });
            if (errorSummary) {
              emitStderr(`${errorSummary}\n`);
            }
            return;
          }

          if (
            codexEventMethod === "request_user_input"
            || codexEventMethod === "exec_approval_request"
            || codexEventMethod === "apply_patch_approval_request"
            || codexEventMethod === "elicitation_request"
          ) {
            emitNativeRuntime({
              thread_id: activeThreadId,
              active_turn_id: activeTurnId || null,
              last_turn_id: activeTurnId || null,
              turn_status: "inProgress",
              phase: "running",
              thread_active_flags: [
                codexEventMethod === "request_user_input" ? "waitingOnUserInput" : "waitingOnApproval",
              ],
            });
            return;
          }

          if (codexEventMethod === "agent_reasoning" || codexEventMethod === "agent_reasoning_delta") {
            const itemId = extractCodexEventActivityItemId(params, "codex-reasoning", activeTurnId, activeThreadId);
            upsertActivity({
              at: nowIso(),
              turn_id: nextTurnIdFromParams || activeTurnId,
              item_id: itemId,
              kind: "thinking",
              status: "in_progress",
              label: "Thinking",
              summary: codexEventMethod === "agent_reasoning_delta"
                ? appendActivityDelta(activityByItemId.get(itemId)?.summary, extractCodexEventOutputDelta(params), 260)
                : extractCodexEventSummary(params, 260) || activityByItemId.get(itemId)?.summary || "Working through the next steps",
            });
            emitNativeRuntime({
              thread_id: activeThreadId,
              active_turn_id: activeTurnId || null,
              last_turn_id: activeTurnId || null,
              turn_status: "inProgress",
              phase: "running",
              thread_active_flags: [],
            });
            return;
          }

          if (codexEventMethod === "plan_update" || codexEventMethod === "plan_delta") {
            const itemId = extractCodexEventActivityItemId(params, "codex-plan", activeTurnId, activeThreadId);
            const planSteps = extractPlanSteps(params);
            upsertActivity({
              at: nowIso(),
              turn_id: nextTurnIdFromParams || activeTurnId,
              item_id: itemId,
              kind: "plan",
              status: "in_progress",
              label: "Thinking",
              summary: codexEventMethod === "plan_delta"
                ? appendActivityDelta(activityByItemId.get(itemId)?.summary, extractCodexEventOutputDelta(params), 220)
                : extractCodexEventSummary(params, 220) || summarizePlanSteps(planSteps) || "Updating plan",
              plan_steps: planSteps,
            });
            emitNativeRuntime({
              thread_id: activeThreadId,
              active_turn_id: activeTurnId || null,
              last_turn_id: activeTurnId || null,
              turn_status: "inProgress",
              phase: "running",
              thread_active_flags: [],
            });
            return;
          }

          if (codexEventMethod === "mcp_tool_call_begin" || codexEventMethod === "mcp_tool_call_end") {
            const eventAt = nowIso();
            upsertActivity({
              at: eventAt,
              turn_id: nextTurnIdFromParams || activeTurnId,
              item_id: extractCodexEventActivityItemId(params, "codex-tool", activeTurnId, activeThreadId),
              kind: "mcp_tool_call",
              status: codexEventMethod === "mcp_tool_call_end"
                ? extractCodexEventActivityStatus(params, "completed")
                : "in_progress",
              label: "Using tool",
              server: extractCodexEventToolServer(params),
              tool: extractCodexEventToolName(params),
              summary: extractCodexEventSummary(params, 260) || extractCodexEventError(params, method),
              started_at: codexEventMethod === "mcp_tool_call_begin" ? eventAt : undefined,
              completed_at: codexEventMethod === "mcp_tool_call_end" ? eventAt : undefined,
            });
            emitNativeRuntime({
              thread_id: activeThreadId,
              active_turn_id: activeTurnId || null,
              last_turn_id: activeTurnId || null,
              turn_status: "inProgress",
              phase: "running",
              thread_active_flags: [],
            });
            return;
          }

          if (codexEventMethod === "dynamic_tool_call_request") {
            upsertActivity({
              at: nowIso(),
              turn_id: nextTurnIdFromParams || activeTurnId,
              item_id: extractCodexEventActivityItemId(params, "codex-dynamic-tool", activeTurnId, activeThreadId),
              kind: "dynamic_tool_call",
              status: "in_progress",
              label: "Using tool",
              tool: extractCodexEventToolName(params),
              summary: extractCodexEventSummary(params, 260),
            });
            emitNativeRuntime({
              thread_id: activeThreadId,
              active_turn_id: activeTurnId || null,
              last_turn_id: activeTurnId || null,
              turn_status: "inProgress",
              phase: "running",
              thread_active_flags: ["waitingOnApproval"],
            });
            return;
          }

          if (
            codexEventMethod === "exec_command_begin"
            || codexEventMethod === "exec_command_output_delta"
            || codexEventMethod === "terminal_interaction"
            || codexEventMethod === "exec_command_end"
          ) {
            const eventAt = nowIso();
            const itemId = extractCodexEventActivityItemId(params, "codex-command", activeTurnId, activeThreadId);
            const summary = codexEventMethod === "exec_command_output_delta"
              ? appendActivityDelta(activityByItemId.get(itemId)?.summary, extractCodexEventOutputDelta(params), 260)
              : codexEventMethod === "terminal_interaction"
                ? clipActivityText(`Sent input: ${extractCodexEventSummary(params, 220) || "interaction"}`, 220)
                : extractCodexEventSummary(params, 260) || extractCodexEventError(params, method);
            upsertActivity({
              at: eventAt,
              turn_id: nextTurnIdFromParams || activeTurnId,
              item_id: itemId,
              kind: "command_execution",
              status: codexEventMethod === "exec_command_end"
                ? extractCodexEventActivityStatus(params, "completed")
                : "in_progress",
              label: "Running command",
              command: extractCodexEventCommand(params),
              cwd: extractCodexEventCwd(params),
              summary,
              content: codexEventMethod === "exec_command_output_delta"
                ? appendActivityContent(activityByItemId.get(itemId)?.content, extractCodexEventOutputDelta(params), 3_000)
                : codexEventMethod === "terminal_interaction"
                  ? appendActivityContent(activityByItemId.get(itemId)?.content, `Sent input: ${extractCodexEventSummary(params, 220) || "interaction"}`, 3_000)
                  : activityByItemId.get(itemId)?.content,
              started_at: codexEventMethod === "exec_command_begin" ? eventAt : undefined,
              completed_at: codexEventMethod === "exec_command_end" ? eventAt : undefined,
            });
            emitNativeRuntime({
              thread_id: activeThreadId,
              active_turn_id: activeTurnId || null,
              last_turn_id: activeTurnId || null,
              turn_status: "inProgress",
              phase: "running",
              thread_active_flags: [],
            });
            return;
          }

          if (codexEventMethod === "patch_apply_begin" || codexEventMethod === "patch_apply_end") {
            const files = extractActivityFiles(params);
            const eventAt = nowIso();
            upsertActivity({
              at: eventAt,
              turn_id: nextTurnIdFromParams || activeTurnId,
              item_id: extractCodexEventActivityItemId(params, "codex-file-change", activeTurnId, activeThreadId),
              kind: "file_change",
              status: codexEventMethod === "patch_apply_end"
                ? extractCodexEventActivityStatus(params, "completed")
                : "in_progress",
              label: "Editing files",
              files,
              summary: extractCodexEventSummary(params, 220)
                || clipActivityText(files?.slice(0, 3).map((entry) => entry.path).join(", "), 220)
                || "Updating files",
              started_at: codexEventMethod === "patch_apply_begin" ? eventAt : undefined,
              completed_at: codexEventMethod === "patch_apply_end" ? eventAt : undefined,
            });
            emitNativeRuntime({
              thread_id: activeThreadId,
              active_turn_id: activeTurnId || null,
              last_turn_id: activeTurnId || null,
              turn_status: "inProgress",
              phase: "running",
              thread_active_flags: [],
            });
            return;
          }

          if (codexEventMethod === "turn_diff") {
            const diff = clipActivityText(
              extractDirectString(params, ["diff", "patch", "content"]),
              800,
            );
            const relatedIds = fileChangeActivityIdsByTurn.get(nextTurnIdFromParams || activeTurnId || "");
            if (relatedIds?.size) {
              for (const itemId of relatedIds) {
                upsertActivity({
                  at: nowIso(),
                  turn_id: nextTurnIdFromParams || activeTurnId,
                  item_id: itemId,
                  kind: "file_change",
                  status: "in_progress",
                  label: "Editing files",
                  diff,
                });
              }
            } else {
              upsertActivity({
                at: nowIso(),
                turn_id: nextTurnIdFromParams || activeTurnId,
                item_id: extractCodexEventActivityItemId(params, "codex-file-change", activeTurnId, activeThreadId),
                kind: "file_change",
                status: "in_progress",
                label: "Editing files",
                summary: diff ? "Updating files" : "Editing files",
                diff,
              });
            }
            emitNativeRuntime({
              thread_id: activeThreadId,
              active_turn_id: activeTurnId || null,
              last_turn_id: activeTurnId || null,
              turn_status: "inProgress",
              phase: "running",
              thread_active_flags: [],
            });
            return;
          }

          if (codexEventMethod === "item_started" && isObjectRecord(params.item)) {
            emitItemActivity(params.item);
            emitNativeRuntime({
              thread_id: activeThreadId,
              active_turn_id: activeTurnId || null,
              last_turn_id: activeTurnId || null,
              turn_status: "inProgress",
              phase: "running",
              thread_active_flags: [],
            });
            return;
          }

          if (codexEventMethod === "item_completed" && isObjectRecord(params.item)) {
            emitItemActivity(params.item, {
              status: normalizeActivityStatus(params.item.status),
            });
            return;
          }

          if (codexEventMethod === "agent_message_delta" || codexEventMethod === "agent_message_content_delta") {
            const delta = extractCodexEventOutputDelta(params);
            if (delta) {
              const itemId = extractCodexEventActivityItemId(params, "codex-message", activeTurnId, activeThreadId);
              upsertActivity({
                at: nowIso(),
                turn_id: nextTurnIdFromParams || activeTurnId,
                item_id: itemId,
                kind: "agent_message",
                status: "in_progress",
                label: "Message",
                content: appendActivityContent(activityByItemId.get(itemId)?.content, delta, 6_000),
                summary: appendActivityDelta(activityByItemId.get(itemId)?.summary, delta, 320),
                started_at: activityByItemId.get(itemId)?.started_at || nowIso(),
              });
              hooks.onOutput("stdout", delta);
            }
            return;
          }

          if (codexEventMethod === "agent_message") {
            const messageText = extractCodexEventSummary(params, 20_000);
            if (messageText) {
              const eventAt = nowIso();
              const itemId = extractCodexEventActivityItemId(params, "codex-message", activeTurnId, activeThreadId);
              upsertActivity({
                at: eventAt,
                turn_id: nextTurnIdFromParams || activeTurnId,
                item_id: itemId,
                kind: "agent_message",
                status: "completed",
                label: "Message",
                content: clipActivityContent(messageText, 6_000),
                summary: clipActivityText(messageText, 320),
                started_at: activityByItemId.get(itemId)?.started_at || eventAt,
                completed_at: eventAt,
              });
              hooks.onOutput("stdout", messageText.endsWith("\n") ? messageText : `${messageText}\n`);
            }
            return;
          }
        }

        if (method === "thread/started") {
          const nextThreadId = extractThreadIdFromPayload(params);
          if (nextThreadId) {
            activeThreadId = nextThreadId;
          }
          emitNativeRuntime({
            thread_id: activeThreadId,
            ...extractThreadStatusFromPayload(params),
          });
          return;
        }

        if (method === "thread/status/changed") {
          const nextThreadId = extractThreadIdFromPayload(params);
          if (nextThreadId) {
            activeThreadId = nextThreadId;
          }
          emitNativeRuntime({
            thread_id: activeThreadId,
            ...extractThreadStatusFromPayload(params),
          });
          return;
        }

        if (method === "serverRequest/resolved") {
          clearPendingServerRequest(extractJsonRpcId(params.requestId));
          return;
        }

        if (method === "turn/started") {
          const nextThreadId = extractThreadIdFromPayload(params);
          if (nextThreadId) {
            activeThreadId = nextThreadId;
          }
          const nextTurnId = extractTurnIdFromPayload(params);
          if (nextTurnId) {
            activeTurnId = nextTurnId;
          }
          const nextTurnStatus = normalizeTurnStatus(isObjectRecord(params.turn) ? params.turn.status : undefined);
          emitNativeRuntime({
            thread_id: activeThreadId,
            active_turn_id: activeTurnId,
            last_turn_id: activeTurnId,
            turn_status: nextTurnStatus || "inProgress",
            phase: phaseFromTurnStatus(nextTurnStatus || "inProgress") || "running",
          });
          return;
        }

        if (method === "item/started" && isObjectRecord(params.item)) {
          emitItemActivity(params.item);
          return;
        }

        if (method === "turn/completed") {
          const nextThreadId = extractThreadIdFromPayload(params);
          if (nextThreadId) {
            activeThreadId = nextThreadId;
          }
          const nextTurnId = extractTurnIdFromPayload(params);
          if (nextTurnId) {
            activeTurnId = nextTurnId;
          }
          const turnStatus = isObjectRecord(params.turn) && typeof params.turn.status === "string"
            ? params.turn.status
            : "";
          turnCompleted = true;
          completedTurnStatus = turnStatus || undefined;
          successfulTurn = turnStatus === "completed";
          clearPendingServerRequest();
          emitNativeRuntime({
            thread_id: activeThreadId,
            active_turn_id: null,
            last_turn_id: nextTurnId || activeTurnId || null,
            turn_status: normalizeTurnStatus(turnStatus) || null,
            phase: phaseFromTurnStatus(normalizeTurnStatus(turnStatus) || undefined) || "completed",
            last_error: isObjectRecord(params.turn) && params.turn.error !== undefined && params.turn.error !== null
              ? formatCodexErrorSummary(params.turn.error)
              : null,
          });
          if (
            isObjectRecord(params.turn)
            && params.turn.error !== undefined
            && params.turn.error !== null
          ) {
            emitStderr(`${formatCodexErrorSummary(params.turn.error)}\n`);
          } else if (turnStatus && turnStatus !== "completed") {
            emitStderr(`Codex turn completed with status '${turnStatus}'.\n`);
          }
          requestGracefulShutdown();
          return;
        }

        if (method === "turn/plan/updated") {
          const nextTurnId = extractTurnIdFromPayload(params);
          if (nextTurnId) {
            activeTurnId = nextTurnId;
          }
          const planSteps = extractPlanSteps(params);
          upsertActivity({
            at: nowIso(),
            turn_id: nextTurnId || activeTurnId,
            item_id: `turn-plan:${nextTurnId || activeTurnId || "unknown"}`,
            kind: "plan",
            status: "in_progress",
            label: "Thinking",
            summary: clipActivityText(params.explanation, 220) || summarizePlanSteps(planSteps) || "Updating plan",
            plan_steps: planSteps,
          });
          return;
        }

        if (method === "turn/diff/updated") {
          const nextTurnId = extractTurnIdFromPayload(params);
          if (nextTurnId) {
            activeTurnId = nextTurnId;
          }
          const diff = clipActivityText(params.diff, 800);
          const relatedIds = fileChangeActivityIdsByTurn.get(nextTurnId || activeTurnId || "");
          if (relatedIds?.size) {
            for (const itemId of relatedIds) {
              upsertActivity({
                at: nowIso(),
                turn_id: nextTurnId || activeTurnId,
                item_id: itemId,
                diff,
                kind: "file_change",
                label: "Editing files",
                status: "in_progress",
              });
            }
            return;
          }
          upsertActivity({
            at: nowIso(),
            turn_id: nextTurnId || activeTurnId,
            item_id: `turn-file-change:${nextTurnId || activeTurnId || "unknown"}`,
            kind: "file_change",
            status: "in_progress",
            label: "Editing files",
            summary: diff ? "Updating files" : "Editing files",
            diff,
          });
          return;
        }

        if (method === "error" && params.error !== undefined && params.error !== null) {
          emitStderr(`${formatCodexErrorSummary(params.error)}\n`);
          return;
        }

        if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
          const itemId = typeof params.itemId === "string" ? params.itemId.trim() : "";
          if (itemId) {
            streamedAgentMessageItemIds.add(itemId);
            const eventAt = nowIso();
            upsertActivity({
              at: eventAt,
              turn_id: extractTurnIdFromPayload(params) || activeTurnId,
              item_id: itemId,
              kind: "agent_message",
              status: "in_progress",
              label: "Message",
              content: appendActivityContent(activityByItemId.get(itemId)?.content, params.delta, 6_000),
              summary: appendActivityDelta(activityByItemId.get(itemId)?.summary, params.delta, 320),
              started_at: activityByItemId.get(itemId)?.started_at || eventAt,
            });
          }
          hooks.onOutput("stdout", params.delta);
          return;
        }

        if (method === "item/commandExecution/outputDelta" && typeof params.delta === "string") {
          const itemId = typeof params.itemId === "string" ? params.itemId.trim() : "";
          if (itemId) {
            upsertActivity({
              at: nowIso(),
              turn_id: extractTurnIdFromPayload(params) || activeTurnId,
              item_id: itemId,
              kind: "command_execution",
              status: "in_progress",
              label: "Running command",
              summary: appendActivityDelta(activityByItemId.get(itemId)?.summary, params.delta, 260),
              content: appendActivityContent(activityByItemId.get(itemId)?.content, params.delta, 3_000),
            });
          }
          hooks.onOutput("stdout", params.delta);
          return;
        }

        if (method === "item/fileChange/outputDelta" && typeof params.delta === "string") {
          const itemId = typeof params.itemId === "string" ? params.itemId.trim() : "";
          if (itemId) {
            upsertActivity({
              at: nowIso(),
              turn_id: extractTurnIdFromPayload(params) || activeTurnId,
              item_id: itemId,
              kind: "file_change",
              status: "in_progress",
              label: "Editing files",
              summary: appendActivityDelta(activityByItemId.get(itemId)?.summary, params.delta, 220),
              content: appendActivityContent(activityByItemId.get(itemId)?.content, params.delta, 3_000),
            });
          }
          hooks.onOutput("stdout", params.delta);
          return;
        }

        if (method === "item/commandExecution/terminalInteraction") {
          const itemId = typeof params.itemId === "string" ? params.itemId.trim() : "";
          if (itemId) {
            upsertActivity({
              at: nowIso(),
              turn_id: extractTurnIdFromPayload(params) || activeTurnId,
              item_id: itemId,
              kind: "command_execution",
              status: "in_progress",
              label: "Running command",
              summary: clipActivityText(`Sent input: ${String(params.stdin || "").trim()}`, 220),
              content: appendActivityContent(
                activityByItemId.get(itemId)?.content,
                `Sent input: ${String(params.stdin || "").trim()}`,
                3_000,
              ),
            });
          }
          return;
        }

        if (method === "item/mcpToolCall/progress") {
          const itemId = typeof params.itemId === "string" ? params.itemId.trim() : "";
          if (itemId) {
            upsertActivity({
              at: nowIso(),
              turn_id: extractTurnIdFromPayload(params) || activeTurnId,
              item_id: itemId,
              kind: "mcp_tool_call",
              status: "in_progress",
              label: "Using tool",
              summary: clipActivityText(params.message, 260),
            });
          }
          return;
        }

        if (method === "item/plan/delta" && typeof params.delta === "string") {
          const itemId = typeof params.itemId === "string" ? params.itemId.trim() : "";
          if (itemId) {
            upsertActivity({
              at: nowIso(),
              turn_id: extractTurnIdFromPayload(params) || activeTurnId,
              item_id: itemId,
              kind: "plan",
              status: "in_progress",
              label: "Thinking",
              summary: appendActivityDelta(activityByItemId.get(itemId)?.summary, params.delta, 220),
            });
          }
          return;
        }

        if (method === "item/reasoning/summaryPartAdded") {
          const itemId = typeof params.itemId === "string" ? params.itemId.trim() : "";
          if (itemId) {
            upsertActivity({
              at: nowIso(),
              turn_id: extractTurnIdFromPayload(params) || activeTurnId,
              item_id: itemId,
              kind: "thinking",
              status: "in_progress",
              label: "Thinking",
              summary: activityByItemId.get(itemId)?.summary || "Thinking through the next steps",
            });
          }
          return;
        }

        if (method === "item/reasoning/summaryTextDelta" && typeof params.delta === "string") {
          const itemId = typeof params.itemId === "string" ? params.itemId.trim() : "";
          if (itemId) {
            upsertActivity({
              at: nowIso(),
              turn_id: extractTurnIdFromPayload(params) || activeTurnId,
              item_id: itemId,
              kind: "thinking",
              status: "in_progress",
              label: "Thinking",
              summary: appendActivityDelta(activityByItemId.get(itemId)?.summary, params.delta, 260),
            });
          }
          return;
        }

        if (
          method === "command/exec/outputDelta"
          && typeof params.deltaBase64 === "string"
          && params.deltaBase64
        ) {
          const stream = params.stream === "stderr" ? "stderr" : "stdout";
          const decoded = Buffer.from(params.deltaBase64, "base64").toString("utf8");
          hooks.onOutput(stream, decoded);
          return;
        }

        if (method === "item/completed" && isObjectRecord(params.item)) {
          emitItemActivity(params.item, {
            status: normalizeActivityStatus(params.item.status),
          });
          const itemId = extractItemId(params.item);
          const itemText = extractItemText(params.item);
          if (
            itemId
            && typeof itemText === "string"
            && !streamedAgentMessageItemIds.has(itemId)
          ) {
            hooks.onOutput("stdout", itemText.endsWith("\n") ? itemText : `${itemText}\n`);
          }
        }
      };

      const handleParsedMessage = (message: Record<string, unknown>) => {
        const method = typeof message.method === "string" ? message.method : "";
        const requestId = extractJsonRpcId(message.id);
        const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
        const hasError = Object.prototype.hasOwnProperty.call(message, "error");

        if (requestId !== undefined && !method && (hasResult || hasError)) {
          const pending = pendingRequests.get(String(requestId));
          if (!pending) {
            return;
          }
          clearTimeout(pending.timer);
          pendingRequests.delete(String(requestId));
          if (hasError) {
            pending.reject(normalizeRpcError(message.error, pending.method));
            return;
          }
          pending.resolve((message as JsonRpcResponseEnvelope).result);
          return;
        }

        if (requestId !== undefined && method) {
          handleServerRequest(message);
          return;
        }

        if (method) {
          handleNotification(message);
        }
      };

      const processStdoutText = (text: string) => {
        lineBuffer = `${lineBuffer}${text}`;
        const lines = lineBuffer.split(/\r?\n/g);
        lineBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = String(line || "").trim();
          if (!trimmed) {
            continue;
          }
          try {
            handleParsedMessage(JSON.parse(trimmed) as Record<string, unknown>);
          } catch {
            emitStderr(`[codex-direct] Ignored non-JSON app-server line: ${trimmed}\n`);
          }
        }
      };

      const bootstrap = async () => {
        emitNativeRuntime({
          thread_id: activeThreadId || null,
          phase: "starting",
        });
        startupLog("initialize -> start");
        try {
          await sendRequest(
            "initialize",
            {
              clientInfo: {
                name: "agentchatbus-ts",
                version: BUS_VERSION,
              },
              capabilities: {
                experimentalApi: true,
              },
            },
            30_000,
          );
          sendNotification("initialized");
          startupLog("initialize -> ok");
        } catch (error) {
          startupLog(`initialize -> failed: ${formatUnknownErrorMessage(error)}`);
          throw error;
        }

        const requestedModel = String(request.model || "").trim() || null;
        const requestedReasoningEffort = String(request.reasoningEffort || "").trim() || null;
        const requestConfig = requestedReasoningEffort
          ? { model_reasoning_effort: requestedReasoningEffort }
          : undefined;
        let threadResult: unknown;
        let resumedThread = false;
        startupLog("thread/start -> start");
        if (activeThreadId) {
          try {
            threadResult = await sendRequest(
              "thread/resume",
              {
                threadId: activeThreadId,
                cwd: request.workspace,
                model: requestedModel,
                config: requestConfig,
                approvalPolicy: CODEX_DIRECT_APPROVAL_POLICY,
                sandbox: "workspace-write",
                persistExtendedHistory: true,
              },
              30_000,
            );
            resumedThread = true;
            startupLog(`thread/start -> using thread/resume (thread ${activeThreadId})`);
          } catch (error) {
            emitStderr(
              `[codex-direct] Resume failed for thread ${activeThreadId}; starting a new thread instead.\n`,
            );
            startupLog(
              `thread/start -> thread/resume failed: ${formatUnknownErrorMessage(error)}; fallback to new thread`,
            );
            activeThreadId = undefined;
          }
        }

        if (!threadResult) {
          try {
            threadResult = await sendRequest(
              "thread/start",
              {
                cwd: request.workspace,
                model: requestedModel,
                config: requestConfig,
                approvalPolicy: CODEX_DIRECT_APPROVAL_POLICY,
                sandbox: "workspace-write",
                experimentalRawEvents: false,
                persistExtendedHistory: true,
              },
              30_000,
            );
          } catch (error) {
            startupLog(`thread/start -> failed: ${formatUnknownErrorMessage(error)}`);
            throw error;
          }
        }

        const nextThreadId = extractThreadIdFromPayload(threadResult);
        if (!nextThreadId) {
          const detail = "Codex app-server did not return a thread id.";
          startupLog(`thread/start -> failed: ${detail}`);
          throw new Error(detail);
        }
        activeThreadId = nextThreadId;
        emitNativeRuntime({
          thread_id: activeThreadId,
          ...extractThreadStatusFromPayload(threadResult),
        });
        startupLog(
          resumedThread
            ? `thread/start -> ok (resumed thread ${activeThreadId})`
            : `thread/start -> ok (thread ${activeThreadId})`,
        );

        startupLog("turn/start -> start");
        let turnResult: unknown;
        try {
          turnResult = await sendRequest(
            "turn/start",
              {
                threadId: activeThreadId,
                input: [
                {
                  type: "text",
                  text: request.prompt,
                  text_elements: [],
                },
                ],
                model: requestedModel,
                approvalPolicy: CODEX_DIRECT_APPROVAL_POLICY,
              },
            30_000,
          );
        } catch (error) {
          startupLog(`turn/start -> failed: ${formatUnknownErrorMessage(error)}`);
          throw error;
        }

        const nextTurnId = extractTurnIdFromPayload(turnResult);
        if (!nextTurnId) {
          const detail = "Codex app-server did not return a turn id.";
          startupLog(`turn/start -> failed: ${detail}`);
          throw new Error(detail);
        }
        activeTurnId = nextTurnId;
        startupCompleted = true;
        emitNativeRuntime({
          thread_id: activeThreadId,
          active_turn_id: activeTurnId,
          last_turn_id: activeTurnId,
          turn_status: "inProgress",
          phase: "running",
        });
        startupLog(`turn/start -> ok (thread ${activeThreadId}, turn ${activeTurnId})`);
        resetPostTurnSilenceTimer();
      };

      hooks.onControls({
        kill: () => {
          void requestInterruptAndShutdown();
        },
      });

      if (typeof child.pid === "number" && child.pid > 0) {
        hooks.onProcessStart(child.pid);
      }

      child.stdout.on("data", (chunk) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
        stdout += text;
        processStdoutText(text);
      });

      child.stderr.on("data", (chunk) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
        emitStderr(text);
      });

      child.on("error", (error) => {
        startupLog(`spawn global codex -> failed: ${formatUnknownErrorMessage(error)}`);
        fail(error);
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        emitStderr(
          `[codex-direct] app-server process closed (code ${code ?? "unknown"}, startup_completed=${startupCompleted}, turn_completed=${turnCompleted}, turn_status=${completedTurnStatus || "unknown"}, activity_count=${postTurnActivityCount}).\n`,
        );
        if (!startupCompleted) {
          startupLog(
            `startup interrupted before completion (process exited with code ${code ?? "unknown"})`,
          );
        }
        const interrupted = hooks.signal.aborted;
        if (startupCompleted && !turnCompleted && !interrupted) {
          emitStderr("Codex app-server exited before turn/completed was received.\n");
        } else if (
          turnCompleted
          && !successfulTurn
          && completedTurnStatus
          && !stderr.includes(`Codex turn completed with status '${completedTurnStatus}'.`)
        ) {
          emitStderr(`Codex turn completed with status '${completedTurnStatus}'.\n`);
        }
        const effectiveExitCode = successfulTurn
          ? 0
          : (
            startupCompleted
              ? (typeof code === "number" && code !== 0 ? code : 1)
              : (typeof code === "number" ? code : null)
          );
        finalize({
          exitCode: effectiveExitCode,
          stdout,
          stderr,
        });
      });

      hooks.signal.addEventListener(
        "abort",
        () => {
          void requestInterruptAndShutdown();
        },
        { once: true },
      );

      void bootstrap().catch((error) => {
        requestGracefulShutdown();
        fail(error);
      });
    });
  }
}

export class CodexDirectAdapter implements CliSessionAdapter {
  readonly adapterId = "codex" as const;
  readonly mode = "direct" as const;
  readonly supportsInput = false;
  readonly supportsRestart = true;
  readonly supportsResize = false;
  readonly requiresPrompt = true;

  constructor(
    private readonly executor: CodexDirectCommandExecutor = new CodexDirectExecutor(),
    private readonly command?: string,
  ) {}

  async run(input: CliAdapterRunInput, hooks: CliAdapterRunHooks): Promise<CliAdapterRunResult> {
    const workspace = normalizeWorkspacePath(input.workspace);
    const command = this.command || resolveCodexHeadlessCommand();
    let execution: CodexDirectCommandExecutionResult;
    try {
      execution = await this.executor.run(
        {
          command,
          prompt: input.prompt,
          workspace,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          env: input.env,
        },
        hooks,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Codex direct app-server launch failed via '${command}': ${detail}`);
    }

    const parsed = parseCodexDirectAppServerResult(execution.stdout);
    const persistedThreadId = String(input.env?.[CODEX_THREAD_ID_ENV_VAR] || "").trim() || undefined;

    return {
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      resultText: parsed.resultText,
      rawResult: parsed.rawResult,
      externalSessionId: parsed.threadId || persistedThreadId,
      externalRequestId: parsed.turnId,
    };
  }
}
