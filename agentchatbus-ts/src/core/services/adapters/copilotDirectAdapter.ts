import { dirname } from "node:path";
import { existsSync } from "node:fs";
import spawn from "cross-spawn";
import { BUS_VERSION } from "../../config/env.js";
import type {
  CliAdapterActivityEvent,
  CliAdapterNativeRuntimeEvent,
  CliAdapterRunHooks,
  CliAdapterRunInput,
  CliAdapterRunResult,
  CliSessionAdapter,
  CliSessionActivityPlanStep,
} from "./types.js";
import { WINDOWS_POWERSHELL } from "./constants.js";
import { normalizeWorkspacePath, terminateChildProcessTree } from "./utils.js";
import {
  COPILOT_SESSION_ID_ENV_VAR,
  resolveCopilotHeadlessCommand,
} from "./copilotHeadlessAdapter.js";

const INITIALIZE_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 20_000;
const NEW_SESSION_TIMEOUT_MS = 25_000;
const PROMPT_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 1_500;

type JsonRpcId = string | number;
type JsonRpcEnvelope = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type CopilotDirectResultEnvelope = {
  resultText?: string;
  rawResult?: Record<string, unknown> | null;
  sessionId?: string;
  requestId?: string;
};

interface CopilotDirectExecutor {
  run(
    request: { command: string; prompt: string; workspace: string; env?: Record<string, string> },
    hooks: CliAdapterRunHooks,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clipText(value: unknown, maxLength = 320): string | undefined {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
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
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function extractSessionId(value: unknown): string | undefined {
  return isRecord(value) ? extractString(value, ["sessionId", "session_id", "chatId", "chat_id"]) : undefined;
}

function extractRequestId(value: unknown): string | undefined {
  return isRecord(value) ? extractString(value, ["requestId", "request_id", "turnId", "turn_id"]) : undefined;
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

function extractAssistantText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return extractString(value, ["text", "delta", "message", "content", "result"])
    || extractContentText(value.content);
}

function normalizeJsonRpcLine(line: string): JsonRpcEnvelope | null {
  try {
    return JSON.parse(line) as JsonRpcEnvelope;
  } catch {
    return null;
  }
}

function getSessionUpdatePayload(params: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(params.update)) {
    return params.update;
  }
  if (isRecord(params.sessionUpdate)) {
    return params.sessionUpdate;
  }
  return params;
}

function extractPlanSteps(value: unknown): CliSessionActivityPlanStep[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return undefined;
  }
  const steps = value.entries
    .filter(isRecord)
    .map((entry) => {
      const step = extractString(entry, ["content", "title", "label", "description"]) || "";
      const rawStatus = String(entry.status || "").trim().toLowerCase();
      const status: CliSessionActivityPlanStep["status"] = rawStatus === "completed"
        ? "completed"
        : rawStatus === "running" || rawStatus === "in_progress" || rawStatus === "inprogress"
          ? "inProgress"
          : "pending";
      return step ? { step, status } : null;
    })
    .filter((entry): entry is CliSessionActivityPlanStep => Boolean(entry));
  return steps.length ? steps : undefined;
}

function mapActivityStatus(value: unknown): CliAdapterActivityEvent["status"] {
  const normalized = String(value || "").trim().toLowerCase();
  if (["completed", "done", "finished", "success", "succeeded"].includes(normalized)) {
    return "completed";
  }
  if (["failed", "error", "cancelled", "canceled", "declined", "denied"].includes(normalized)) {
    return "failed";
  }
  return "in_progress";
}

function mapToolKind(value: unknown): CliAdapterActivityEvent["kind"] {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "edit" || normalized === "write" || normalized === "delete") {
    return "file_change";
  }
  if (normalized === "run" || normalized === "execute" || normalized === "command") {
    return "command_execution";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  return "dynamic_tool_call";
}

function buildToolActivity(
  update: Record<string, unknown>,
  turnId?: string,
): CliAdapterActivityEvent {
  const rawInput = isRecord(update.rawInput) ? update.rawInput : undefined;
  const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : undefined;
  const rawKind = extractString(update, ["kind"]) || extractString(rawInput || {}, ["kind"]) || "";
  const command = extractString(rawInput || {}, ["command", "cmd", "shellCommand", "shell_command"]);
  const filePath = extractString(rawInput || {}, ["path", "filePath", "file_path", "filename"])
    || extractString(rawOutput || {}, ["path", "filePath", "file_path", "filename"]);
  const title = extractString(update, ["title"]);
  const label = title
    || (command ? `Run ${command}` : null)
    || (filePath ? `Edit ${filePath}` : null)
    || "Using tool";
  const changeType = rawKind === "delete"
    ? "delete"
    : rawKind === "edit" || rawKind === "write"
      ? "update"
      : undefined;
  return {
    at: nowIso(),
    turn_id: turnId,
    item_id: extractString(update, ["toolCallId", "tool_call_id"]) || `tool:${label}`,
    kind: mapToolKind(rawKind),
    status: mapActivityStatus(update.status),
    label,
    summary: clipText(
      extractContentText(update.content)
      || extractString(rawOutput || {}, ["message", "summary", "result", "content"])
      || title
      || label,
      280,
    ),
    command,
    cwd: extractString(rawInput || {}, ["cwd", "workingDirectory", "working_directory", "dir"]),
    server: extractString(rawInput || {}, ["server", "serverName", "mcpServer", "mcp_server"]),
    tool: extractString(rawInput || {}, ["tool", "toolName", "tool_name", "name"]) || rawKind || undefined,
    files: filePath ? [{ path: filePath, change_type: changeType }] : undefined,
  };
}

export function selectCopilotPermissionOptionId(options: Array<Record<string, unknown>>): string | undefined {
  const normalized = options
    .map((option) => ({
      optionId: extractString(option, ["optionId", "id"]),
      kind: String(option.kind || option.name || "").trim().toLowerCase(),
    }))
    .filter((entry): entry is { optionId: string; kind: string } => Boolean(entry.optionId));
  return normalized.find((entry) => entry.optionId === "allow-once")?.optionId
    || normalized.find((entry) => entry.optionId === "allow-always")?.optionId
    || normalized.find((entry) => entry.kind.includes("allow"))?.optionId
    || normalized[0]?.optionId;
}

function parseCopilotDirectJsonRpcLine(
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
  const updateRecord = paramsRecord ? getSessionUpdatePayload(paramsRecord) : undefined;
  const method = String(parsed.method || "").trim().toLowerCase();
  const updateType = String(updateRecord?.sessionUpdate || updateRecord?.updateType || updateRecord?.type || "")
    .trim()
    .toLowerCase();

  state.sessionId = state.sessionId
    || extractSessionId(resultRecord)
    || extractSessionId(paramsRecord)
    || extractSessionId(updateRecord)
    || extractSessionId(parsed);
  state.requestId = state.requestId
    || extractRequestId(resultRecord)
    || extractRequestId(paramsRecord)
    || extractRequestId(updateRecord)
    || extractRequestId(parsed);

  const nextText = (updateType === "agent_message_chunk" ? extractContentText(updateRecord?.content) : undefined)
    || extractAssistantText(updateRecord)
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
    const message = isRecord(parsed.error)
      ? clipText(extractString(parsed.error, ["message", "detail", "error"]), 400)
      : clipText(parsed.error, 400);
    if (message) {
      state.errors.push(message);
    }
  }
  if (
    method.includes("complete")
    || method.includes("finished")
    || method.includes("done")
    || method.includes("ended")
    || (resultRecord && typeof resultRecord.stopReason === "string" && resultRecord.stopReason.trim())
  ) {
    state.completed = true;
  }
}

