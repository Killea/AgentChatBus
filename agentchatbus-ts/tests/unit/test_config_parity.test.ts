import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_PATH = join(process.cwd(), "data", "config.json");

function writeConfig(payload: Record<string, unknown>): void {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2), "utf-8");
}

async function loadEnvModule() {
  vi.resetModules();
  return import("../../src/core/config/env.js");
}

describe("config parity with Python defaults and precedence", () => {
  let originalConfigExists = false;
  let originalConfigContent = "";

  const backupConfig = () => {
    originalConfigExists = existsSync(CONFIG_PATH);
    originalConfigContent = originalConfigExists ? readFileSync(CONFIG_PATH, "utf-8") : "";
  };

  const restoreConfig = () => {
    if (originalConfigExists) {
      writeFileSync(CONFIG_PATH, originalConfigContent, "utf-8");
    } else if (existsSync(CONFIG_PATH)) {
      unlinkSync(CONFIG_PATH);
    }
  };

  afterEach(() => {
    restoreConfig();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults attention flags to false when env/config are absent", async () => {
    backupConfig();
    if (existsSync(CONFIG_PATH)) {
      unlinkSync(CONFIG_PATH);
    }
    vi.unstubAllEnvs();
    const env = await loadEnvModule();
    expect(env.ENABLE_HANDOFF_TARGET).toBe(false);
    expect(env.ENABLE_STOP_REASON).toBe(false);
    expect(env.ENABLE_PRIORITY).toBe(false);
  });

  it("uses persisted config values when env vars are absent", async () => {
    backupConfig();
    writeConfig({
      HOST: "0.0.0.0",
      PORT: 41001,
      ENABLE_HANDOFF_TARGET: true,
      EXPOSE_THREAD_RESOURCES: true,
    });

    vi.unstubAllEnvs();
    const env = await loadEnvModule();
    const cfg = env.getConfig();
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(41001);
    expect(cfg.exposeThreadResources).toBe(true);
    expect(env.ENABLE_HANDOFF_TARGET).toBe(true);
  });

  it("env vars override persisted config values (Python precedence)", async () => {
    backupConfig();
    writeConfig({
      HOST: "0.0.0.0",
      PORT: 41001,
      ENABLE_HANDOFF_TARGET: false,
      EXPOSE_THREAD_RESOURCES: false,
    });

    vi.stubEnv("AGENTCHATBUS_HOST", "127.0.0.9");
    vi.stubEnv("AGENTCHATBUS_PORT", "42002");
    vi.stubEnv("AGENTCHATBUS_ENABLE_HANDOFF_TARGET", "true");
    vi.stubEnv("AGENTCHATBUS_EXPOSE_THREAD_RESOURCES", "true");

    const env = await loadEnvModule();
    const cfg = env.getConfig();
    expect(cfg.host).toBe("127.0.0.9");
    expect(cfg.port).toBe(42002);
    expect(cfg.exposeThreadResources).toBe(true);
    expect(env.ENABLE_HANDOFF_TARGET).toBe(true);
  });

  it("saveConfigDict strips SHOW_AD like Python implementation", async () => {
    backupConfig();
    writeConfig({ HOST: "127.0.0.1" });

    const env = await loadEnvModule();
    env.saveConfigDict({
      SHOW_AD: true,
      PORT: 49765,
    });

    const content = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    expect(content.SHOW_AD).toBeUndefined();
    expect(content.PORT).toBe(49765);
  });
});
