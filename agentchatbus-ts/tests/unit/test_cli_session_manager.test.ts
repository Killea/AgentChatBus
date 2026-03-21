import { describe, expect, it } from "vitest";
import { CliSessionManager } from "../../src/core/services/cliSessionManager.js";

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition."));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("CliSessionManager interactive sessions", () => {
  it("supports raw input and resize for interactive adapters", async () => {
    const writes: string[] = [];
    const resizes: Array<{ cols: number; rows: number }> = [];
    let resolveRun: ((value: { exitCode: number; stdout: string; stderr: string; resultText: string }) => void) | null = null;

    const interactiveAdapter = {
      adapterId: "codex",
      mode: "interactive",
      supportsInput: true,
      supportsRestart: true,
      supportsResize: true,
      requiresPrompt: false,
      shell: "powershell",
      run: (_input: unknown, hooks: any) => {
        hooks.onProcessStart(4242);
        hooks.onControls({
          write: (text: string) => {
            writes.push(text);
          },
          resize: (cols: number, rows: number) => {
            resizes.push({ cols, rows });
          },
          kill: () => {
            writes.push("__killed__");
          },
        });
        hooks.onOutput("stdout", "booted\r\n");
        return new Promise((resolve) => {
          resolveRun = resolve;
        });
      },
    } as any;

    const manager = new CliSessionManager([interactiveAdapter]);
    const session = manager.createSession({
      threadId: "thread-1",
      adapter: "codex",
      mode: "interactive",
      prompt: "",
      requestedByAgentId: "agent-1",
      cols: 120,
      rows: 30,
    });

    await waitFor(() => manager.getSession(session.id)?.state === "running");

    const sendResult = await manager.sendInput(session.id, "hello\r");
    expect(sendResult).toEqual({ ok: true });
    expect(writes).toContain("hello\r");

    const resizeResult = await manager.resizeSession(session.id, 98, 28);
    expect(resizeResult?.ok).toBe(true);
    expect(resizes).toContainEqual({ cols: 98, rows: 28 });

    const output = manager.getSessionOutput(session.id, 0, 20);
    expect(output?.entries.length).toBe(1);
    expect(output?.entries[0].text).toContain("booted");

    resolveRun?.({
      exitCode: 0,
      stdout: "booted\r\nwho are you\r\nI am Codex\r\n",
      stderr: "",
      resultText: "I am Codex",
    });

    await waitFor(() => manager.getSession(session.id)?.state === "completed");
    expect(manager.getSession(session.id)?.last_result).toBe("I am Codex");
  });

  it("auto-presses Enter for Codex startup prompts and then sends the initial prompt", async () => {
    const writes: string[] = [];
    let resolveRun: ((value: { exitCode: number; stdout: string; stderr: string; resultText: string }) => void) | null =
      null;

    const interactiveAdapter = {
      adapterId: "codex",
      mode: "interactive",
      supportsInput: true,
      supportsRestart: true,
      supportsResize: true,
      requiresPrompt: false,
      shell: "powershell",
      run: (_input: unknown, hooks: any) => {
        hooks.onProcessStart(4343);
        hooks.onControls({
          write: (text: string) => {
            writes.push(text);
            if (text === "\r") {
              if (writes.includes("who are you")) {
                hooks.onOutput("stdout", "\r\nwho are you\r\nI am Codex\r\n");
                resolveRun?.({
                  exitCode: 0,
                  stdout: "startup\r\nPlan, search, build anything\r\nwho are you\r\nI am Codex\r\n",
                  stderr: "",
                  resultText: "I am Codex",
                });
                return;
              }
              hooks.onOutput(
                "stdout",
                "\u001b[2J\u001b[HPlan, search, build anything\r\nUse arrows to navigate.\r\n> \r\n"
              );
              return;
            }
            if (text === "who are you") {
              hooks.onOutput("stdout", "\r> who are you");
            }
          },
          resize: () => {},
          kill: () => {},
        });
        hooks.onOutput("stdout", "Press Enter to continue\r\n");
        return new Promise((resolve) => {
          resolveRun = resolve;
        });
      },
    } as any;

    const manager = new CliSessionManager([interactiveAdapter]);
    const session = manager.createSession({
      threadId: "thread-2",
      adapter: "codex",
      mode: "interactive",
      prompt: "who are you",
      requestedByAgentId: "agent-2",
      cols: 120,
      rows: 30,
    });

    await waitFor(() => writes.includes("\r"));
    await waitFor(() => writes.includes("who are you"));
    await waitFor(() => manager.getSession(session.id)?.state === "completed");

    const finalSession = manager.getSession(session.id);
    expect(finalSession?.automation_state).toBe("sent_initial_prompt_enter");
    expect(finalSession?.last_result).toBe("I am Codex");
    expect(finalSession?.screen_excerpt).toContain("I am Codex");
  });

  it("sends the initial prompt when Codex opens directly into its main CLI screen", async () => {
    const writes: string[] = [];
    let resolveRun: ((value: { exitCode: number; stdout: string; stderr: string; resultText: string }) => void) | null =
      null;

    const interactiveAdapter = {
      adapterId: "codex",
      mode: "interactive",
      supportsInput: true,
      supportsRestart: true,
      supportsResize: true,
      requiresPrompt: false,
      shell: "powershell",
      run: (_input: unknown, hooks: any) => {
        hooks.onProcessStart(4444);
        hooks.onControls({
          write: (text: string) => {
            writes.push(text);
            if (text === "who are you") {
              hooks.onOutput("stdout", "\r> who are you");
              return;
            }
            if (text === "\r" && writes.includes("who are you")) {
              hooks.onOutput("stdout", "\r\nwho are you\r\nI am Codex\r\n");
              resolveRun?.({
                exitCode: 0,
                stdout: "OpenAI Codex\r\n> Use /skills to list available skills\r\nwho are you\r\nI am Codex\r\n",
                stderr: "",
                resultText: "I am Codex",
              });
            }
          },
          resize: () => {},
          kill: () => {},
        });
        hooks.onOutput(
          "stdout",
          "OpenAI Codex (v0.116.0)\r\nmodel: gpt-5.4 xhigh   /model to change\r\ndirectory: ~\\Documents\\AgentChatBus\r\n\r\n> Use /skills to list available skills\r\n"
        );
        return new Promise((resolve) => {
          resolveRun = resolve;
        });
      },
    } as any;

    const manager = new CliSessionManager([interactiveAdapter]);
    const session = manager.createSession({
      threadId: "thread-3",
      adapter: "codex",
      mode: "interactive",
      prompt: "who are you",
      requestedByAgentId: "agent-3",
      cols: 120,
      rows: 30,
    });

    await waitFor(() => writes.includes("who are you"));
    await waitFor(() => manager.getSession(session.id)?.state === "completed");

    const finalSession = manager.getSession(session.id);
    expect(finalSession?.automation_state).toBe("sent_initial_prompt_enter");
    expect(finalSession?.last_result).toBe("I am Codex");
    expect(finalSession?.screen_excerpt).toContain("Use /skills");
  });

  it("does not mark control-sequence input as a manual override", async () => {
    const writes: string[] = [];
    let resolveRun: ((value: { exitCode: number; stdout: string; stderr: string; resultText: string }) => void) | null =
      null;

    const interactiveAdapter = {
      adapterId: "codex",
      mode: "interactive",
      supportsInput: true,
      supportsRestart: true,
      supportsResize: true,
      requiresPrompt: false,
      shell: "powershell",
      run: (_input: unknown, hooks: any) => {
        hooks.onProcessStart(4545);
        hooks.onControls({
          write: (text: string) => {
            writes.push(text);
          },
          resize: () => {},
          kill: () => {},
        });
        hooks.onOutput("stdout", "booted\r\n");
        return new Promise((resolve) => {
          resolveRun = resolve;
        });
      },
    } as any;

    const manager = new CliSessionManager([interactiveAdapter]);
    const session = manager.createSession({
      threadId: "thread-4",
      adapter: "codex",
      mode: "interactive",
      prompt: "who are you",
      requestedByAgentId: "agent-4",
      cols: 120,
      rows: 30,
    });

    await waitFor(() => manager.getSession(session.id)?.state === "running");
    await manager.sendInput(session.id, "\u001b[<0;60;12M");
    expect(manager.getSession(session.id)?.automation_state).toBe("waiting_for_codex_prompt");

    resolveRun?.({
      exitCode: 0,
      stdout: "booted\r\n",
      stderr: "",
      resultText: "done",
    });
    await waitFor(() => manager.getSession(session.id)?.state === "completed");
    expect(writes).toContain("\u001b[<0;60;12M");
  });

  it("treats Codex Working status as active work and cancels further auto-submit retries", async () => {
    const writes: string[] = [];
    let resolveRun: ((value: { exitCode: number; stdout: string; stderr: string; resultText: string }) => void) | null =
      null;

    const interactiveAdapter = {
      adapterId: "codex",
      mode: "interactive",
      supportsInput: true,
      supportsRestart: true,
      supportsResize: true,
      requiresPrompt: false,
      shell: "powershell",
      run: (_input: unknown, hooks: any) => {
        hooks.onProcessStart(4646);
        hooks.onControls({
          write: (text: string) => {
            writes.push(text);
            if (text === "who are you") {
              hooks.onOutput("stdout", "\r> who are you");
              return;
            }
            if (text === "\r") {
              hooks.onOutput("stdout", "\r\nWorking (3s • esc to interrupt)\r\n");
              setTimeout(() => {
                hooks.onOutput("stdout", "\r\nI am Codex\r\n");
                resolveRun?.({
                  exitCode: 0,
                  stdout: "Working (3s • esc to interrupt)\r\nI am Codex\r\n",
                  stderr: "",
                  resultText: "I am Codex",
                });
              }, 40);
            }
          },
          resize: () => {},
          kill: () => {},
        });
        hooks.onOutput(
          "stdout",
          "OpenAI Codex (v0.116.0)\r\nmodel: gpt-5.4 xhigh   /model to change\r\ndirectory: ~\\Documents\\AgentChatBus\r\n\r\n> \r\n"
        );
        return new Promise((resolve) => {
          resolveRun = resolve;
        });
      },
    } as any;

    const manager = new CliSessionManager([interactiveAdapter]);
    const session = manager.createSession({
      threadId: "thread-5",
      adapter: "codex",
      mode: "interactive",
      prompt: "who are you",
      requestedByAgentId: "agent-5",
      cols: 120,
      rows: 30,
    });

    await waitFor(() => manager.getSession(session.id)?.automation_state === "codex_working");
    await waitFor(() => manager.getSession(session.id)?.state === "completed");

    expect(writes.filter((value) => value === "\r")).toHaveLength(1);
    expect(manager.getSession(session.id)?.last_result).toBe("I am Codex");
  });

  it("keeps prompt validation for adapters that require it", () => {
    const headlessAdapter = {
      adapterId: "cursor",
      mode: "headless",
      supportsInput: false,
      supportsRestart: true,
      supportsResize: false,
      requiresPrompt: true,
      run: async () => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        resultText: "ok",
      }),
    } as any;

    const manager = new CliSessionManager([headlessAdapter]);
    expect(() => {
      manager.createSession({
        threadId: "thread-2",
        adapter: "cursor",
        mode: "headless",
        prompt: "",
        requestedByAgentId: "agent-2",
      });
    }).toThrow("prompt is required");
  });
});
