import { execFileSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { TextDecoder } from "node:util";
import spawn from "cross-spawn";
import { getConfig } from "../../config/registry.js";
import type { CliSessionAdapter, CliAdapterRunInput, CliAdapterRunHooks, CliAdapterRunResult } from "./types.js";
import { WINDOWS_POWERSHELL } from "./constants.js";
import { normalizeWorkspacePath, terminateChildProcessTree } from "./utils.js";

export const CODEX_THREAD_ID_ENV_VAR = "AGENTCHATBUS_CODEX_THREAD_ID";

type CodexCommandRequest = {
  command: string;
  prompt: string;
  workspace: string;
  env?: Record<string, string>;
};

type CodexCommandExecutionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type CodexResultEnvelope = {
  resultText?: string;
  rawResult?: Record<string, unknown> | null;
  threadId?: string;
};

const WINDOWS_LEGACY_TEXT_DECODER = (() => {
  if (process.platform !== "win32") {
    return null;
  }
  try {
    return new TextDecoder("gb18030");
  } catch {
    return null;
  }
})();

interface CodexCommandExecutor {
  run(request: CodexCommandRequest, hooks: CliAdapterRunHooks): Promise<CodexCommandExecutionResult>;
}

function resolveCodexHeadlessCommand(): string {
  const configured = String(getConfig().codexCommand || "").trim();
  if (configured) {
    return configured;
  }
  if (process.platform === "win32") {
    try {
      const output = execFileSync("where.exe", ["codex"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const matches = String(output || "")
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      const executableCandidates: string[] = [];
      const scriptCandidates: string[] = [];
      const fallbackCandidates: string[] = [];
      for (const match of matches) {
        if (/\.exe$/i.test(match)) {
          executableCandidates.push(match);
          continue;
        }
        if (/\.cmd$/i.test(match)) {
          scriptCandidates.push(match);
          continue;
        }
        if (/\.ps1$/i.test(match)) {
          fallbackCandidates.push(match);
          continue;
        }
        executableCandidates.push(`${match}.exe`);
        scriptCandidates.push(`${match}.cmd`);
        fallbackCandidates.push(`${match}.ps1`);
      }
      const candidates = [
        ...executableCandidates,
        ...scriptCandidates,
        ...fallbackCandidates,
      ];
      const existing = candidates.find((candidate) => existsSync(candidate));
      if (existing) {
        return existing;
      }
    } catch {
      // Fall back to the shared resolver result below.
    }
  }
  const resolved = resolveCodexCommand();
  if (/\.ps1$/i.test(resolved)) {
    const exeVariant = resolved.replace(/\.ps1$/i, ".exe");
    if (existsSync(exeVariant)) {
      return exeVariant;
    }
    const cmdVariant = resolved.replace(/\.ps1$/i, ".cmd");
    if (existsSync(cmdVariant)) {
      return cmdVariant;
    }
  }
  if (/\.cmd$/i.test(resolved)) {
    const exeVariant = resolved.replace(/\.cmd$/i, ".exe");
    if (existsSync(exeVariant)) {
      return exeVariant;
    }
  }
  return resolved;
}

function resolveCodexCommand(): string {
  const configured = String(getConfig().codexCommand || "").trim();
  if (configured) {
    return configured;
  }
  if (process.platform === "win32") {
    try {
      const output = execFileSync("where.exe", ["codex"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const matches = String(output || "")
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      for (const match of matches) {
        const candidates = /\.ps1$/i.test(match)
          ? [match, match.replace(/\.ps1$/i, ".exe"), match.replace(/\.ps1$/i, ".cmd")]
          : /\.cmd$/i.test(match)
            ? [match.replace(/\.cmd$/i, ".exe"), match, match.replace(/\.cmd$/i, ".ps1")]
            : /\.exe$/i.test(match)
              ? [match, match.replace(/\.exe$/i, ".cmd"), match.replace(/\.exe$/i, ".ps1")]
              : [`${match}.exe`, `${match}.cmd`, `${match}.ps1`, match];
        const existing = candidates.find((candidate) => existsSync(candidate));
        if (existing) {
          return existing;
        }
      }
    } catch {
      // Fall back to PATH lookup below.
    }
  }
  return "codex";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function splitOutputLines(value: string): string[] {
  return String(value || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function countReplacementCharacters(value: string): number {
  return (String(value || "").match(/�/gu) || []).length;
}

function containsReadableCjk(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(String(value || ""));
}

export function preferWindowsDecodedText(utf8Text: string, legacyText: string): string {
  const preferredUtf8 = String(utf8Text || "");
  const preferredLegacy = String(legacyText || "");
  if (!preferredLegacy) {
    return preferredUtf8;
  }

  const utf8ReplacementCount = countReplacementCharacters(preferredUtf8);
  const legacyReplacementCount = countReplacementCharacters(preferredLegacy);
  if (utf8ReplacementCount === 0 && legacyReplacementCount > 0) {
    return preferredUtf8;
  }
  if (legacyReplacementCount < utf8ReplacementCount) {
    return preferredLegacy;
  }
  if (utf8ReplacementCount > 0 && containsReadableCjk(preferredLegacy)) {
    return preferredLegacy;
  }
  return preferredUtf8;
}

function decodeProcessChunk(chunk: unknown): string {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""));
  const utf8Text = buffer.toString("utf8");
  if (!WINDOWS_LEGACY_TEXT_DECODER || !utf8Text.includes("�")) {
    return utf8Text;
  }
  const legacyText = WINDOWS_LEGACY_TEXT_DECODER.decode(buffer);
  return preferWindowsDecodedText(utf8Text, legacyText);
}

export function parseCodexExecJsonResult(stdout: string): CodexResultEnvelope {
  const lines = splitOutputLines(stdout);
  if (!lines.length) {
    return {
      rawResult: null,
      resultText: "",
    };
  }

  let threadId: string | undefined;
  let lastAgentMessage: string | undefined;
  const errors: string[] = [];
  let eventCount = 0;
  let ignoredLineCount = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      eventCount += 1;

      if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
        threadId = parsed.thread_id;
      }

      if (parsed.type !== "item.completed" || !isObjectRecord(parsed.item)) {
        continue;
      }

      const item = parsed.item;
      if (item.type === "agent_message" && typeof item.text === "string") {
        lastAgentMessage = item.text;
        continue;
      }

      if (item.type === "error" && typeof item.message === "string") {
        errors.push(item.message);
      }
    } catch {
      ignoredLineCount += 1;
    }
  }

  const rawResult: Record<string, unknown> | null = eventCount > 0
    ? {
        thread_id: threadId || null,
        event_count: eventCount,
        last_agent_message: lastAgentMessage || null,
        errors,
        ignored_line_count: ignoredLineCount,
      }
    : null;

  return {
    rawResult,
    resultText: lastAgentMessage || "",
    threadId,
  };
}

class CodexHeadlessExecutor implements CodexCommandExecutor {
  async run(request: CodexCommandRequest, hooks: CliAdapterRunHooks): Promise<CodexCommandExecutionResult> {
    return await new Promise<CodexCommandExecutionResult>((resolve, reject) => {
      const resumeThreadId = String(request.env?.[CODEX_THREAD_ID_ENV_VAR] || "").trim();
      const codexArgs = resumeThreadId
        ? ["exec", "resume", "--json", "--skip-git-repo-check", resumeThreadId, "-"]
        : ["exec", "--json", "--skip-git-repo-check", "-C", request.workspace, "-"];

      const env = { ...process.env, ...(request.env || {}) };
      const isWindows = process.platform === "win32";
      const isPowerShellShim = isWindows && /\.ps1$/i.test(request.command);
      const command = isWindows
        ? (isPowerShellShim ? WINDOWS_POWERSHELL : request.command)
        : request.command;
      const args = isWindows
        ? (isPowerShellShim
          ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", request.command, ...codexArgs]
          : codexArgs)
        : codexArgs;

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

      const finalize = (result: CodexCommandExecutionResult) => {
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
        const text = decodeProcessChunk(chunk);
        stdout += text;
        hooks.onOutput("stdout", text);
      });

      child.stderr.on("data", (chunk) => {
        const text = decodeProcessChunk(chunk);
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

      try {
        child.stdin.write(request.prompt);
        child.stdin.end();
      } catch (error) {
        fail(error);
      }
    });
  }
}

export class CodexHeadlessAdapter implements CliSessionAdapter {
  readonly adapterId = "codex" as const;
  readonly mode = "headless" as const;
  readonly supportsInput = false;
  readonly supportsRestart = true;
  readonly supportsResize = false;
  readonly requiresPrompt = true;

  constructor(
    private readonly executor: CodexCommandExecutor = new CodexHeadlessExecutor(),
    private readonly command?: string,
  ) {}

  async run(input: CliAdapterRunInput, hooks: CliAdapterRunHooks): Promise<CliAdapterRunResult> {
    const workspace = normalizeWorkspacePath(input.workspace);
    const command = this.command || resolveCodexHeadlessCommand();
    let execution: CodexCommandExecutionResult;
    try {
      execution = await this.executor.run(
        {
          command,
          prompt: input.prompt,
          workspace,
          env: input.env,
        },
        hooks,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Codex headless launch failed via '${command}': ${detail}`);
    }

    const parsed = parseCodexExecJsonResult(execution.stdout);
    const persistedThreadId = String(input.env?.[CODEX_THREAD_ID_ENV_VAR] || "").trim() || undefined;

    return {
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      resultText: parsed.resultText,
      rawResult: parsed.rawResult,
      externalSessionId: parsed.threadId || persistedThreadId,
    };
  }
}
