import { describe, expect, it, vi } from "vitest";
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
      participantAgentId: "participant-1",
      participantDisplayName: "Codex Worker",
      cols: 120,
      rows: 30,
    });

    await waitFor(() => manager.getSession(session.id)?.state === "running");
    expect(manager.getSession(session.id)?.participant_agent_id).toBe("participant-1");
    expect(manager.getSession(session.id)?.participant_display_name).toBe("Codex Worker");

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
    expect(finalSession?.reply_capture_state).toBe("completed");
    expect(finalSession?.reply_capture_excerpt).toContain("I am Codex");
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
    expect(finalSession?.reply_capture_state).toBe("completed");
    expect(finalSession?.reply_capture_excerpt).toContain("I am Codex");
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
    expect(manager.getSession(session.id)?.reply_capture_state).toBe("completed");
  });

  it("does not finalize the startup screen as a completed Codex reply before real output arrives", async () => {
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
        hooks.onProcessStart(4690);
        hooks.onControls({
          write: (text: string) => {
            writes.push(text);
            if (text === "who are you") {
              hooks.onOutput(
                "stdout",
                "\u001b[2J\u001b[HOpenAI Codex (v0.116.0)\r\nmodel: gpt-5.4 xhigh   /model to change\r\ndirectory: ~\\Documents\\AgentChatBus\r\n\r\n> who are you\r\n"
              );
              return;
            }
            if (text === "\r" && writes.filter((value) => value === "\r").length === 1) {
              hooks.onOutput(
                "stdout",
                "\u001b[2J\u001b[HOpenAI Codex (v0.116.0)\r\nmodel: gpt-5.4 xhigh   /model to change\r\ndirectory: ~\\Documents\\AgentChatBus\r\n\r\n> who are you\r\n"
              );
              setTimeout(() => {
                hooks.onOutput("stdout", "\u001b[2J\u001b[HWorking (3s • esc to interrupt)\r\n");
              }, 40);
              setTimeout(() => {
                hooks.onOutput(
                  "stdout",
                  "\u001b[2J\u001b[HCodex says hello.\r\nI am the actual reply.\r\n\r\n> Summarize recent commits\r\n"
                );
                resolveRun?.({
                  exitCode: 0,
                  stdout:
                    "OpenAI Codex (v0.116.0)\r\n> who are you\r\nWorking (3s • esc to interrupt)\r\nCodex says hello.\r\nI am the actual reply.\r\n",
                  stderr: "",
                  resultText: "OpenAI Codex (v0.116.0)\n> who are you\nCodex says hello.\nI am the actual reply.",
                });
              }, 90);
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
      threadId: "thread-5a",
      adapter: "codex",
      mode: "interactive",
      prompt: "who are you",
      requestedByAgentId: "agent-5a",
      cols: 120,
      rows: 30,
    });

    await waitFor(() => manager.getSession(session.id)?.automation_state === "resent_initial_prompt_enter");
    const preReplySession = manager.getSession(session.id);
    expect(preReplySession?.reply_capture_state).not.toBe("completed");
    expect(preReplySession?.reply_capture_excerpt || "").not.toContain("OpenAI Codex");

    await waitFor(() => manager.getSession(session.id)?.reply_capture_state === "completed", 4000);
    const finalSession = manager.getSession(session.id);
    expect(finalSession?.reply_capture_excerpt).toContain("Codex says hello.");
    expect(finalSession?.reply_capture_excerpt).toContain("I am the actual reply.");
    expect(finalSession?.reply_capture_excerpt || "").not.toContain("OpenAI Codex");
    expect(finalSession?.reply_capture_excerpt || "").not.toContain("model: gpt-5.4");
  });

  it("waits through a short idle gap so late Codex lines are included before completion", async () => {
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
        hooks.onProcessStart(4691);
        hooks.onControls({
          write: (text: string) => {
            writes.push(text);
            if (text === "who are you") {
              hooks.onOutput("stdout", "\r> who are you");
              return;
            }
            if (text === "\r" && writes.filter((value) => value === "\r").length === 1) {
              hooks.onOutput("stdout", "\r\nWorking (3s • esc to interrupt)\r\n");
              setTimeout(() => {
                hooks.onOutput(
                  "stdout",
                  "\u001b[2J\u001b[HFirst sentence only.\r\n\r\n> Summarize recent commits\r\n"
                );
              }, 40);
              setTimeout(() => {
                hooks.onOutput(
                  "stdout",
                  "\u001b[2J\u001b[HFirst sentence only.\r\nSecond sentence arrived later.\r\nThird sentence too.\r\n\r\n> Summarize recent commits\r\n"
                );
              }, 260);
              setTimeout(() => {
                resolveRun?.({
                  exitCode: 0,
                  stdout:
                    "Working (3s • esc to interrupt)\r\nFirst sentence only.\r\nSecond sentence arrived later.\r\nThird sentence too.\r\n",
                  stderr: "",
                  resultText: "First sentence only.\nSecond sentence arrived later.\nThird sentence too.",
                });
              }, 1300);
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
      threadId: "thread-5c",
      adapter: "codex",
      mode: "interactive",
      prompt: "who are you",
      requestedByAgentId: "agent-5c",
      cols: 120,
      rows: 30,
    });

    await waitFor(() => manager.getSession(session.id)?.automation_state === "codex_working");
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(manager.getSession(session.id)?.reply_capture_state).not.toBe("completed");

    await waitFor(() => manager.getSession(session.id)?.reply_capture_state === "completed", 4000);
    const finalSession = manager.getSession(session.id);
    expect(finalSession?.reply_capture_excerpt).toContain("First sentence only.");
    expect(finalSession?.reply_capture_excerpt).toContain("Second sentence arrived later.");
    expect(finalSession?.reply_capture_excerpt).toContain("Third sentence too.");
  });

  it("captures the visible Codex reply instead of the bottom placeholder prompt", async () => {
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
        hooks.onProcessStart(4746);
        hooks.onControls({
          write: (text: string) => {
            writes.push(text);
            if (text === "who are you") {
              hooks.onOutput(
                "stdout",
                "\u001b[2J\u001b[HOpenAI Codex (v0.116.0)\r\nmodel: gpt-5.4 xhigh   /model to change\r\n\r\n› who are you\r\n100 left  gpt-5.4 xhigh\r\n"
              );
              return;
            }
            if (text === "\r" && writes.includes("who are you")) {
              hooks.onOutput("stdout", "\u001b[2J\u001b[HWorking (3s • esc to interrupt)\r\n");
              setTimeout(() => {
                hooks.onOutput(
                  "stdout",
                  "\u001b[2J\u001b[H• I'm Codex.\r\n• I help with code and the terminal.\r\n\r\n› Summarize recent commits\r\n100 left  gpt-5.4 xhigh\r\n"
                );
              }, 20);
            }
          },
          resize: () => {},
          kill: () => {},
        });
        hooks.onOutput(
          "stdout",
          "OpenAI Codex (v0.116.0)\r\nmodel: gpt-5.4 xhigh   /model to change\r\ndirectory: ~\\Documents\\AgentChatBus\r\n\r\n› \r\n100 left  gpt-5.4 xhigh\r\n"
        );
        return new Promise((resolve) => {
          resolveRun = resolve;
        });
      },
    } as any;

    const manager = new CliSessionManager([interactiveAdapter]);
    const session = manager.createSession({
      threadId: "thread-5b",
      adapter: "codex",
      mode: "interactive",
      prompt: "who are you",
      requestedByAgentId: "agent-5b",
      cols: 120,
      rows: 30,
    });

    await waitFor(() => manager.getSession(session.id)?.reply_capture_state === "completed", 4000);

    const liveSession = manager.getSession(session.id);
    expect(liveSession?.state).toBe("running");
    expect(liveSession?.reply_capture_excerpt).toContain("I'm Codex");
    expect(liveSession?.reply_capture_excerpt).toContain("I help with code");
    expect(liveSession?.reply_capture_excerpt).not.toContain("•");
    expect(liveSession?.reply_capture_excerpt).not.toContain("Summarize recent commits");

    resolveRun?.({
      exitCode: 0,
      stdout: "Working (3s • esc to interrupt)\r\n• I'm Codex.\r\n• I help with code and the terminal.\r\n",
      stderr: "",
      resultText: "I'm Codex.",
    });

    await waitFor(() => manager.getSession(session.id)?.state === "completed");
    expect(manager.getSession(session.id)?.reply_capture_excerpt).not.toContain("•");
    expect(manager.getSession(session.id)?.reply_capture_excerpt).not.toContain("Summarize recent commits");
  });

  it("allows longer reply capture windows for delivered meeting prompts", async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      let deliveryPrompt = "";
      let resolveRun:
        | ((value: { exitCode: number; stdout: string; stderr: string; resultText: string }) => void)
        | null = null;

      const interactiveAdapter = {
        adapterId: "codex",
        mode: "interactive",
        supportsInput: true,
        supportsRestart: true,
        supportsResize: true,
        requiresPrompt: false,
        shell: "powershell",
        run: (_input: unknown, hooks: any) => {
          hooks.onProcessStart(47465);
          hooks.onControls({
            write: (text: string) => {
              writes.push(text);
              if (text === deliveryPrompt) {
                hooks.onOutput(
                  "stdout",
                  `\u001b[2J\u001b[HOpenAI Codex (v0.116.0)\r\nmodel: gpt-5.4 medium   /model to change\r\n\r\n› ${deliveryPrompt}\r\n100 left  gpt-5.4 medium\r\n`,
                );
                return;
              }
              if (text === "\r" && writes.includes(deliveryPrompt)) {
                hooks.onOutput("stdout", "\u001b[2J\u001b[HWorking (28s • esc to interrupt)\r\n");
                setTimeout(() => {
                  hooks.onOutput(
                    "stdout",
                    "\u001b[2J\u001b[H你好，我是 Codex Interactive。\r\n我正在继续参与这个线程，并会根据你刚发的新消息继续回复。\r\n\r\n› Use /skills to list available skills\r\n100 left  gpt-5.4 medium\r\n",
                  );
                }, 3000);
              }
            },
            resize: () => {},
            kill: () => {},
          });
          hooks.onOutput(
            "stdout",
            "OpenAI Codex (v0.116.0)\r\nmodel: gpt-5.4 medium   /model to change\r\ndirectory: ~\\Documents\\AgentChatBus\r\n\r\n› \r\n100 left  gpt-5.4 medium\r\n",
          );
          return new Promise((resolve) => {
            resolveRun = resolve;
          });
        },
      } as any;

      const manager = new CliSessionManager([interactiveAdapter]);
      const session = manager.createSession({
        threadId: "thread-meeting-timeout",
        adapter: "codex",
        mode: "interactive",
        prompt: "",
        requestedByAgentId: "agent-meeting-timeout",
        participantAgentId: "participant-meeting-timeout",
        participantDisplayName: "Codex Interactive",
        participantRole: "administrator",
        cols: 120,
        rows: 30,
      });

      deliveryPrompt = [
        'You are continuing participation in the AgentChatBus thread "333".',
        "Current instruction:",
        "Codex Interactive, you have 1 new message.",
      ].join("\n\n");

      const deliveryResult = await manager.deliverPrompt(session.id, deliveryPrompt, {
        deliveryMode: "incremental",
        deliveredSeq: 505,
      });
      expect(deliveryResult?.ok).toBe(true);

      await vi.advanceTimersByTimeAsync(21000);
      expect(manager.getSession(session.id)?.reply_capture_state).not.toBe("timeout");
      expect(manager.getSession(session.id)?.reply_capture_error).toBeUndefined();

      await vi.advanceTimersByTimeAsync(4000);
      expect(manager.getSession(session.id)?.reply_capture_state).toBe("completed");
      expect(manager.getSession(session.id)?.reply_capture_excerpt).toContain("你好，我是 Codex Interactive");

      resolveRun?.({
        exitCode: 0,
        stdout: "ok\r\n",
        stderr: "",
        resultText: "ok",
      });
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a reply capture error when the session ends before any reply is captured", async () => {
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
        hooks.onProcessStart(4747);
        hooks.onControls({
          write: (text: string) => {
            writes.push(text);
            if (text === "who are you") {
              hooks.onOutput("stdout", "\r> who are you");
              return;
            }
            if (text === "\r") {
              resolveRun?.({
                exitCode: 1,
                stdout: "no reply captured\r\n",
                stderr: "session failed",
                resultText: "session failed",
              });
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
      threadId: "thread-6",
      adapter: "codex",
      mode: "interactive",
      prompt: "who are you",
      requestedByAgentId: "agent-6",
      cols: 120,
      rows: 30,
    });

    await waitFor(() => manager.getSession(session.id)?.state === "failed");
    expect(manager.getSession(session.id)?.reply_capture_state).toBe("error");
    expect(manager.getSession(session.id)?.reply_capture_error).toContain("ended before a Codex reply was captured");
    expect(writes).toContain("who are you");
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
