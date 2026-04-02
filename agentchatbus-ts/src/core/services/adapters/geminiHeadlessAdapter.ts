import { dirname } from "node:path";
import { existsSync } from "node:fs";
import spawn from "cross-spawn";
import type { CliSessionAdapter, CliAdapterRunInput, CliAdapterRunHooks, CliAdapterRunResult } from "./types.js";
import { normalizeWorkspacePath, terminateChildProcessTree } from "./utils.js";
import { WINDOWS_POWERSHELL } from "./constants.js";
import { getConfig } from "../../config/registry.js";

export const GEMINI_SESSION_ID_ENV_VAR = "AGENTCHATBUS_GEMINI_SESSION_ID";

type GeminiCommandRequest = {
  command: string;
  prompt: string;
  workspace: string;
  model?: string;
  env?: Record<string, string>;
};

type GeminiCommandExecutionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type GeminiResultEnvelope = {
  resultText?: string;
  rawResult?: Record<string, unknown> | null;
  sessionId?: string;
  requestId?: string;
};

interface GeminiCommandExecutor {
  run(request: GeminiCommandRequest, hooks: CliAdapterRunHooks): Promise<GeminiCommandExecutionResult>;
}

function splitOutputLines(value: string): string[] {
  return String(value || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseGeminiHeadlessResult(stdout: string): GeminiResultEnvelope {
  const lines = splitOutputLines(stdout);
  if (!lines.length) {
    return {
      rawResult: null,
      resultText: "",
    };
  }

  let sessionId: string | undefined;
  let requestId: string | undefined;
  let resultText: string | undefined;
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
        parsed.chat_id,
        parsed.conversation_id,
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

      if (typeof parsed.result === "string" && parsed.result.trim()) {
        resultText = parsed.result;
        continue;
      }
      if (typeof parsed.text === "string" && parsed.text.trim()) {
        resultText = parsed.text;
        continue;
      }
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        const eventType = String(parsed.type || "").trim().toLowerCase();
        if (eventType.includes("error")) {
          errors.push(parsed.message);
        } else if (!resultText) {
          resultText = parsed.message;
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
      result: resultText || null,
      errors,
      ignored_line_count: ignoredLineCount,
    },
    resultText: resultText || "",
    sessionId,
    requestId,
  };
}

export function resolveGeminiHeadlessCommand(): string {
  const configured = String(getConfig().geminiCommand || "").trim();
  if (configured) {
    return configured;
  }
  return "gemini";
}

class GeminiHeadlessExecutor implements GeminiCommandExecutor {
  async run(request: GeminiCommandRequest, hooks: CliAdapterRunHooks): Promise<GeminiCommandExecutionResult> {
    return await new Promise<GeminiCommandExecutionResult>((resolve, reject) => {
      const resumeSessionId = String(request.env?.[GEMINI_SESSION_ID_ENV_VAR] || "").trim();
      const requestedModel = String(request.model || "").trim();
      const geminiArgs = [
        ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
        ...(requestedModel ? ["-m", requestedModel] : []),
        "-p",
        request.prompt,
        "--output-format",
        "json",
      ];

      const env = { ...process.env, ...(request.env || {}) };
      const isWindows = process.platform === "win32";
      const isPowerShellShim = isWindows && /\.ps1$/i.test(request.command);
      const command = isWindows && isPowerShellShim ? WINDOWS_POWERSHELL : request.command;
      const args = isWindows
        ? (isPowerShellShim
          ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", request.command, ...geminiArgs]
          : geminiArgs)
        : geminiArgs;

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

      const finalize = (result: GeminiCommandExecutionResult) => {
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

export class GeminiHeadlessAdapter implements CliSessionAdapter {
  readonly adapterId = "gemini" as const;
  readonly mode = "headless" as const;
  readonly supportsInput = false;
  readonly supportsRestart = true;
  readonly supportsResize = false;
  readonly requiresPrompt = true;

  constructor(
    private readonly executor: GeminiCommandExecutor = new GeminiHeadlessExecutor(),
    private readonly command = resolveGeminiHeadlessCommand(),
  ) {}

  async run(input: CliAdapterRunInput, hooks: CliAdapterRunHooks): Promise<CliAdapterRunResult> {
    const workspace = normalizeWorkspacePath(input.workspace);
    let execution: GeminiCommandExecutionResult;
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
      throw new Error(`Gemini headless launch failed via '${this.command}': ${detail}`);
    }

    const parsed = parseGeminiHeadlessResult(execution.stdout);
    const persistedSessionId = String(input.env?.[GEMINI_SESSION_ID_ENV_VAR] || "").trim() || undefined;

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
