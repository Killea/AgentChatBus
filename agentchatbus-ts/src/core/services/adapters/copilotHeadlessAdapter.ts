import { existsSync } from "node:fs";
import { dirname } from "node:path";
import spawn from "cross-spawn";
import { getConfig } from "../../config/registry.js";
import type { CliSessionAdapter, CliAdapterRunInput, CliAdapterRunHooks, CliAdapterRunResult } from "./types.js";
import { WINDOWS_POWERSHELL } from "./constants.js";
import { normalizeWorkspacePath, terminateChildProcessTree } from "./utils.js";

export const COPILOT_SESSION_ID_ENV_VAR = "AGENTCHATBUS_COPILOT_SESSION_ID";

type CopilotCommandRequest = {
  command: string;
  prompt: string;
  workspace: string;
  model?: string;
  env?: Record<string, string>;
};

type CopilotCommandExecutionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type CopilotResultEnvelope = {
  resultText?: string;
  rawResult?: Record<string, unknown> | null;
  sessionId?: string;
  requestId?: string;
};

interface CopilotCommandExecutor {
  run(request: CopilotCommandRequest, hooks: CliAdapterRunHooks): Promise<CopilotCommandExecutionResult>;
}

function splitOutputLines(value: string): string[] {
  return String(value || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseCopilotHeadlessResult(stdout: string): CopilotResultEnvelope {
  const lines = splitOutputLines(stdout);
  if (!lines.length) {
    return {
      rawResult: null,
      resultText: "",
    };
  }

  let sessionId: string | undefined;
  let requestId: string | undefined;
  let lastAgentMessage: string | undefined;
  const errors: string[] = [];
  let eventCount = 0;
  let ignoredLineCount = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      eventCount += 1;

      const sessionIdCandidate = [
        parsed.session_id,
        parsed.sessionId,
        parsed.thread_id,
        parsed.chat_id,
      ].find((value) => typeof value === "string");
      if (!sessionId && typeof sessionIdCandidate === "string" && sessionIdCandidate.trim()) {
        sessionId = sessionIdCandidate.trim();
      }

      const requestIdCandidate = [parsed.request_id, parsed.requestId].find(
        (value) => typeof value === "string",
      );
      if (!requestId && typeof requestIdCandidate === "string" && requestIdCandidate.trim()) {
        requestId = requestIdCandidate.trim();
      }

      const eventType = String(parsed.type || "").trim().toLowerCase();
      const item = parsed.item;
      if (eventType === "item.completed" && item && typeof item === "object" && !Array.isArray(item)) {
        const itemType = String((item as Record<string, unknown>).type || "").trim().toLowerCase();
        if (itemType === "agent_message" && typeof (item as Record<string, unknown>).text === "string") {
          lastAgentMessage = String((item as Record<string, unknown>).text);
          continue;
        }
        if (itemType === "error" && typeof (item as Record<string, unknown>).message === "string") {
          errors.push(String((item as Record<string, unknown>).message));
          continue;
        }
      }

      if (typeof parsed.result === "string" && parsed.result.trim()) {
        lastAgentMessage = parsed.result;
      } else if (typeof parsed.text === "string" && parsed.text.trim() && eventType.includes("message")) {
        lastAgentMessage = parsed.text;
      } else if (typeof parsed.message === "string" && parsed.message.trim() && eventType.includes("error")) {
        errors.push(parsed.message);
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
      last_agent_message: lastAgentMessage || null,
      errors,
      ignored_line_count: ignoredLineCount,
    },
    resultText: lastAgentMessage || "",
    sessionId,
    requestId,
  };
}

export function resolveCopilotHeadlessCommand(): string {
  const configured = String(getConfig().copilotCommand || "").trim();
  if (configured) {
    return configured;
  }
  return "copilot";
}

class CopilotHeadlessExecutor implements CopilotCommandExecutor {
  async run(request: CopilotCommandRequest, hooks: CliAdapterRunHooks): Promise<CopilotCommandExecutionResult> {
    return await new Promise<CopilotCommandExecutionResult>((resolve, reject) => {
      const resumeSessionId = String(request.env?.[COPILOT_SESSION_ID_ENV_VAR] || "").trim();
      const requestedModel = String(request.model || "").trim() || "gpt-5-mini";
      const copilotArgs = [
        "--model",
        requestedModel,
        "--output-format",
        "json",
        "--yolo",
        "--disable-builtin-mcps",
        "--no-custom-instructions",
        ...(resumeSessionId ? [`--resume=${resumeSessionId}`] : []),
        "-p",
        request.prompt,
      ];

      const env = { ...process.env, ...(request.env || {}) };
      const isWindows = process.platform === "win32";
      const isPowerShellShim = isWindows && /\.ps1$/i.test(request.command);
      const command = isWindows && isPowerShellShim ? WINDOWS_POWERSHELL : request.command;
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

      const finalize = (result: CopilotCommandExecutionResult) => {
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
        { once: true },
      );
    });
  }
}

export class CopilotHeadlessAdapter implements CliSessionAdapter {
  readonly adapterId = "copilot" as const;
  readonly mode = "headless" as const;
  readonly supportsInput = false;
  readonly supportsRestart = true;
  readonly supportsResize = false;
  readonly requiresPrompt = true;

  constructor(
    private readonly executor: CopilotCommandExecutor = new CopilotHeadlessExecutor(),
    private readonly command = resolveCopilotHeadlessCommand(),
  ) {}

  async run(input: CliAdapterRunInput, hooks: CliAdapterRunHooks): Promise<CliAdapterRunResult> {
    const workspace = normalizeWorkspacePath(input.workspace);
    let execution: CopilotCommandExecutionResult;
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
      throw new Error(`Copilot headless launch failed via '${this.command}': ${detail}`);
    }

    const parsed = parseCopilotHeadlessResult(execution.stdout);
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
