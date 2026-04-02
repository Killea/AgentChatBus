import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import spawn from "cross-spawn";
import { BUS_VERSION } from "../../config/env.js";
import type {
  CliAdapterActivityEvent,
  CliSessionAdapter,
  CliAdapterRunInput,
  CliAdapterRunHooks,
  CliAdapterRunResult,
  CliSessionActivityPlanStep,
} from "./types.js";
import { WINDOWS_POWERSHELL } from "./constants.js";
import { normalizeWorkspacePath, terminateChildProcessTree } from "./utils.js";
import { CURSOR_SESSION_ID_ENV_VAR, resolveCursorAgentCommand } from "./cursorHeadlessAdapter.js";

const CURSOR_DIRECT_INITIALIZE_TIMEOUT_MS = 30_000;
const CURSOR_DIRECT_AUTH_TIMEOUT_MS = 20_000;
const CURSOR_DIRECT_SESSION_RESUME_TIMEOUT_MS = 20_000;
const CURSOR_DIRECT_SESSION_NEW_TIMEOUT_MS = 25_000;
const CURSOR_DIRECT_PROMPT_TIMEOUT_MS = 30_000;
const CURSOR_DIRECT_SHUTDOWN_GRACE_MS = 1_500;

type CursorDirectCommandRequest = {
  command: string;
  prompt: string;
  workspace: string;
  model?: string;
  env?: Record<string, string>;
};

type CursorDirectCommandExecutionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type CursorDirectResultEnvelope = {
  resultText?: string;
  rawResult?: Record<string, unknown> | null;
  sessionId?: string;
  requestId?: string;
};

type JsonRpcId = string | number;

type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcEnvelope = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type CursorAcpToolState = {
  itemId: string;
  kind: CliAdapterActivityEvent["kind"];
  label: string;
  status: CliAdapterActivityEvent["status"];
  summary?: string;
  command?: string;
  cwd?: string;
  server?: string;
  tool?: string;
  files?: Array<{ path: string; change_type?: "add" | "delete" | "update" }>;
  diff?: string;
};

type CursorDirectPendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

interface CursorDirectCommandExecutor {
  run(
    request: CursorDirectCommandRequest,
    hooks: CliAdapterRunHooks,
  ): Promise<CursorDirectCommandExecutionResult>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clipText(value: unknown, maxLength = 320): string | undefined {
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

function extractString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function extractJsonRpcId(value: unknown): JsonRpcId | undefined {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return undefined;
}

function extractSessionId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return extractString(value, ["sessionId", "session_id", "chatId", "chat_id"]);
}

function extractRequestId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return extractString(value, ["requestId", "request_id", "turnId", "turn_id"]);
}

function extractAuthMethodIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (isRecord(entry)) {
        return extractString(entry, ["methodId", "id", "name"]) || "";
      }
      return "";
    })
    .filter((entry) => entry.length > 0);
}

function extractAssistantText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const direct = extractString(value, ["text", "delta", "message", "content", "result"]);
  if (direct) {
    return direct;
  }

  const content = value.content;
  if (Array.isArray(content)) {
    const merged = content
      .filter(isRecord)
      .map((entry) => extractString(entry, ["text", "delta", "content"]))
      .filter((entry): entry is string => Boolean(entry))
      .join("");
    return merged.trim() || undefined;
  }

  return undefined;
}

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return extractString(value, ["text", "content", "delta", "message", "result"]);
}

function extractContentText(content: unknown): string | undefined {
  if (Array.isArray(content)) {
    const merged = content
      .map((entry) => extractTextContent(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join("");
    return merged.trim() || undefined;
  }
  return extractTextContent(content);
}

function extractContentEntries(content: unknown): Record<string, unknown>[] {
  if (Array.isArray(content)) {
    return content.filter(isRecord);
  }
  return isRecord(content) ? [content] : [];
}

function extractPlanSteps(value: unknown): CliSessionActivityPlanStep[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return undefined;
  }
  const steps = value.entries
    .filter(isRecord)
    .map((entry) => {
      const step = extractString(entry, ["content", "title", "label", "description"]) || "";
      const statusRaw = String(entry.status || "").trim().toLowerCase();
      const status: CliSessionActivityPlanStep["status"] = statusRaw === "completed"
        ? "completed"
        : statusRaw === "inprogress" || statusRaw === "in_progress" || statusRaw === "running" || statusRaw === "active"
          ? "inProgress"
          : "pending";
      return step ? { step, status } : null;
    })
    .filter((entry): entry is CliSessionActivityPlanStep => Boolean(entry));
  return steps.length ? steps : undefined;
}

function normalizeCursorToolStatus(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function normalizeCursorToolKind(value: unknown): string | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "write") {
    return "edit";
  }
  if (normalized === "run") {
    return "execute";
  }
  return normalized;
}

