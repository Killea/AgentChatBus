import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import spawn from "cross-spawn";
import { BUS_VERSION } from "../../config/env.js";
import type { CliSessionAdapter, CliAdapterRunInput, CliAdapterRunHooks, CliAdapterRunResult } from "./types.js";
import { WINDOWS_POWERSHELL } from "./constants.js";
import { normalizeWorkspacePath, terminateChildProcessTree } from "./utils.js";
import { CODEX_THREAD_ID_ENV_VAR, resolveCodexHeadlessCommand } from "./codexHeadlessAdapter.js";

type JsonRpcId = string | number;

type CodexDirectCommandRequest = {
  command: string;
  prompt: string;
  workspace: string;
  model?: string;
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
  if (isObjectRecord(value.thread) && typeof value.thread.id === "string" && value.thread.id.trim()) {
    return value.thread.id.trim();
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
  if (!isObjectRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    return undefined;
  }
  return value.id.trim();
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

      if (method === "item/agentMessage/delta") {
        const itemId = typeof params.itemId === "string" ? params.itemId.trim() : "";
        const delta = typeof params.delta === "string" ? params.delta : "";
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

      if (
        method === "error"
        && params.error !== undefined
        && params.error !== null
      ) {
        const errorSummary = formatCodexErrorSummary(params.error);
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
      const pendingRequests = new Map<
        string,
        {
          method: string;
          resolve: (value: unknown) => void;
          reject: (error: unknown) => void;
          timer: NodeJS.Timeout;
        }
      >();

      const clearPendingRequests = (error?: unknown) => {
        const pendingError = error ?? new Error(
          "Codex app-server closed before pending requests could complete.",
        );
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
        if (method === "item/commandExecution/requestApproval") {
          sendResponse(requestId, {
            decision: "acceptForSession",
          });
          return;
        }
        if (method === "item/fileChange/requestApproval") {
          sendResponse(requestId, {
            decision: "acceptForSession",
          });
          return;
        }
        if (method === "mcpServer/elicitation/request") {
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
          sendResponse(requestId, {
            action: elicitation.action,
            content: elicitation.content,
            _meta: elicitation._meta,
          });
          return;
        }
        const label = normalizeServerRequestLabel(method);
        emitStderr(`[codex-direct] Unsupported app-server callback: ${label}. Continuing without handling it.\n`);
        sendErrorResponse(
          requestId,
          `AgentChatBus direct adapter does not handle '${method}' yet.`,
        );
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

        if (method === "thread/started") {
          const nextThreadId = extractThreadIdFromPayload(params);
          if (nextThreadId) {
            activeThreadId = nextThreadId;
          }
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

        if (method === "error" && params.error !== undefined && params.error !== null) {
          emitStderr(`${formatCodexErrorSummary(params.error)}\n`);
          return;
        }

        if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
          const itemId = typeof params.itemId === "string" ? params.itemId.trim() : "";
          if (itemId) {
            streamedAgentMessageItemIds.add(itemId);
          }
          hooks.onOutput("stdout", params.delta);
          return;
        }

        if (method === "item/commandExecution/outputDelta" && typeof params.delta === "string") {
          hooks.onOutput("stdout", params.delta);
          return;
        }

        if (method === "item/fileChange/outputDelta" && typeof params.delta === "string") {
          hooks.onOutput("stdout", params.delta);
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
