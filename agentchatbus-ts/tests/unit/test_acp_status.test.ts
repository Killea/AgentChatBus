import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  detectAllAgentStatuses,
  updateEnabledState,
} from "../../src/core/services/acpStatus.js";

// Mock execFileSync to simulate binary detection
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((cmd: string, args: string[]) => {
    // Simulate "devin" and "opencode" being on PATH, others not
    if (cmd === "which" || cmd === "where") {
      const target = args[0];
      if (target === "devin" || target === "devin.exe" || target === "npx" || target === "npx.cmd") {
        return "/usr/local/bin/" + target;
      }
      if (target === "opencode" || target === "opencode.exe") {
        return "/usr/local/bin/" + target;
      }
      throw new Error("not found");
    }
    throw new Error("unexpected command: " + cmd);
  }),
}));

// Mock fs with an in-memory store to simulate enabled-state persistence
const _mockStore = new Map<string, string>();
vi.mock("node:fs", () => ({
  existsSync: vi.fn((path: string) => _mockStore.has(path)),
  readFileSync: vi.fn((path: string) => _mockStore.get(path) || "{}"),
  writeFileSync: vi.fn((path: string, data: string) => { _mockStore.set(path, data); }),
  mkdirSync: vi.fn(),
}));

describe("ACP Status Detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mockStore.clear();
  });

  it("detects available binary agents", () => {
    const result = detectAllAgentStatuses(true);
    const devin = result.agents.find((a) => a.id === "devin");
    expect(devin).toBeDefined();
    expect(devin!.status).toBe("available");
    expect(devin!.status_detail).toContain("Found");
  });

  it("detects not-found binary agents", () => {
    const result = detectAllAgentStatuses(true);
    const cursor = result.agents.find((a) => a.id === "cursor");
    expect(cursor).toBeDefined();
    expect(cursor!.status).toBe("not_found");
    expect(cursor!.status_detail).toContain("not found");
  });

  it("marks npx agents as available when npx is on PATH", () => {
    const result = detectAllAgentStatuses(true);
    const claude = result.agents.find((a) => a.id === "claude");
    expect(claude).toBeDefined();
    expect(claude!.distribution).toBe("npx");
    expect(claude!.status).toBe("available");
    expect(claude!.status_detail).toContain("npx");
  });

  it("returns all agents with correct structure", () => {
    const result = detectAllAgentStatuses(true);
    expect(result.agents.length).toBeGreaterThanOrEqual(10);
    for (const agent of result.agents) {
      expect(agent.id).toBeDefined();
      expect(agent.name).toBeDefined();
      expect(agent.mode).toBe("acp");
      expect(["available", "not_found", "unknown"]).toContain(agent.status);
      expect(typeof agent.enabled).toBe("boolean");
    }
  });

  it("has a default_agent field", () => {
    const result = detectAllAgentStatuses(true);
    expect(result.default_agent).toBeDefined();
    expect(typeof result.default_agent).toBe("string");
  });

  it("has refreshed_at timestamp", () => {
    const result = detectAllAgentStatuses(true);
    expect(result.refreshed_at).toBeDefined();
    expect(() => new Date(result.refreshed_at)).not.toThrow();
  });

  it("uses cache on subsequent calls without force", () => {
    const first = detectAllAgentStatuses(true);
    const second = detectAllAgentStatuses(false);
    // Should be the same cached object
    expect(second).toBe(first);
  });

  it("updateEnabledState can enable an available agent", () => {
    const result = updateEnabledState({ devin: true });
    const devin = result.agents.find((a) => a.id === "devin");
    expect(devin!.enabled).toBe(true);
  });

  it("updateEnabledState cannot enable a not_found agent", () => {
    const result = updateEnabledState({ "nonexistent-agent": true });
    const agent = result.agents.find((a) => a.id === "nonexistent-agent");
    // Should not exist in the result
    expect(agent).toBeUndefined();
  });

  it("updateEnabledState can disable an enabled agent", () => {
    // First enable
    updateEnabledState({ devin: true });
    // Then disable
    const result = updateEnabledState({ devin: false });
    const devin = result.agents.find((a) => a.id === "devin");
    expect(devin!.enabled).toBe(false);
  });
});
