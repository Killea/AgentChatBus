import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/core/services/memoryStore.js";

describe("msg_wait event wake latency", () => {
  let store: MemoryStore;

  beforeEach(() => {
    process.env.AGENTCHATBUS_DB = ":memory:";
    store = new MemoryStore();
    store.reset();
  });

  it("wakes msg_wait when post interleaves between first empty poll and event registration", async () => {
    const { thread, sync } = store.createThread("event-wake-thread");
    const waiter = store.registerAgent({ ide: "bench", model: "waiter" });
    const poster = store.registerAgent({ ide: "bench", model: "poster" });
  const postPayload = {
      threadId: thread.id,
      author: poster.id,
      content: "wake-now",
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
    };

    const originalGetMessages = store.getMessages.bind(store);
    let injected = false;
    vi.spyOn(store, "getMessages").mockImplementation((...args) => {
      const rows = originalGetMessages(...(args as Parameters<typeof store.getMessages>));
      if (!injected && args[0] === thread.id && rows.length === 0) {
        injected = true;
        store.postMessage(postPayload);
      }
      return rows;
    });

    const t0 = Date.now();
    const result = await store.waitForMessages({
      threadId: thread.id,
      afterSeq: sync.current_seq,
      timeoutMs: 5_000,
      agentId: waiter.id,
      agentToken: waiter.token,
    });
    const elapsed = Date.now() - t0;

    expect(result.messages.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  });
});