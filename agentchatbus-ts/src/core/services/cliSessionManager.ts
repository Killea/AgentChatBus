import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import * as nodePty from "node-pty";
import type { IPty } from "node-pty";
import { eventBus } from "../../shared/eventBus.js";
import { logError, logInfo } from "../../shared/logger.js";

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
  workspace: string;
  requested_by_agent_id: string;
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
  workspace?: string;
  requestedByAgentId: string;
  cols?: number;
  rows?: number;
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
const WINDOWS_POWERSHELL =
  `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const ANSI_CSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const ANSI_SINGLE_CHAR_SEQUENCE = /\u001b[@-_]/g;

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

function normalizeWorkspacePath(explicitPath?: string): string {
  const direct = String(explicitPath || "").trim();
  if (direct) {
    return direct;
  }
  const envPath = String(process.env.AGENTCHATBUS_CLI_WORKSPACE || "").trim();
  if (envPath) {
    return envPath;
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
  const configured = String(process.env.AGENTCHATBUS_CURSOR_AGENT_COMMAND || "").trim();
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
  const configured = String(process.env.AGENTCHATBUS_CODEX_COMMAND || "").trim();
  return configured || "codex";
}

function shouldUseConpty(): boolean {
  const raw = String(process.env.AGENTCHATBUS_PTY_USE_CONPTY || "").trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return !["0", "false", "no", "off"].includes(raw);
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
    return await new Promise<CliAdapterRunResult>((resolve, reject) => {
      const commandParts = [
        `& ${toPowerShellSingleQuoted(this.codexCommand)}`,
        "--no-alt-screen",
        "-C",
        toPowerShellSingleQuoted(input.workspace),
      ];
      const prompt = String(input.prompt || "");
      if (prompt) {
        commandParts.push(toPowerShellSingleQuoted(prompt));
      }

      let terminal: IPty | null = null;
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
    const snapshot: CliSessionSnapshot = {
      id: randomUUID(),
      thread_id: input.threadId,
      adapter: adapterId,
      mode,
      state: "created",
      prompt,
      workspace,
      requested_by_agent_id: input.requestedByAgentId,
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
    };

    const runtime: CliSessionRuntime = {
      snapshot,
      output: [],
      stopRequested: false,
      abortController: null,
      runPromise: null,
      controls: null,
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
    runtime.snapshot.updated_at = nowIso();
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
    runtime.controls.write(text);
    runtime.snapshot.updated_at = nowIso();
    return { ok: true };
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
    } else {
      runtime.snapshot.stderr_excerpt = clipText(`${runtime.snapshot.stderr_excerpt || ""}${normalized}`);
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
