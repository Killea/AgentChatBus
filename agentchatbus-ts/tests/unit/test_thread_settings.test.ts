import { beforeEach, describe, expect, it } from "vitest";
import { getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";

/**
 * Unit tests for thread settings admin behavior, mirroring Python test_thread_settings_v2.py.
 */

describe("thread settings admin parity", () => {
  beforeEach(() => {
    process.env.AGENTCHATBUS_DB = ":memory:";
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("creates default settings for a thread", () => {
    const store = getMemoryStore();
    const { thread } = store.createThread("settings-thread");
    const settings = store.getThreadSettings(thread.id);

    expect(settings).toBeDefined();
    expect(settings!.auto_administrator_enabled).toBe(true);
    expect(settings!.timeout_seconds).toBe(60); // Match Python default
  });

  it("allows updating thread settings", () => {
    const store = getMemoryStore();
    const { thread } = store.createThread("update-settings");
    
    const updated = store.updateThreadSettings(thread.id, {
      timeout_seconds: 120,
      auto_administrator_enabled: false
    });

    expect(updated).toBeDefined();
    expect(updated!.timeout_seconds).toBe(120);
    expect(updated!.auto_administrator_enabled).toBe(false);

    // Verify persistence
    const fetched = store.getThreadSettings(thread.id);
    expect(fetched!.timeout_seconds).toBe(120);
  });

  it("validates minimum timeout_seconds", () => {
    const store = getMemoryStore();
    const { thread } = store.createThread("timeout-validation");
    
    // Below minimum (30 in Python) should throw or be rejected
    expect(() => {
      store.updateThreadSettings(thread.id, { timeout_seconds: 10 });
    }).toThrow();
  });

  it("allows large timeout_seconds values", () => {
    const store = getMemoryStore();
    const { thread } = store.createThread("large-timeout");
    
    const updated = store.updateThreadSettings(thread.id, {
      timeout_seconds: 3600
    });

    expect(updated!.timeout_seconds).toBe(3600);
  });

  it("returns undefined for non-existent thread settings", () => {
    const store = getMemoryStore();
    const settings = store.getThreadSettings("non-existent-thread-id");
    expect(settings).toBeUndefined();
  });
});
