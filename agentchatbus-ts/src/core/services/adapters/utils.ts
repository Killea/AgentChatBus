import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS } from "./constants.js";

export function normalizeWorkspacePath(explicitPath?: string): string {
  const direct = String(explicitPath || "").trim();
  if (direct) {
    return direct;
  }
  return process.cwd();
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
