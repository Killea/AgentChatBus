import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/core/services/memoryStore.js";

describe("msg_wait lifecycle tracking", () => {
  let store: MemoryStore;

  beforeEach(() => {
    process.env.AGENTCHATBUS_DB = ":memory:";
    store = new MemoryStore();
    store.reset();
  });

  it("records a completed wait lifecycle after timeout", async () => {
    const { thread } = store.createThread("wait-timeout-lifecycle");
    const agent = store.registerAgent({ ide: "VS Code", model: "Codex" });

    const waitPromise = store.waitForMessages({
      threadId: thread.id,
      afterSeq: 0,
      timeoutMs: 25,
      agentId: agent.id,
      agentToken: agent.token,
    });

    // Wait for waitForMessages to enter waiting state
    await new Promise((resolve) => setTimeout(resolve, 10));

    const active = store.getAgentWaitStatus(thread.id, agent.id);
    expect(active.is_waiting).toBe(true);
    expect(active.status).toBe("waiting");
    expect(active.wait_call_id).toBeTruthy();

    const result = await waitPromise;
    expect(result.messages).toEqual([]);

    const completed = store.getAgentWaitStatus(thread.id, agent.id);
    expect(completed.is_waiting).toBe(false);
    expect(completed.status).toBe("completed");
    expect(completed.last_exit_reason).toBe("timeout");
    expect(completed.last_exited_at).toBeTruthy();
    expect(completed.wait_call_id).toBe(active.wait_call_id);
  });

  it("records a canceled wait lifecycle when the caller aborts msg_wait", async () => {
    const { thread } = store.createThread("wait-client-abort-lifecycle");
    const agent = store.registerAgent({ ide: "VS Code", model: "Claude" });
    const controller = new AbortController();

    const waitPromise = store.waitForMessages({
      threadId: thread.id,
      afterSeq: 0,
      timeoutMs: 5_000,
      agentId: agent.id,
      agentToken: agent.token,
      abortSignal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getAgentWaitStatus(thread.id, agent.id).is_waiting).toBe(true);

    controller.abort();
    const result = await waitPromise;
    expect(result.messages).toEqual([]);

    const canceled = store.getAgentWaitStatus(thread.id, agent.id);
    expect(canceled.is_waiting).toBe(false);
    expect(canceled.status).toBe("canceled");
    expect(canceled.last_exit_reason).toBe("client_abort");
    expect(canceled.last_exited_at).toBeTruthy();
  });
});
