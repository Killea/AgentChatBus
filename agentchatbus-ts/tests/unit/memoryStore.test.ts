import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/core/services/memoryStore.js";

describe("MemoryStore", () => {
  it("creates a thread and returns initial sync context", () => {
    const store = new MemoryStore(':memory:');
    const result = store.createThread("demo-thread");

    expect(result.thread.topic).toBe("demo-thread");
    expect(result.sync.current_seq).toBe(0);
    expect(result.sync.reply_token).toBeTruthy();
  });
});