function mapToolStatus(value: unknown): CliAdapterActivityEvent["status"] {
  const normalized = normalizeCursorToolStatus(value);
  if (normalized === "pending") {
    return "in_progress";
  }
  if (
    normalized === "completed"
    || normalized === "done"
    || normalized === "finished"
    || normalized === "success"
    || normalized === "succeeded"
  ) {
    return "completed";
  }
  if (
    normalized === "failed"
    || normalized === "error"
    || normalized === "cancelled"
    || normalized === "canceled"
    || normalized === "declined"
    || normalized === "denied"
  ) {
    return "failed";
  }
  return "in_progress";
}

function inferFileChangeType(toolKind: string | undefined): "add" | "delete" | "update" | undefined {
  switch (toolKind) {
    case "delete":
      return "delete";
    case "edit":
      return "update";
    default:
      return undefined;
  }
}

function extractToolFiles(
  value: unknown,
  toolKind?: string,
): Array<{ path: string; change_type?: "add" | "delete" | "update" }> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidates = new Set<string>();
  const directPath = extractString(value, ["path", "filePath", "file_path", "filename"]);
  if (directPath) {
    candidates.add(directPath);
  }
  if (Array.isArray(value.paths)) {
    for (const entry of value.paths) {
      if (typeof entry === "string" && entry.trim()) {
        candidates.add(entry.trim());
      }
    }
  }
  if (!candidates.size) {
    return undefined;
  }
  const changeType = inferFileChangeType(toolKind);
  return [...candidates].slice(0, 8).map((path) => ({ path, change_type: changeType }));
}

function classifyCursorToolKind(
  acpKind: string | undefined,
  title: string | undefined,
  rawInput: Record<string, unknown> | undefined,
  rawOutput: Record<string, unknown> | undefined,
): CliAdapterActivityEvent["kind"] {
  switch (acpKind) {
    case "edit":
    case "delete":
      return "file_change";
    case "execute":
      return "command_execution";
    case "read":
    case "search":
    case "other":
      return "dynamic_tool_call";
    default:
      break;
  }
  const text = `${String(title || "")} ${JSON.stringify(rawInput || {})} ${JSON.stringify(rawOutput || {})}`.toLowerCase();
  if (/(bash|shell|terminal|command|exec)/.test(text)) {
    return "command_execution";
  }
  if (/(file|write|edit|patch|diff)/.test(text)) {
    return "file_change";
  }
  if (/(mcp|tool)/.test(text)) {
    return "mcp_tool_call";
  }
  return "dynamic_tool_call";
}

function extractLocationFiles(
  locations: unknown,
  toolKind?: string,
): Array<{ path: string; change_type?: "add" | "delete" | "update" }> | undefined {
  if (!Array.isArray(locations)) {
    return undefined;
  }
  const changeType = inferFileChangeType(toolKind);
  const files = locations
    .filter(isRecord)
    .map((entry) => extractString(entry, ["path", "uri", "filePath", "file_path"]))
    .filter((entry): entry is string => Boolean(entry))
    .map((path) => ({ path, change_type: changeType }));
  return files.length ? files : undefined;
}

function extractCommandFromToolInput(rawInput: Record<string, unknown> | undefined): string | undefined {
  const direct = extractString(rawInput || {}, ["command", "cmd", "shellCommand", "shell_command"]);
  if (direct) {
    return direct;
  }
  if (Array.isArray(rawInput?.commands)) {
    const commands = rawInput.commands
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim());
    return commands.length ? commands.join(" && ") : undefined;
  }
  return undefined;
}

function summarizeToolContent(contentEntries: Record<string, unknown>[]): string | undefined {
  const contentText = contentEntries
    .map((entry) => {
      const type = String(entry.type || "").trim().toLowerCase();
      if (type === "content" || type === "text" || !type) {
        return extractContentText(entry.content ?? entry);
      }
      return undefined;
    })
    .filter((entry): entry is string => Boolean(entry))
    .join(" ");
  return clipText(contentText, 280);
}

function buildToolDiffPreview(contentEntries: Record<string, unknown>[]): string | undefined {
  const diffSnippets = contentEntries
    .filter((entry) => String(entry.type || "").trim().toLowerCase() === "diff")
    .map((entry) => {
      const path = extractString(entry, ["path"]) || "file";
      const oldText = clipText(entry.oldText, 100) || "(previous content omitted)";
      const newText = clipText(entry.newText, 100) || "(updated content omitted)";
      return `${path}\n- ${oldText}\n+ ${newText}`;
    });
  return diffSnippets.length ? clipText(diffSnippets.join("\n\n"), 500) : undefined;
}

