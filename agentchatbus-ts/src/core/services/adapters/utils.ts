import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getConfig } from "../../config/registry.js";
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS } from "./constants.js";

export type CliWorkspaceResolutionSource = "configured" | "process_cwd" | "user_home";

export type CliWorkspaceResolution = {
  workspace: string;
  source: CliWorkspaceResolutionSource;
  configuredWorkspace: string | null;
  candidates: string[];
};

function normalizePathCandidate(value: string | null | undefined): string | undefined {
  const raw = String(value || "").trim();
  if (!raw) {
    return undefined;
  }
  try {
    return resolve(raw);
  } catch {
    return undefined;
  }
}

function isUsableWorkspacePath(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    return existsSync(value);
  } catch {
    return false;
  }
}

export function getDefaultWorkspacePathCandidates(): string[] {
  const config = getConfig();
  const candidates = [
    normalizePathCandidate(config.cliWorkspace),
    normalizePathCandidate(process.cwd()),
    normalizePathCandidate(homedir()),
  ].filter((value, index, list): value is string => Boolean(value) && list.indexOf(value) === index);
  return candidates;
}

export function resolveDefaultWorkspacePath(): CliWorkspaceResolution {
  const config = getConfig();
  const configuredWorkspace = normalizePathCandidate(config.cliWorkspace) || null;
  const processWorkspace = normalizePathCandidate(process.cwd());
  const userHomeWorkspace = normalizePathCandidate(homedir());
  const candidates = [
    configuredWorkspace,
    processWorkspace,
    userHomeWorkspace,
  ].filter((value, index, list): value is string => Boolean(value) && list.indexOf(value) === index);

  if (configuredWorkspace && isUsableWorkspacePath(configuredWorkspace)) {
    return {
      workspace: configuredWorkspace,
      source: "configured",
      configuredWorkspace,
      candidates,
    };
  }

  if (processWorkspace && isUsableWorkspacePath(processWorkspace)) {
    return {
      workspace: processWorkspace,
      source: "process_cwd",
      configuredWorkspace,
      candidates,
    };
  }

  if (userHomeWorkspace && isUsableWorkspacePath(userHomeWorkspace)) {
    return {
      workspace: userHomeWorkspace,
      source: "user_home",
      configuredWorkspace,
      candidates,
    };
  }

  return {
    workspace: userHomeWorkspace || processWorkspace || process.cwd(),
    source: userHomeWorkspace ? "user_home" : "process_cwd",
    configuredWorkspace,
    candidates,
  };
}

export function getDefaultWorkspacePath(): string {
  return resolveDefaultWorkspacePath().workspace;
}

export function normalizeWorkspacePath(explicitPath?: string): string {
  const direct = normalizePathCandidate(explicitPath);
  if (direct && isUsableWorkspacePath(direct)) {
    return direct;
  }
  return getDefaultWorkspacePath();
}

export function normalizeTerminalCols(value?: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_TERMINAL_COLS;
  }
  return Math.min(Math.max(Math.floor(numeric), 40), 320);
}

export function normalizeTerminalRows(value?: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_TERMINAL_ROWS;
  }
  return Math.min(Math.max(Math.floor(numeric), 10), 120);
}

export function toPowerShellSingleQuoted(value: string): string {
  return `'${String(value || "").replaceAll("'", "''")}'`;
}

export function clipText(input: string, maxChars = 4000): string {
  const value = String(input || "");
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}

export function summarizeInteractiveTranscript(input: string): string | undefined {
  const ANSI_CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
  const ANSI_OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
  const ANSI_SINGLE_CHAR_SEQUENCE = /\u001b[@-_]/g;

  const stripTerminalControlSequences = (text: string): string => {
    return String(text || "")
      .replace(ANSI_OSC_SEQUENCE, "")
      .replace(ANSI_CSI_SEQUENCE, "")
      .replace(ANSI_SINGLE_CHAR_SEQUENCE, "")
      .replace(/\r/g, "");
  };

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

export function isConptyOrWinptyStartupError(error: unknown): boolean {
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

export function terminateChildProcessTree(child: ChildProcess | null | undefined): void {
  if (!child) {
    return;
  }
  const pid = typeof child.pid === "number" ? child.pid : 0;
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    try {
      execFile("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
      }, () => {
        // Best effort shutdown.
      });
      return;
    } catch {
      // Fall back to child.kill below.
    }
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // Best effort shutdown.
  }
}
