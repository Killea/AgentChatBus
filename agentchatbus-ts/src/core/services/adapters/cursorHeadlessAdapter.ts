import { existsSync } from "node:fs";
import { dirname } from "node:path";
import spawn from "cross-spawn";
import { getConfig } from "../../config/registry.js";
import type { CliSessionAdapter, CliAdapterRunInput, CliAdapterRunHooks, CliAdapterRunResult } from "./types.js";
import { WINDOWS_POWERSHELL } from "./constants.js";
import { normalizeWorkspacePath, terminateChildProcessTree } from "./utils.js";

export const CURSOR_SESSION_ID_ENV_VAR = "AGENTCHATBUS_CURSOR_SESSION_ID";

type CursorCommandRequest = {
  command: string;
  prompt: string;
  workspace: string;
  model?: string;
  env?: Record<string, string>;
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

export function parseCursorHeadlessResult(stdout: string): CursorResultEnvelope {
  const lines = String(stdout || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return {
      rawResult: null,
      resultText: "",
    };
  }

  let sessionId: string | undefined;
  let requestId: string | undefined;
  let lastAssistantText: string | undefined;
  const errors: string[] = [];
  let eventCount = 0;
  let ignoredLineCount = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      eventCount += 1;

      if (!sessionId) {
        const sessionIdCandidate = [
          parsed.session_id,
          parsed.chat_id,
          parsed.conversation_id,
          parsed.sessionId,
          parsed.chatId,
        ].find((value) => typeof value === "string");
        if (typeof sessionIdCandidate === "string" && sessionIdCandidate.trim()) {
          sessionId = sessionIdCandidate.trim();
        }
      }

      if (!requestId) {
        const requestIdCandidate = [parsed.request_id, parsed.requestId].find(
          (value) => typeof value === "string",
        );
        if (typeof requestIdCandidate === "string" && requestIdCandidate.trim()) {
          requestId = requestIdCandidate.trim();
        }
      }

      const eventType = String(parsed.type || "").trim().toLowerCase();
      if (
        typeof parsed.result === "string"
        && parsed.result.trim()
        && (eventType === "result" || eventType === "final")
      ) {
        lastAssistantText = parsed.result;
        continue;
      }

      if (
        typeof parsed.text === "string"
        && parsed.text.trim()
        && (eventType.includes("assistant") || eventType.includes("message") || eventType === "result")
      ) {
        lastAssistantText = parsed.text;
        continue;
      }

      if (typeof parsed.message === "string" && parsed.message.trim()) {
        if (eventType.includes("error")) {
          errors.push(parsed.message);
        } else if (eventType === "result" && !lastAssistantText) {
          lastAssistantText = parsed.message;
        }
      }
    } catch {
      ignoredLineCount += 1;
    }
  }

  if (!eventCount) {
    return {
      rawResult: null,
      resultText: lines.join("\n"),
    };
  }

  return {
    rawResult: {
      session_id: sessionId || null,
      request_id: requestId || null,
      event_count: eventCount,
      last_assistant_text: lastAssistantText || null,
      errors,
      ignored_line_count: ignoredLineCount,
    },
    resultText: lastAssistantText || "",
    sessionId,
    requestId,
  };
}

export function resolveCursorAgentCommand(): string {
  const configured = String(getConfig().cursorAgentCommand || "").trim();
  if (configured) {
    return configured;
  }
  return "agent";
}

class CursorHeadlessExecutor implements CursorCommandExecutor {
  async run(request: CursorCommandRequest, hooks: CliAdapterRunHooks): Promise<CursorCommandExecutionResult> {
    return await new Promise<CursorCommandExecutionResult>((resolve, reject) => {
      const resumeSessionId = String(request.env?.[CURSOR_SESSION_ID_ENV_VAR] || "").trim();
      const requestedModel = String(request.model || "").trim();
      const cursorArgs = [
        "--force",
        "--approve-mcps",
        ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
        ...(requestedModel ? ["--model", requestedModel] : []),
        "-p",
        "--output-format",
        "stream-json",
        "-f",
        "--trust",
        "--workspace",
        request.workspace,
        request.prompt,
      ];
      const isWindows = process.platform === "win32";
      const isPowerShellShim = isWindows && /\.ps1$/i.test(request.command);
      const command = isWindows && isPowerShellShim ? WINDOWS_POWERSHELL : request.command;
      const args = isWindows
        ? (isPowerShellShim
          ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", request.command, ...cursorArgs]
          : cursorArgs)
        : cursorArgs;
      const env = { ...process.env, ...(request as { env?: Record<string, string> }).env };
      if (isWindows) {
        const commandDir = dirname(request.command);
        const currentPath = String(env.Path || env.PATH || "");
        if (commandDir && !currentPath.toLowerCase().includes(commandDir.toLowerCase())) {
          env.Path = `${commandDir};${currentPath}`;
          env.PATH = env.Path;
        }
      }

      let child: ReturnType<typeof spawn>;
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
          terminateChildProcessTree(child);
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
          terminateChildProcessTree(child);
        },
        { once: true }
      );
    });
  }
}

export class CursorHeadlessAdapter implements CliSessionAdapter {
  readonly adapterId = "cursor" as const;
  readonly mode = "headless" as const;
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
          model: input.model,
          env: input.env,
        },
        hooks
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cursor headless launch failed via '${this.command}': ${detail}`);
    }
    const parsed = parseCursorHeadlessResult(execution.stdout);
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