function buildCursorToolLabel(
  toolKind: string | undefined,
  title: string | undefined,
  command: string | undefined,
  files: Array<{ path: string; change_type?: "add" | "delete" | "update" }> | undefined,
): string {
  if (title) {
    return title;
  }
  const firstPath = files?.[0]?.path;
  switch (toolKind) {
    case "read":
      return firstPath ? `Read ${firstPath}` : "Read file";
    case "edit":
      return firstPath ? `Edit ${firstPath}` : "Edit file";
    case "delete":
      return firstPath ? `Delete ${firstPath}` : "Delete file";
    case "search":
      return firstPath ? `Search ${firstPath}` : "Search workspace";
    case "execute":
      return command ? `Run ${command}` : "Run command";
    default:
      return "Using tool";
  }
}

function buildCursorToolState(
  update: Record<string, unknown>,
  previous?: CursorAcpToolState,
): CursorAcpToolState {
  const toolKind = normalizeCursorToolKind(update.kind) || normalizeCursorToolKind(previous?.tool);
  const rawInput = isRecord(update.rawInput) ? update.rawInput : undefined;
  const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : undefined;
  const contentEntries = extractContentEntries(update.content);
  const diffPaths = contentEntries
    .filter((entry) => String(entry.type || "").trim().toLowerCase() === "diff")
    .map((entry) => extractString(entry, ["path"]))
    .filter((entry): entry is string => Boolean(entry));
  const title = extractString(update, ["title"]);
  const locationFiles = extractLocationFiles(update.locations, toolKind);
  const command = extractCommandFromToolInput(rawInput) || previous?.command;
  const contentSummary = summarizeToolContent(contentEntries);
  const diffPreview = buildToolDiffPreview(contentEntries) || previous?.diff;
  const kind = classifyCursorToolKind(toolKind, title || previous?.label, rawInput, rawOutput);
  const fileCandidates = [
    ...(extractToolFiles(rawInput, toolKind) || []),
    ...(extractToolFiles(rawOutput, toolKind) || []),
    ...diffPaths.map((path) => ({ path, change_type: "update" as const })),
    ...(locationFiles || []),
  ];
  const dedupedFiles = fileCandidates.length
    ? fileCandidates.filter((file, index) => fileCandidates.findIndex((entry) => entry.path === file.path) === index)
    : undefined;
  const label = buildCursorToolLabel(toolKind, title, command, dedupedFiles) || previous?.label || "Using tool";
  return {
    itemId: extractString(update, ["toolCallId", "tool_call_id"]) || previous?.itemId || `tool:${label}`,
    kind,
    label,
    status: mapToolStatus(update.status ?? previous?.status),
    summary: clipText(
      contentSummary
      || extractString(rawOutput || {}, ["message", "content", "result", "summary"])
      || extractString(update, ["title"])
      || extractString(rawOutput || {}, ["message", "content", "result"])
      || previous?.summary,
      280,
    ),
    command,
    cwd: extractString(rawInput || {}, ["cwd", "workingDirectory", "working_directory", "dir"]) || previous?.cwd,
    server: extractString(rawInput || {}, ["server", "serverName", "mcpServer", "mcp_server"]) || previous?.server,
    tool: toolKind || extractString(rawInput || {}, ["tool", "toolName", "tool_name", "name"]) || previous?.tool,
    files: dedupedFiles || previous?.files,
    diff: diffPreview,
  };
}

export function resolveCursorWorkspacePath(targetPath: string, workspace: string): string {
  return isAbsolute(targetPath) ? resolvePath(targetPath) : resolvePath(workspace, targetPath);
}

