// Unified timeout for all CLI adapters (30 minutes)
export const CLI_REPLY_TIMEOUT_MS = 1800000; // 30 minutes
export const CLI_REPLY_FINALIZE_DEBOUNCE_MS = 900;
export const DEFAULT_TERMINAL_COLS = 160;
export const DEFAULT_TERMINAL_ROWS = 48;

export const WINDOWS_POWERSHELL =
  `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
