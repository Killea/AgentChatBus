import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CliAdapterRunHooks, CliAdapterRunResult } from "./types.js";
import {
  normalizeTerminalCols,
  normalizeTerminalRows,
  summarizeInteractiveTranscript,
} from "./utils.js";

type InteractivePtyChildRequest = {
  shellCommand: string;
  shellArgs: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  useConpty: boolean;
};

type InteractivePtyWorkerReadyMessage = {
  type: "ready";
};

type InteractivePtyWorkerStartedMessage = {
  type: "process-start";
  pid: number;
};

type InteractivePtyWorkerOutputMessage = {
  type: "output";
  stream: "stdout" | "stderr";
  text: string;
};

type InteractivePtyWorkerExitMessage = {
  type: "exit";
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type InteractivePtyWorkerErrorMessage = {
  type: "error";
  message: string;
};

type InteractivePtyWorkerMessage =
  | InteractivePtyWorkerReadyMessage
  | InteractivePtyWorkerStartedMessage
  | InteractivePtyWorkerOutputMessage
  | InteractivePtyWorkerExitMessage
  | InteractivePtyWorkerErrorMessage;

type InteractivePtyParentStartMessage = {
  type: "start";
  payload: InteractivePtyChildRequest;
};

type InteractivePtyParentWriteMessage = {
  type: "write";
  text: string;
};

type InteractivePtyParentResizeMessage = {
  type: "resize";
  cols: number;
  rows: number;
};

type InteractivePtyParentKillMessage = {
  type: "kill";
};

type InteractivePtyParentMessage =
  | InteractivePtyParentStartMessage
  | InteractivePtyParentWriteMessage
  | InteractivePtyParentResizeMessage
  | InteractivePtyParentKillMessage;

type RunInteractivePtyInChildInput = {
  workerName: string;
  request: InteractivePtyChildRequest;
  hooks: CliAdapterRunHooks;
};

function resolveWorkerPath(workerName: string): string {
  const entryFile = path.resolve(process.argv[1] || process.cwd());
  const entryDir = path.dirname(entryFile);
  const workerFileName = `${workerName}.mjs`;
  const candidates = [
    path.resolve(entryDir, "../workers", workerFileName),
    path.resolve(entryDir, "../core/services/adapters/workers", workerFileName),
    path.resolve(entryDir, "../../src/core/services/adapters/workers", workerFileName),
    path.resolve(process.cwd(), "dist/workers", workerFileName),
    path.resolve(process.cwd(), "src/core/services/adapters/workers", workerFileName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Unable to locate interactive PTY worker '${workerFileName}'. ` +
    `Checked: ${candidates.join(", ")}`,
  );
}

function sendMessage(child: ChildProcess, message: InteractivePtyParentMessage): void {
  if (!child.connected) {
    return;
  }
  child.send(message);
}

export async function runInteractivePtyInChild(
  input: RunInteractivePtyInChildInput,
): Promise<CliAdapterRunResult> {
  const workerPath = resolveWorkerPath(input.workerName);
  const child = spawn(process.execPath, [workerPath], {
    cwd: input.request.cwd,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });

  let settled = false;
  let childExited = false;
  let stdout = "";
  let stderr = "";

  const finalize = (
    resolve: (value: CliAdapterRunResult | PromiseLike<CliAdapterRunResult>) => void,
    result: CliAdapterRunResult,
  ) => {
    if (settled) {
      return;
    }
    settled = true;
    resolve(result);
  };

  const fail = (reject: (reason?: unknown) => void, error: unknown) => {
    if (settled) {
      return;
    }
    settled = true;
    reject(error);
  };

  input.hooks.onControls({
    kill: () => {
      sendMessage(child, { type: "kill" });
      if (!childExited) {
        child.kill();
      }
    },
    write: (text) => {
      sendMessage(child, { type: "write", text });
    },
    resize: (cols, rows) => {
      sendMessage(child, {
        type: "resize",
        cols: normalizeTerminalCols(cols),
        rows: normalizeTerminalRows(rows),
      });
    },
  });

  input.hooks.signal.addEventListener(
    "abort",
    () => {
      sendMessage(child, { type: "kill" });
      if (!childExited) {
        child.kill();
      }
    },
    { once: true },
  );

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    stderr += text;
  });

  return await new Promise<CliAdapterRunResult>((resolve, reject) => {
    child.once("spawn", () => {
      sendMessage(child, {
        type: "start",
        payload: {
          ...input.request,
          cols: normalizeTerminalCols(input.request.cols),
          rows: normalizeTerminalRows(input.request.rows),
        },
      });
    });

    child.on("message", (message: InteractivePtyWorkerMessage) => {
      if (!message || typeof message !== "object" || !("type" in message)) {
        return;
      }
      switch (message.type) {
        case "ready":
          return;
        case "process-start":
          input.hooks.onProcessStart(message.pid);
          return;
        case "output":
          if (message.stream === "stdout") {
            stdout += message.text;
          } else {
            stderr += message.text;
          }
          input.hooks.onOutput(message.stream, message.text);
          return;
        case "exit":
          childExited = true;
          finalize(resolve, {
            exitCode: message.exitCode,
            stdout: message.stdout || stdout,
            stderr: message.stderr || stderr,
            resultText: summarizeInteractiveTranscript(message.stdout || stdout),
            rawResult: null,
          });
          return;
        case "error":
          fail(reject, new Error(message.message));
          return;
      }
    });

    child.once("error", (error) => {
      childExited = true;
      fail(reject, error);
    });

    child.once("exit", (code, signal) => {
      childExited = true;
      if (settled) {
        return;
      }
      if (input.hooks.signal.aborted) {
        finalize(resolve, {
          exitCode: code,
          stdout,
          stderr,
          resultText: summarizeInteractiveTranscript(stdout),
          rawResult: null,
        });
        return;
      }
      fail(
        reject,
        new Error(
          `Interactive PTY worker exited unexpectedly` +
          ` (code=${code === null ? "null" : String(code)}, signal=${signal || "none"}).` +
          `${stderr ? ` ${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}