function isPathInsideWorkspace(targetPath: string, workspace: string): boolean {
  const resolvedWorkspace = resolvePath(workspace);
  const resolvedTarget = resolveCursorWorkspacePath(targetPath, workspace);
  const relativePath = relative(resolvedWorkspace, resolvedTarget);
  return relativePath === ""
    || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export async function handleReadTextFileRequest(
  params: Record<string, unknown>,
  workspace: string,
): Promise<Record<string, unknown>> {
  const path = extractString(params, ["path"]);
  if (!path) {
    throw new Error("fs/read_text_file requires 'path'.");
  }
  if (!isPathInsideWorkspace(path, workspace)) {
    throw new Error("fs/read_text_file target is outside the workspace boundary.");
  }
  const resolvedPath = resolveCursorWorkspacePath(path, workspace);
  const content = await readFile(resolvedPath, "utf8");
  const startLine = Math.max(1, Number(params.line) || 1);
  const maxLines = Number(params.limit);
  if (!Number.isFinite(maxLines) || maxLines <= 0) {
    return { content };
  }
  const lines = content.split(/\r?\n/g);
  return {
    content: lines.slice(startLine - 1, startLine - 1 + maxLines).join("\n"),
  };
}

export async function handleWriteTextFileRequest(
  params: Record<string, unknown>,
  workspace: string,
): Promise<Record<string, unknown>> {
  const path = extractString(params, ["path"]);
  const content = typeof params.content === "string" ? params.content : undefined;
  if (!path || content === undefined) {
    throw new Error("fs/write_text_file requires 'path' and 'content'.");
  }
  if (!isPathInsideWorkspace(path, workspace)) {
    throw new Error("fs/write_text_file target is outside the workspace boundary.");
  }
  const resolvedPath = resolveCursorWorkspacePath(path, workspace);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, content, "utf8");
  return {};
}

export function selectCursorPermissionOptionId(options: Array<Record<string, unknown>>): string | undefined {
  const normalizedOptions = options
    .map((option) => ({
      optionId: extractString(option, ["optionId", "id"]),
      kind: String(option.kind || option.name || "").trim().toLowerCase(),
    }))
    .filter((entry): entry is { optionId: string; kind: string } => Boolean(entry.optionId));
  return normalizedOptions.find((entry) => entry.optionId === "allow-once")?.optionId
    || normalizedOptions.find((entry) => entry.optionId === "allow-always")?.optionId
    || normalizedOptions.find((entry) => entry.kind.includes("allow"))?.optionId
    || normalizedOptions[0]?.optionId;
}

function normalizeJsonRpcLine(line: string): JsonRpcEnvelope | null {
  try {
    return JSON.parse(line) as JsonRpcEnvelope;
  } catch {
    return null;
  }
}

function parseCursorDirectJsonRpcLine(
  line: string,
  state: {
    sessionId?: string;
    requestId?: string;
    assistantText: string;
    eventCount: number;
    ignoredLineCount: number;
    errors: string[];
    completed: boolean;
  },
): void {
  const parsed = normalizeJsonRpcLine(line);
  if (!parsed) {
    state.ignoredLineCount += 1;
    return;
  }
  state.eventCount += 1;

  const resultRecord = isRecord(parsed.result) ? parsed.result : undefined;
  const paramsRecord = isRecord(parsed.params) ? parsed.params : undefined;

  state.sessionId = state.sessionId
    || extractSessionId(resultRecord)
    || extractSessionId(paramsRecord)
    || extractSessionId(parsed);
  state.requestId = state.requestId
    || extractRequestId(resultRecord)
    || extractRequestId(paramsRecord)
    || extractRequestId(parsed);

  const method = String(parsed.method || "").trim().toLowerCase();
  const updateRecord = paramsRecord && isRecord(paramsRecord.update) ? paramsRecord.update : undefined;

  const updateType = String(updateRecord?.sessionUpdate || updateRecord?.updateType || "").trim().toLowerCase();
  const nextText = (updateType === "agent_message_chunk" ? extractContentText(updateRecord?.content) : undefined)
    || extractAssistantText(paramsRecord)
    || extractAssistantText(resultRecord)
    || (method.includes("message") || method.includes("delta") ? extractAssistantText(parsed) : undefined);
  if (nextText) {
    state.assistantText = `${state.assistantText}${nextText}`;
  }

  if (method.includes("error") && paramsRecord) {
    const message = clipText(extractString(paramsRecord, ["message", "detail", "error"]), 400);
    if (message) {
      state.errors.push(message);
    }
  }

  if (parsed.error !== undefined && parsed.error !== null) {
    if (isRecord(parsed.error)) {
      const message = clipText(extractString(parsed.error, ["message", "detail", "error"]), 400);
      if (message) {
        state.errors.push(message);
      }
    } else {
      const message = clipText(parsed.error, 400);
      if (message) {
        state.errors.push(message);
      }
    }
  }

  if (
    method.includes("complete")
    || method.includes("finished")
    || method.includes("done")
    || (resultRecord && typeof resultRecord.stopReason === "string" && resultRecord.stopReason.trim())
  ) {
    state.completed = true;
  }
}

