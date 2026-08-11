import { describe, it, expect } from "vitest";
import {
  ACP_AGENTS,
  getAcpAgent,
  listAcpAgents,
  isAcpAgent,
  resolveAcpSpawnCommand,
  getPlatformKey,
} from "../../src/core/services/acpRegistry.js";

describe("ACP Registry", () => {
  it("includes Devin CLI agent", () => {
    const devin = getAcpAgent("devin");
    expect(devin).toBeDefined();
    expect(devin!.name).toBe("Devin CLI");
    expect(devin!.distribution).toBe("binary");
    expect(devin!.useSystemPath).toBe(true);
  });

  it("includes OpenCode agent", () => {
    const opencode = getAcpAgent("opencode");
    expect(opencode).toBeDefined();
    expect(opencode!.name).toBe("OpenCode");
    expect(opencode!.distribution).toBe("binary");
  });

  it("includes Claude agent via npx", () => {
    const claude = getAcpAgent("claude");
    expect(claude).toBeDefined();
    expect(claude!.distribution).toBe("npx");
    expect(claude!.npx!.package).toContain("@agentclientprotocol/claude-agent-acp");
  });

  it("includes Codex agent via npx", () => {
    const codex = getAcpAgent("codex");
    expect(codex).toBeDefined();
    expect(codex!.distribution).toBe("npx");
    expect(codex!.npx!.package).toContain("@agentclientprotocol/codex-acp");
  });

  it("includes all expected agents", () => {
    const ids = listAcpAgents().map((a) => a.id);
    expect(ids).toContain("devin");
    expect(ids).toContain("opencode");
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("cursor");
    expect(ids).toContain("copilot");
    expect(ids).toContain("gemini");
    expect(ids).toContain("glm");
    expect(ids).toContain("qwen");
    expect(ids).toContain("grok");
    expect(ids).toContain("cline");
    expect(ids).toContain("auggie");
    expect(ids).toContain("goose");
    expect(ids).toContain("kimi");
    expect(ids).toContain("amp");
    expect(ids).toContain("factory-droid");
    expect(ids).toContain("mistral-vibe");
    expect(ids).toContain("poolside");
  });

  it("isAcpAgent returns true for known agents", () => {
    expect(isAcpAgent("devin")).toBe(true);
    expect(isAcpAgent("opencode")).toBe(true);
    expect(isAcpAgent("claude")).toBe(true);
  });

  it("isAcpAgent returns false for unknown agents", () => {
    expect(isAcpAgent("unknown-agent")).toBe(false);
    expect(isAcpAgent("")).toBe(false);
  });

  it("resolveAcpSpawnCommand returns npx command for npx agents", () => {
    const cmd = resolveAcpSpawnCommand("claude");
    expect(cmd).not.toBeNull();
    expect(cmd!.command).toMatch(/^npx(\.cmd)?$/);
    expect(cmd!.args).toContain("@agentclientprotocol/claude-agent-acp@0.66.0");
  });

  it("resolveAcpSpawnCommand returns binary command for binary agents", () => {
    const cmd = resolveAcpSpawnCommand("devin");
    expect(cmd).not.toBeNull();
    expect(cmd!.args).toContain("acp");
  });

  it("resolveAcpSpawnCommand returns null for unknown agent", () => {
    expect(resolveAcpSpawnCommand("nonexistent")).toBeNull();
  });

  it("getPlatformKey returns current platform key", () => {
    const key = getPlatformKey();
    expect(key).toMatch(/^(darwin|linux|windows)-(aarch64|x86_64)$/);
  });
});

describe("AcpAdapter", () => {
  it("can be instantiated for a known agent", async () => {
    const { AcpAdapter } = await import("../../src/core/services/acpAdapter.js");
    const adapter = new AcpAdapter("devin");
    expect(adapter.adapterId).toBe("devin");
    expect(adapter.mode).toBe("acp");
    expect(adapter.supportsInput).toBe(false);
    expect(adapter.supportsRestart).toBe(true);
    expect(adapter.supportsResize).toBe(false);
  });

  it("throws for unknown agent", async () => {
    const { AcpAdapter } = await import("../../src/core/services/acpAdapter.js");
    expect(() => new AcpAdapter("nonexistent-agent")).toThrow();
  });
});
