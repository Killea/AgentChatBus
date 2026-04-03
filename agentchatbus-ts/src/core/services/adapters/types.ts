export type CliSessionAdapterId = "cursor" | "codex" | "claude" | "gemini" | "copilot";
export type CliSessionMode = "headless" | "interactive" | "direct";
export type CliSessionStream = "stdout" | "stderr";
export type CliMeetingTransport = "pty_relay" | "agent_mcp";
export type CliSessionActivityStatus = "in_progress" | "completed" | "failed" | "declined";
export type CliNativeThreadStatusType = "notLoaded" | "idle" | "systemError" | "active";
export type CliNativeThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";
export type CliNativeTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type CliNativeTurnPhase =
  | "idle"
  | "starting"
  | "running"
  | "interrupting"
  | "completed"
  | "interrupted"
  | "failed";
export type CliSessionActivityKind =
  | "task"
  | "agent_message"
  | "thinking"
  | "plan"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "command_execution"
  | "file_change";

export type CliSessionActivityFile = {
  path: string;
  change_type?: "add" | "delete" | "update";
  move_path?: string | null;
};

export type CliSessionActivityPlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

export type CliAdapterActivityEvent = {
  at: string;
  turn_id?: string;
  item_id: string;
  kind: CliSessionActivityKind;
  status: CliSessionActivityStatus;
  label: string;
  summary?: string;
  content?: string;
  server?: string;
  tool?: string;
  command?: string;
  cwd?: string;
  files?: CliSessionActivityFile[];
  diff?: string;
  plan_steps?: CliSessionActivityPlanStep[];
  started_at?: string;
  completed_at?: string;
};

export type CliAdapterNativeRuntimeEvent = {
  at?: string;
  thread_id?: string | null;
  thread_status_type?: CliNativeThreadStatusType | null;
  thread_active_flags?: CliNativeThreadActiveFlag[] | null;
  active_turn_id?: string | null;
  last_turn_id?: string | null;
  turn_status?: CliNativeTurnStatus | null;
  phase?: CliNativeTurnPhase | null;
  last_error?: string | null;
};

export type CliAdapterRunInput = {
  prompt: string;
  workspace: string;
  cols: number;
  rows: number;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
  env?: Record<string, string>;
};

export type CliSessionControls = {
  kill?: () => void;
  write?: (text: string) => void;
  resize?: (cols: number, rows: number) => void;
};

export type CliAdapterRunHooks = {
  signal: AbortSignal;
  onOutput: (stream: CliSessionStream, text: string) => void;
  onActivity?: (activity: CliAdapterActivityEvent) => void;
  onNativeRuntime?: (event: CliAdapterNativeRuntimeEvent) => void;
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
