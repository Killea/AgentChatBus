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