export function parseCursorDirectResult(stdout: string): CursorDirectResultEnvelope {
  const state: {
    sessionId?: string;
    requestId?: string;
    assistantText: string;
    eventCount: number;
    ignoredLineCount: number;
    errors: string[];
    completed: boolean;
  } = {
    assistantText: "",
    eventCount: 0,
    ignoredLineCount: 0,
    errors: [],
    completed: false,
  };

  const lines = String(stdout || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    parseCursorDirectJsonRpcLine(line, state);
  }

  return {
    sessionId: state.sessionId,
    requestId: state.requestId,
    resultText: state.assistantText.trim(),
    rawResult: {
      session_id: state.sessionId || null,
      request_id: state.requestId || null,
      event_count: state.eventCount,
      last_assistant_text: state.assistantText.trim() || null,
      errors: state.errors,
      ignored_line_count: state.ignoredLineCount,
      completed: state.completed,
    },
  };
}

class CursorDirectExecutor implements CursorDirectCommandExecutor {
  async run(
    request: CursorDirectCommandRequest,
    hooks: CliAdapterRunHooks,
  ): Promise<CursorDirectCommandExecutionResult> {
    return await new Promise<CursorDirectCommandExecutionResult>((resolve, reject) => {
      const requestedModel = String(request.model || "").trim();
      const env = { ...process.env, ...(request.env || {}) };
      const isWindows = process.platform === "win32";
      const isPowerShellShim = isWindows && /\.ps1$/i.test(request.command);
      const command = isWindows && isPowerShellShim ? WINDOWS_POWERSHELL : request.command;
      const cursorArgs = ["acp"];
      const args = isWindows
        ? (isPowerShellShim
          ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", request.command, ...cursorArgs]
          : cursorArgs)
        : cursorArgs;

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

      let stdout = "";
      let stderr = "";
      let lineBuffer = "";
      let settled = false;
      let childClosed = false;
      let nextRequestId = 1;
      let activeSessionId = String(request.env?.[CURSOR_SESSION_ID_ENV_VAR] || "").trim() || undefined;
      let activeRequestId: string | undefined;
      let loadSessionSupported = false;
      let cursorLoginSupported = true;
      const pendingRequests = new Map<string, CursorDirectPendingRequest>();
      const toolStates = new Map<string, CursorAcpToolState>();

      const requestShutdown = () => {
        if (childClosed) {
          return;
        }
        for (const pending of pendingRequests.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Cursor ACP request '${pending.method}' canceled during shutdown.`));
        }
        pendingRequests.clear();
        try {
          child.stdin.end();
        } catch {
          // Best effort shutdown.
        }
        setTimeout(() => {
          if (!childClosed) {
            terminateChildProcessTree(child);
          }
        }, CURSOR_DIRECT_SHUTDOWN_GRACE_MS);
      };

      const finalize = (result: CursorDirectCommandExecutionResult) => {
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

      const sendMessage = (payload: Record<string, unknown>): void => {
        if (child.stdin.destroyed || child.killed || childClosed) {
          throw new Error("Cursor ACP stdin is unavailable.");
        }
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      };

      const sendRequest = async (
        method: string,
        params: Record<string, unknown>,
        timeoutMs = 25_000,
      ): Promise<unknown> => {
        const id: JsonRpcId = String(nextRequestId++);
        return await new Promise<unknown>((resolveRequest, rejectRequest) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(String(id));
            rejectRequest(new Error(`Timed out waiting for Cursor ACP response to '${method}'.`));
          }, timeoutMs);

          pendingRequests.set(String(id), {
            method,
            resolve: resolveRequest,
            reject: rejectRequest,
            timer,
          });

          try {
            const message: JsonRpcRequest = {
              id,
              method,
              params,
            };
            sendMessage(message as unknown as Record<string, unknown>);
          } catch (error) {
            clearTimeout(timer);
            pendingRequests.delete(String(id));
            rejectRequest(error instanceof Error ? error : new Error(String(error)));
          }
        });
      };

      const sendNotification = (method: string, params?: Record<string, unknown>): void => {
        const payload: Record<string, unknown> = { method };
        if (params) {
          payload.params = params;
        }
        sendMessage(payload);
      };

      const sendResponse = (id: JsonRpcId, result?: unknown, error?: { code: number; message: string }): void => {
        const payload: Record<string, unknown> = { id };
        if (error) {
          payload.error = error;
        } else {
          payload.result = result ?? {};
        }
        sendMessage(payload);
      };

      const emitActivity = (
        status: "in_progress" | "completed" | "failed",
        summary?: string,
      ) => {
        hooks.onActivity?.({
          at: nowIso(),
          turn_id: activeRequestId,
          item_id: "task:cursor-direct",
          kind: "task",
          status,
          label: "Cursor ACP",
          summary: clipText(summary || (status === "completed" ? "Completed" : "Running"), 260),
        });
      };

      const emitToolState = (state: CursorAcpToolState) => {
        hooks.onActivity?.({
          at: nowIso(),
          turn_id: activeRequestId,
          item_id: state.itemId,
          kind: state.kind,
          status: state.status,
          label: state.label,
          summary: state.summary,
          command: state.command,
          cwd: state.cwd,
          server: state.server,
          tool: state.tool,
          files: state.files,
          diff: state.diff,
        });
      };

      const handleSessionUpdate = (update: Record<string, unknown>) => {
        const updateType = String(update.sessionUpdate || update.updateType || update.type || "").trim().toLowerCase();
        if (!updateType) {
          return;
        }
        if (updateType === "agent_message_chunk") {
          const text = extractContentText(update.content) || extractAssistantText(update);
          if (text) {
            hooks.onOutput("stdout", text);
            emitActivity("in_progress", "Streaming assistant response");
            hooks.onNativeRuntime?.({
              at: nowIso(),
              thread_id: activeSessionId,
              active_turn_id: activeRequestId,
              last_turn_id: activeRequestId,
              turn_status: "inProgress",
              phase: "running",
            });
          }
          return;
        }
        if (updateType === "agent_thought_chunk" || updateType === "thought") {
          const summary = clipText(extractContentText(update.content) || extractAssistantText(update) || "Thinking", 280);
          hooks.onActivity?.({
            at: nowIso(),
            turn_id: activeRequestId,
            item_id: "thinking:cursor-direct",
            kind: "thinking",
            status: "in_progress",
            label: "Thinking",
            summary,
          });
          return;
        }
        if (updateType === "plan") {
          const planSteps = extractPlanSteps(update);
          hooks.onActivity?.({
            at: nowIso(),
            turn_id: activeRequestId,
            item_id: extractString(update, ["planId", "plan_id"]) || "plan:cursor-direct",
            kind: "plan",
            status: mapToolStatus(update.status),
            label: "Plan",
            summary: clipText(extractString(update, ["title", "description"]) || "Plan updated", 260),
            plan_steps: planSteps,
          });
          return;
        }
        if (updateType === "tool_call" || updateType === "tool_call_update") {
          const previous = toolStates.get(extractString(update, ["toolCallId", "tool_call_id"]) || "");
          const next = buildCursorToolState(update, previous);
          toolStates.set(next.itemId, next);
          emitToolState(next);
          return;
        }
        if (updateType === "current_mode_update") {
          const modeId = extractString(update, ["currentModeId", "modeId", "mode_id"]);
          if (modeId) {
            hooks.onActivity?.({
              at: nowIso(),
              turn_id: activeRequestId,
              item_id: "task:cursor-mode",
              kind: "task",
              status: "in_progress",
              label: "Mode",
              summary: `Mode: ${modeId}`,
            });
          }
          return;
        }
        if (updateType === "current_model_update") {
          const modelId = extractString(update, ["currentModelId", "modelId", "model_id"]);
          if (modelId) {
            hooks.onActivity?.({
              at: nowIso(),
              turn_id: activeRequestId,
              item_id: "task:cursor-model",
              kind: "task",
              status: "in_progress",
              label: "Model",
              summary: `Model: ${modelId}`,
            });
          }
        }
      };

      const handleInboundRequest = async (id: JsonRpcId, method: string, params: Record<string, unknown>) => {
        const normalizedMethod = method.trim().toLowerCase();
        try {
          if (normalizedMethod === "session/request_permission") {
            const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
            const optionId = selectCursorPermissionOptionId(options);
            hooks.onOutput("stderr", `[cursor-direct] Auto-approved ACP permission request.\n`);
            if (!optionId) {
              throw new Error("session/request_permission did not include a selectable option id.");
            }
            sendResponse(id, {
              outcome: {
                outcome: "selected",
                optionId,
              },
            });
            return;
          }
          if (normalizedMethod === "fs/read_text_file") {
            sendResponse(id, await handleReadTextFileRequest(params, request.workspace));
            return;
          }
          if (normalizedMethod === "fs/write_text_file") {
            sendResponse(id, await handleWriteTextFileRequest(params, request.workspace));
            return;
          }
          sendResponse(id, undefined, {
            code: -32601,
            message: `Unsupported Cursor ACP client method '${method}'.`,
          });
        } catch (error) {
          sendResponse(id, undefined, {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      };

      const handleNotification = (method: string, params: Record<string, unknown>) => {
        const normalizedMethod = method.trim().toLowerCase();
        activeSessionId = activeSessionId || extractSessionId(params);
        activeRequestId = activeRequestId || extractRequestId(params);

        if (normalizedMethod === "session/update") {
          handleSessionUpdate(params);
          return;
        }

        if (normalizedMethod.includes("error")) {
          const message = clipText(extractString(params, ["message", "detail", "error"]), 400)
            || "Cursor ACP notification error";
          hooks.onOutput("stderr", `${message}\n`);
          emitActivity("failed", message);
          hooks.onNativeRuntime?.({
            at: nowIso(),
            thread_id: activeSessionId,
            active_turn_id: activeRequestId,
            last_turn_id: activeRequestId,
            turn_status: "failed",
            phase: "failed",
            last_error: message,
          });
          return;
        }

        const text = extractAssistantText(params);
        if (text) {
          hooks.onOutput("stdout", text);
          emitActivity("in_progress", "Streaming assistant response");
          hooks.onNativeRuntime?.({
            at: nowIso(),
            thread_id: activeSessionId,
            active_turn_id: activeRequestId,
            last_turn_id: activeRequestId,
            turn_status: "inProgress",
            phase: "running",
          });
        }

        if (
          normalizedMethod.includes("complete")
          || normalizedMethod.includes("finished")
          || normalizedMethod.includes("done")
        ) {
          emitActivity("completed", "Cursor ACP turn completed");
          hooks.onNativeRuntime?.({
            at: nowIso(),
            thread_id: activeSessionId,
            active_turn_id: activeRequestId,
            last_turn_id: activeRequestId,
            turn_status: "completed",
            phase: "completed",
          });
          requestShutdown();
          return;
        }

        if (normalizedMethod.includes("start") || normalizedMethod.includes("running")) {
          emitActivity("in_progress", "Cursor ACP turn running");
          hooks.onNativeRuntime?.({
            at: nowIso(),
            thread_id: activeSessionId,
            active_turn_id: activeRequestId,
            last_turn_id: activeRequestId,
            turn_status: "inProgress",
            phase: "running",
          });
        }
      };

      const handleParsedMessage = (message: JsonRpcEnvelope) => {
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
            const errorRecord = isRecord(message.error) ? message.error : {};
            const detail = clipText(
              extractString(errorRecord, ["message", "detail", "error"]) || message.error,
              500,
            ) || `Cursor ACP request '${pending.method}' failed.`;
            pending.reject(new Error(detail));
            return;
          }
          pending.resolve(message.result);
          return;
        }

        if (requestId !== undefined && method) {
          void handleInboundRequest(requestId, method, isRecord(message.params) ? message.params : {});
          return;
        }

        if (method) {
          handleNotification(method, isRecord(message.params) ? message.params : {});
        }
      };

      const processStdoutText = (text: string): void => {
        lineBuffer = `${lineBuffer}${text}`;
        const lines = lineBuffer.split(/\r?\n/g);
        lineBuffer = lines.pop() || "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) {
            continue;
          }
          const parsed = normalizeJsonRpcLine(line);
          if (parsed) {
            handleParsedMessage(parsed);
            continue;
          }
          hooks.onOutput("stderr", `[cursor-direct] Ignored non-JSON ACP line: ${line}\n`);
        }
      };

      const bootstrap = async () => {
        hooks.onNativeRuntime?.({
          at: nowIso(),
          thread_id: activeSessionId,
          phase: "starting",
        });

        const initializePayload = {
          clientInfo: {
            name: "agentchatbus-ts",
            version: BUS_VERSION,
          },
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
            terminal: false,
          },
        };
        const initializeResult = await sendRequest(
          "initialize",
          {
            protocolVersion: 1,
            ...initializePayload,
          },
          CURSOR_DIRECT_INITIALIZE_TIMEOUT_MS,
        ).catch(async () => await sendRequest(
          "initialize",
          {
            protocolVersion: "0.2",
            ...initializePayload,
          },
          CURSOR_DIRECT_INITIALIZE_TIMEOUT_MS,
        ));

        activeSessionId = activeSessionId || extractSessionId(initializeResult);
        if (isRecord(initializeResult) && isRecord(initializeResult.agentCapabilities)) {
          loadSessionSupported = Boolean(initializeResult.agentCapabilities.loadSession);
        }
        if (isRecord(initializeResult)) {
          const authMethods = extractAuthMethodIds(initializeResult.authMethods);
          cursorLoginSupported = authMethods.length === 0 || authMethods.includes("cursor_login");
        }
        sendNotification("initialized", {});

        if (cursorLoginSupported) {
          try {
            await sendRequest(
              "authenticate",
              { methodId: "cursor_login" },
              CURSOR_DIRECT_AUTH_TIMEOUT_MS,
            );
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (/method.*not found|-32601|unsupported/i.test(detail)) {
              hooks.onOutput(
                "stderr",
                `[cursor-direct] authenticate(cursor_login) unsupported by this Cursor ACP build; continuing.\n`,
              );
            } else {
              throw error;
            }
          }
        }

        if (activeSessionId) {
          try {
            if (loadSessionSupported) {
              try {
                await sendRequest(
                  "session/load",
                  {
                    sessionId: activeSessionId,
                    cwd: request.workspace,
                    mcpServers: [],
                    ...(requestedModel ? { model: requestedModel } : {}),
                  },
                  CURSOR_DIRECT_SESSION_RESUME_TIMEOUT_MS,
                );
              } catch {
                await sendRequest(
                  "session/resume",
                  {
                    sessionId: activeSessionId,
                    cwd: request.workspace,
                    ...(requestedModel ? { model: requestedModel } : {}),
                  },
                  CURSOR_DIRECT_SESSION_RESUME_TIMEOUT_MS,
                );
              }
            } else {
              await sendRequest(
                "session/resume",
                {
                  sessionId: activeSessionId,
                  cwd: request.workspace,
                  ...(requestedModel ? { model: requestedModel } : {}),
                },
                CURSOR_DIRECT_SESSION_RESUME_TIMEOUT_MS,
              );
            }
          } catch {
            activeSessionId = undefined;
          }
        }

        if (!activeSessionId) {
          const sessionResult = await sendRequest(
            "session/new",
            {
              cwd: request.workspace,
              mcpServers: [],
              ...(requestedModel ? { model: requestedModel } : {}),
            },
            CURSOR_DIRECT_SESSION_NEW_TIMEOUT_MS,
          );
          activeSessionId = extractSessionId(sessionResult) || activeSessionId;
        }

        if (!activeSessionId) {
          throw new Error("Cursor ACP did not return a session id from initialize/session methods.");
        }

        const promptResult = await sendRequest(
          "session/prompt",
          {
            sessionId: activeSessionId,
            prompt: [
              {
                type: "text",
                text: request.prompt,
              },
            ],
            ...(requestedModel ? { model: requestedModel } : {}),
          },
          CURSOR_DIRECT_PROMPT_TIMEOUT_MS,
        ).catch(async () => await sendRequest(
          "session/prompt",
          {
            sessionId: activeSessionId,
            prompt: request.prompt,
            ...(requestedModel ? { model: requestedModel } : {}),
          },
          CURSOR_DIRECT_PROMPT_TIMEOUT_MS,
        ));
        activeRequestId = extractRequestId(promptResult) || activeRequestId;
        hooks.onNativeRuntime?.({
          at: nowIso(),
          thread_id: activeSessionId,
          active_turn_id: activeRequestId,
          last_turn_id: activeRequestId,
          turn_status: "inProgress",
          phase: "running",
        });
      };

      hooks.onControls({
        kill: () => {
          requestShutdown();
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
        stderr += text;
        hooks.onOutput("stderr", text);
      });

      child.on("error", (error) => {
        fail(error);
      });

      child.on("close", (code) => {
        childClosed = true;
        for (const pending of pendingRequests.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Cursor ACP request '${pending.method}' canceled because process exited.`));
        }
        pendingRequests.clear();
        finalize({
          exitCode: typeof code === "number" ? code : null,
          stdout,
          stderr,
        });
      });

