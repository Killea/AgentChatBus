import { getConfig } from "../../config/registry.js";
import { logInfo } from "../../../shared/logger.js";
import type { CliSessionAdapter, CliAdapterRunInput, CliAdapterRunHooks, CliAdapterRunResult } from "./types.js";
import { WINDOWS_POWERSHELL } from "./constants.js";
import {
  normalizeTerminalCols,
  normalizeTerminalRows,
  toPowerShellSingleQuoted,
  isConptyOrWinptyStartupError
} from "./utils.js";
import { runInteractivePtyInChild } from "./interactivePtyChildBridge.js";

function resolveCodexCommand(): string {
  const configured = String(getConfig().codexCommand || "").trim();
  return configured || "codex";
}

function shouldUseConpty(): boolean {
  return getConfig().ptyUseConpty;
}

function buildChildEnv(extraEnv?: Record<string, string>): Record<string, string> {
  const merged = { ...process.env, ...(extraEnv || {}) };
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === "string") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export class CodexInteractiveAdapter implements CliSessionAdapter {
  readonly adapterId = "codex" as const;
  readonly mode = "interactive" as const;
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
    const commandParts = [
      `& ${toPowerShellSingleQuoted(this.codexCommand)}`,
      "--no-alt-screen",
      "-C",
      toPowerShellSingleQuoted(input.workspace),
    ];

    return await runInteractivePtyInChild({
      workerName: "interactivePtyWorker",
      request: {
        shellCommand: this.shellCommand,
        shellArgs: [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          commandParts.join(" "),
        ],
        cwd: input.workspace,
        env: buildChildEnv(input.env),
        cols: normalizeTerminalCols(input.cols),
        rows: normalizeTerminalRows(input.rows),
        useConpty,
      },
      hooks,
    });
  }
}
