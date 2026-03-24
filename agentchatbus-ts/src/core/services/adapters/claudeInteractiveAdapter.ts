import { logInfo } from "../../../shared/logger.js";
import type { CliSessionAdapter, CliAdapterRunInput, CliAdapterRunHooks, CliAdapterRunResult } from "./types.js";
import { WINDOWS_POWERSHELL } from "./constants.js";
import {
  normalizeWorkspacePath,
  normalizeTerminalCols,
  normalizeTerminalRows,
  toPowerShellSingleQuoted,
  summarizeInteractiveTranscript,
  isConptyOrWinptyStartupError,
} from "./utils.js";
import { getConfig } from "../../config/registry.js";

type NodePtyModule = typeof import("node-pty");
type PtyInstance = import("node-pty").IPty;

let nodePtyModulePromise: Promise<NodePtyModule> | null = null;

function shouldUseConpty(): boolean {
  return getConfig().ptyUseConpty;
}

async function loadNodePty(): Promise<NodePtyModule> {
  if (!nodePtyModulePromise) {
    nodePtyModulePromise = import("node-pty").catch((error: unknown) => {
      nodePtyModulePromise = null;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Interactive PTY sessions require the optional 'node-pty' runtime. ` +
        `Rebuild the bundled server resources so 'resources/bundled-server/node_modules' is present. ` +
        `Original error: ${detail}`,
      );
    });
  }
  return await nodePtyModulePromise;
}

export class ClaudeInteractiveAdapter implements CliSessionAdapter {
  readonly adapterId = "claude" as const;
  readonly mode = "interactive" as const;
  readonly supportsInput = true;
  readonly supportsRestart = true;
  readonly supportsResize = true;
  readonly requiresPrompt = false;
  readonly shell = "powershell";

  constructor(
    private readonly shellCommand = WINDOWS_POWERSHELL,
    private readonly claudeCommand = "claude",
  ) {}

  async run(input: CliAdapterRunInput, hooks: CliAdapterRunHooks): Promise<CliAdapterRunResult> {
    if (process.platform !== "win32") {
      throw new Error("Claude interactive PTY mode currently requires Windows PowerShell.");
    }

    const preferConpty = shouldUseConpty();
    try {
      return await this.runWithBackend(input, hooks, preferConpty);
    } catch (error) {
      if (!preferConpty || !isConptyOrWinptyStartupError(error)) {
        throw error;
      }
      logInfo("[cli-session] Claude PTY ConPTY startup failed, retrying with WinPTY fallback.");
      return await this.runWithBackend(input, hooks, false);
    }
  }

  private async runWithBackend(
    input: CliAdapterRunInput,
    hooks: CliAdapterRunHooks,
    useConpty: boolean,
  ): Promise<CliAdapterRunResult> {
    const nodePty = await loadNodePty();
    return await new Promise<CliAdapterRunResult>((resolve, reject) => {
      const workspace = normalizeWorkspacePath(input.workspace);
      const requestedModel = String(input.model || "").trim() || "sonnet";
      const commandLine = `cd ${toPowerShellSingleQuoted(workspace)}; & ${toPowerShellSingleQuoted(this.claudeCommand)} --model ${toPowerShellSingleQuoted(requestedModel)}`;

      let terminal: PtyInstance | null = null;
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
            commandLine,
          ],
          {
            name: "xterm-256color",
            cwd: workspace,
            env: { ...process.env, ...(input.env || {}) },
            cols: normalizeTerminalCols(input.cols),
            rows: normalizeTerminalRows(input.rows),
            useConpty,
          },
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
        { once: true },
      );
    });
  }
}