      hooks.signal.addEventListener(
        "abort",
        () => {
          requestShutdown();
        },
        { once: true },
      );

      void bootstrap().catch((error) => {
        requestShutdown();
        fail(error);
      });
    });
  }
}

export class CursorDirectAdapter implements CliSessionAdapter {
  readonly adapterId = "cursor" as const;
  readonly mode = "direct" as const;
  readonly supportsInput = false;
  readonly supportsRestart = true;
  readonly supportsResize = false;
  readonly requiresPrompt = true;

  constructor(
    private readonly executor: CursorDirectCommandExecutor = new CursorDirectExecutor(),
    private readonly command = resolveCursorAgentCommand(),
  ) {}

  async run(input: CliAdapterRunInput, hooks: CliAdapterRunHooks): Promise<CliAdapterRunResult> {
    const workspace = normalizeWorkspacePath(input.workspace);
    let execution: CursorDirectCommandExecutionResult;
    try {
      execution = await this.executor.run(
        {
          command: this.command,
          prompt: input.prompt,
          workspace,
          model: input.model,
          env: input.env,
        },
        hooks,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cursor direct ACP launch failed via '${this.command}': ${detail}`);
    }

    const parsed = parseCursorDirectResult(execution.stdout);
    const persistedSessionId = String(input.env?.[CURSOR_SESSION_ID_ENV_VAR] || "").trim() || undefined;

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
