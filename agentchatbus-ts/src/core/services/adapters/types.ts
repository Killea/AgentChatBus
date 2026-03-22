export type CliSessionAdapterId = "cursor" | "codex" | "claude";
export type CliSessionMode = "headless" | "interactive";
export type CliSessionStream = "stdout" | "stderr";

export type CliAdapterRunInput = {
  prompt: string;
  workspace: string;
  cols: number;
  rows: number;
};

export type CliSessionControls = {
  kill?: () => void;
  write?: (text: string) => void;
  resize?: (cols: number, rows: number) => void;
};

export type CliAdapterRunHooks = {
  signal: AbortSignal;
  onOutput: (stream: CliSessionStream, text: string) => void;
  onProcessStart: (pid: number) => void;
  onControls: (controls: CliSessionControls) => void;
};

export type CliAdapterRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  resultText?: string;
  rawResult?: Record<string, unknown> | null;
  externalSessionId?: string;
  externalRequestId?: string;
};

export interface CliSessionAdapter {
  readonly adapterId: CliSessionAdapterId;
  readonly mode: CliSessionMode;
  readonly supportsInput: boolean;
  readonly supportsRestart: boolean;
  readonly supportsResize: boolean;
  readonly requiresPrompt: boolean;
  readonly shell?: string;
  run(input: CliAdapterRunInput, hooks: CliAdapterRunHooks): Promise<CliAdapterRunResult>;
}