export function parseCopilotDirectResult(stdout: string): CopilotDirectResultEnvelope {
  const state = {
    sessionId: undefined as string | undefined,
    requestId: undefined as string | undefined,
    assistantText: "",
    eventCount: 0,
    ignoredLineCount: 0,
    errors: [] as string[],
    completed: false,
  };
  const lines = String(stdout || "").split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    parseCopilotDirectJsonRpcLine(line, state);
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

function supportsLoadSessionCapability(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const candidates = [
    isRecord(value.agentCapabilities) ? value.agentCapabilities : undefined,
    isRecord(value.serverCapabilities) ? value.serverCapabilities : undefined,
    isRecord(value.capabilities) ? value.capabilities : undefined,
    value,
  ].filter((entry): entry is Record<string, unknown> => Boolean(entry));
  return candidates.some((entry) => Boolean(entry.loadSession || entry.load_session));
}

class DefaultCopilotDirectExecutor implements CopilotDirectExecutor {
  async run(
    request: { command: string; prompt: string; workspace: string; env?: Record<string, string> },
    hooks: CliAdapterRunHooks,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      const env = { ...process.env, ...(request.env || {}) };
      const isWindows = process.platform === "win32";
      const isPowerShellShim = isWindows && /\.ps1$/i.test(request.command);
      const command = isWindows && isPowerShellShim ? WINDOWS_POWERSHELL : request.command;
      const copilotArgs = ["--acp", "--stdio"];
      const args = isWindows
        ? (isPowerShellShim
          ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", request.command, ...copilotArgs]
          : copilotArgs)
        : copilotArgs;

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
      let closed = false;
      let settled = false;
      let nextRequestId = 1;
      let activeSessionId = String(request.env?.[COPILOT_SESSION_ID_ENV_VAR] || "").trim() || undefined;
      let activeRequestId: string | undefined;
      let loadSessionSupported = false;
      const pendingRequests = new Map<string, PendingRequest>();

      const finalize = (result: { exitCode: number | null; stdout: string; stderr: string }) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      const fail = (error: unknown) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      const emitRuntime = (
        phase: CliAdapterNativeRuntimeEvent["phase"],
        options: { turnStatus?: CliAdapterNativeRuntimeEvent["turn_status"]; lastError?: string } = {},
      ) => {
        hooks.onNativeRuntime?.({
          at: nowIso(),
          thread_id: activeSessionId,
          active_turn_id: activeRequestId,
          last_turn_id: activeRequestId,
          phase,
          turn_status: options.turnStatus,
          last_error: options.lastError,
        });
      };
      const emitTask = (status: "in_progress" | "completed" | "failed", summary: string) => {
        hooks.onActivity?.({
          at: nowIso(),
          turn_id: activeRequestId,
          item_id: "task:copilot-direct",
          kind: "task",
          status,
          label: "Copilot ACP",
          summary: clipText(summary, 260),
        });
      };
      const requestShutdown = () => {
        if (closed) {
          return;
        }
        for (const pending of pendingRequests.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Copilot ACP request '${pending.method}' canceled during shutdown.`));
        }
        pendingRequests.clear();
        try {
          child.stdin.end();
        } catch {
          // Best effort shutdown.
        }
        setTimeout(() => {
          if (!closed) {
            terminateChildProcessTree(child);
          }
        }, SHUTDOWN_GRACE_MS);
      };
      const sendMessage = (payload: Record<string, unknown>) => {
        if (closed || child.stdin.destroyed || child.killed) {
          throw new Error("Copilot ACP stdin is unavailable.");
        }
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      };
      const sendRequest = async (method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> => {
        const id: JsonRpcId = String(nextRequestId++);
        return await new Promise((resolveRequest, rejectRequest) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(String(id));
            rejectRequest(new Error(`Timed out waiting for Copilot ACP response to '${method}'.`));
          }, timeoutMs);
          pendingRequests.set(String(id), {
            method,
            resolve: resolveRequest,
            reject: rejectRequest,
            timer,
          });
          try {
            sendMessage({ id, method, params });
          } catch (error) {
            clearTimeout(timer);
            pendingRequests.delete(String(id));
            rejectRequest(error instanceof Error ? error : new Error(String(error)));
          }
        });
      };
      const sendRequestWithFallback = async (
        methods: string[],
        params: Record<string, unknown>,
        timeoutMs: number,
      ): Promise<unknown> => {
        let lastError: unknown;
        for (const method of methods) {
          try {
            return await sendRequest(method, params, timeoutMs);
          } catch (error) {
            lastError = error;
            const detail = error instanceof Error ? error.message : String(error);
            if (!/method.*not found|-32601|unsupported|unknown method/i.test(detail)) {
              throw error;
            }
          }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      };
      const sendResponse = (id: JsonRpcId, result?: unknown, error?: { code: number; message: string }) => {
        sendMessage(error ? { id, error } : { id, result: result ?? {} });
      };

      const handleSessionUpdate = (params: Record<string, unknown>) => {
        const update = getSessionUpdatePayload(params);
        if (!update) {
          return;
        }
        activeSessionId = activeSessionId || extractSessionId(params) || extractSessionId(update);
        activeRequestId = activeRequestId || extractRequestId(params) || extractRequestId(update);
        const updateType = String(update.sessionUpdate || update.updateType || update.type || "").trim().toLowerCase();
        if (updateType === "agent_message_chunk") {
          const text = extractContentText(update.content) || extractAssistantText(update);
          if (text) {
            hooks.onOutput("stdout", text);
            emitTask("in_progress", "Streaming assistant response");
            emitRuntime("running", { turnStatus: "inProgress" });
          }
          return;
        }
        if (updateType === "agent_thought_chunk" || updateType === "thought") {
          hooks.onActivity?.({
            at: nowIso(),
            turn_id: activeRequestId,
            item_id: "thinking:copilot-direct",
            kind: "thinking",
            status: "in_progress",
            label: "Thinking",
            summary: clipText(extractContentText(update.content) || extractAssistantText(update) || "Thinking", 280),
          });
          return;
        }
        if (updateType === "plan") {
          hooks.onActivity?.({
            at: nowIso(),
            turn_id: activeRequestId,
            item_id: extractString(update, ["planId", "plan_id"]) || "plan:copilot-direct",
            kind: "plan",
            status: mapActivityStatus(update.status),
            label: "Plan",
            summary: clipText(extractString(update, ["title", "description"]) || "Plan updated", 260),
            plan_steps: extractPlanSteps(update),
          });
          return;
        }
        if (updateType === "tool_call" || updateType === "tool_call_update") {
          hooks.onActivity?.(buildToolActivity(update, activeRequestId));
          return;
        }
        const fallbackText = extractAssistantText(update);
        if (fallbackText) {
          hooks.onOutput("stdout", fallbackText);
          emitTask("in_progress", "Streaming assistant response");
          emitRuntime("running", { turnStatus: "inProgress" });
        }
      };

      const handleInboundRequest = async (id: JsonRpcId, method: string, params: Record<string, unknown>) => {
        const normalizedMethod = method.trim().toLowerCase();
        try {
          if (
            normalizedMethod === "requestpermission"
            || normalizedMethod === "session/request_permission"
            || normalizedMethod === "session/requestpermission"
          ) {
            const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
            const optionId = selectCopilotPermissionOptionId(options);
            if (optionId) {
              hooks.onOutput("stderr", "[copilot-direct] Auto-approved ACP permission request.\n");
              sendResponse(id, { outcome: { outcome: "selected", optionId } });
            } else {
              hooks.onOutput("stderr", "[copilot-direct] No allow option found for ACP permission request; cancelling.\n");
              sendResponse(id, { outcome: { outcome: "cancelled" } });
            }
            return;
          }
          sendResponse(id, undefined, {
            code: -32601,
            message: `Unsupported Copilot ACP client method '${method}'.`,
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
        if (normalizedMethod === "sessionupdate" || normalizedMethod === "session/update") {
          handleSessionUpdate(params);
          return;
        }
        if (normalizedMethod.includes("error")) {
          const message = clipText(extractString(params, ["message", "detail", "error"]), 400)
            || "Copilot ACP notification error";
          hooks.onOutput("stderr", `${message}\n`);
          emitTask("failed", message);
          emitRuntime("failed", { turnStatus: "failed", lastError: message });
          return;
        }
        const text = extractAssistantText(params);
        if (text) {
          hooks.onOutput("stdout", text);
          emitTask("in_progress", "Streaming assistant response");
          emitRuntime("running", { turnStatus: "inProgress" });
        }
        if (
          normalizedMethod.includes("complete")
          || normalizedMethod.includes("finished")
          || normalizedMethod.includes("done")
          || normalizedMethod.includes("ended")
        ) {
          emitTask("completed", "Copilot ACP turn completed");
          emitRuntime("completed", { turnStatus: "completed" });
          requestShutdown();
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
            const detail = clipText(extractString(errorRecord, ["message", "detail", "error"]) || message.error, 500)
              || `Copilot ACP request '${pending.method}' failed.`;
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

      const processStdoutText = (text: string) => {
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
          } else {
            hooks.onOutput("stderr", `[copilot-direct] Ignored non-JSON ACP line: ${line}\n`);
          }
        }
      };

      const bootstrap = async () => {
        emitRuntime("starting");
        const initializeResult = await sendRequest("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "agentchatbus-ts", version: BUS_VERSION },
          clientCapabilities: {},
        }, INITIALIZE_TIMEOUT_MS).catch(async () => await sendRequest("initialize", {
          protocolVersion: "0.2",
          clientInfo: { name: "agentchatbus-ts", version: BUS_VERSION },
          clientCapabilities: {},
        }, INITIALIZE_TIMEOUT_MS));

        activeSessionId = activeSessionId || extractSessionId(initializeResult);
        loadSessionSupported = supportsLoadSessionCapability(initializeResult);
        emitTask("in_progress", "Connected to Copilot ACP.");
        emitRuntime("running", { turnStatus: "inProgress" });

        if (activeSessionId && loadSessionSupported) {
          try {
            await sendRequestWithFallback(["loadSession", "session/load"], {
              sessionId: activeSessionId,
              cwd: request.workspace,
              mcpServers: [],
            }, LOAD_TIMEOUT_MS);
          } catch {
            activeSessionId = undefined;
          }
        }
        if (!activeSessionId) {
          const sessionResult = await sendRequestWithFallback(["newSession", "session/new"], {
            cwd: request.workspace,
            mcpServers: [],
          }, NEW_SESSION_TIMEOUT_MS);
          activeSessionId = extractSessionId(sessionResult) || activeSessionId;
        }
        if (!activeSessionId) {
          throw new Error("Copilot ACP did not return a session id from initialize/session methods.");
        }

        const promptResult = await sendRequestWithFallback(["prompt", "session/prompt"], {
          sessionId: activeSessionId,
          prompt: [{ type: "text", text: request.prompt }],
        }, PROMPT_TIMEOUT_MS).catch(async () => await sendRequestWithFallback(["prompt", "session/prompt"], {
          sessionId: activeSessionId,
          prompt: request.prompt,
        }, PROMPT_TIMEOUT_MS));
        activeRequestId = extractRequestId(promptResult) || activeRequestId;
        emitRuntime("running", { turnStatus: "inProgress" });
      };

      hooks.onControls({ kill: requestShutdown });
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
      child.on("error", (error) => fail(error));
      child.on("close", (code) => {
        closed = true;
        for (const pending of pendingRequests.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Copilot ACP request '${pending.method}' canceled because process exited.`));
        }
        pendingRequests.clear();
        finalize({ exitCode: typeof code === "number" ? code : null, stdout, stderr });
      });
      hooks.signal.addEventListener("abort", requestShutdown, { once: true });
      void bootstrap().catch((error) => {
        requestShutdown();
        fail(error);
      });
    });
  }
}

export class CopilotDirectAdapter implements CliSessionAdapter {
  readonly adapterId = "copilot" as const;
  readonly mode = "direct" as const;
  readonly supportsInput = false;
  readonly supportsRestart = true;
  readonly supportsResize = false;
  readonly requiresPrompt = true;

  constructor(
    private readonly executor: CopilotDirectExecutor = new DefaultCopilotDirectExecutor(),
    private readonly command = resolveCopilotHeadlessCommand(),
  ) {}

  async run(input: CliAdapterRunInput, hooks: CliAdapterRunHooks): Promise<CliAdapterRunResult> {
    const workspace = normalizeWorkspacePath(input.workspace);
    let execution: { exitCode: number | null; stdout: string; stderr: string };
    try {
      execution = await this.executor.run(
        { command: this.command, prompt: input.prompt, workspace, env: input.env },
        hooks,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Copilot direct ACP launch failed via '${this.command}': ${detail}`);
    }

    const parsed = parseCopilotDirectResult(execution.stdout);
    const persistedSessionId = String(input.env?.[COPILOT_SESSION_ID_ENV_VAR] || "").trim() || undefined;
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
