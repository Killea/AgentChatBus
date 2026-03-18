import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  adminToken: string | null;
  agentHeartbeatTimeout: number;
  msgWaitTimeout: number;
  // TS-only improvement: minimum wait timeout clamp (ms) for msg_wait blocking path.
  // This intentionally diverges from Python parity to reduce short polling churn.
  msgWaitMinTimeoutMs: number;
  replyTokenLeaseSeconds: number;
  seqTolerance: number;
  seqMismatchMaxMessages: number;
  rateLimitMsgPerMinute: number;
  threadTimeoutMinutes: number;
  threadTimeoutSweepInterval: number;
  reloadEnabled: boolean;
  exposeThreadResources: boolean;
  contentFilterEnabled: boolean;
}

/**
 * Attention mechanism feature flags (UP-17).
 * Ported from Python src/config.py and src/tools/dispatch.py
 * Controls whether handoff_target, stop_reason, and priority fields
 * are returned to agents or stripped from responses.
 */
export const BUS_VERSION = "0.1.98";
const DEFAULT_MSG_WAIT_MIN_TIMEOUT_MS = process.env.NODE_ENV === "test" ? "0" : "60000";

function parseBoolLike(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function pickEnvOrPersisted(
  envValue: string | undefined,
  persistedValue: unknown,
  fallback: string
): string {
  if (envValue !== undefined && envValue !== null && envValue !== "") {
    return envValue;
  }
  if (persistedValue !== undefined && persistedValue !== null && String(persistedValue) !== "") {
    return String(persistedValue);
  }
  return fallback;
}

// Admin token for settings endpoint (optional — if unset, PUT /api/settings is unprotected)
export const ADMIN_TOKEN: string | null = process.env.AGENTCHATBUS_ADMIN_TOKEN || null;

function getAppDir(): string {
  const configured = process.env.AGENTCHATBUS_APP_DIR;
  if (configured && configured.trim().length > 0) {
    return resolve(configured);
  }
  return join(process.cwd(), "data");
}

// Config file path for packaged extension/runtime use.
const CONFIG_FILE = process.env.AGENTCHATBUS_CONFIG_FILE
  ? resolve(process.env.AGENTCHATBUS_CONFIG_FILE)
  : join(getAppDir(), "config.json");

const persistedConfigForFlags = (() => {
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = readFileSync(CONFIG_FILE, "utf-8");
      return JSON.parse(content) as Record<string, unknown>;
    }
  } catch {}
  return {} as Record<string, unknown>;
})();

export const ENABLE_HANDOFF_TARGET = parseBoolLike(
  process.env.AGENTCHATBUS_ENABLE_HANDOFF_TARGET
    ?? persistedConfigForFlags.ENABLE_HANDOFF_TARGET
    ?? "false",
  false
);
export const ENABLE_STOP_REASON = parseBoolLike(
  process.env.AGENTCHATBUS_ENABLE_STOP_REASON
    ?? persistedConfigForFlags.ENABLE_STOP_REASON
    ?? "false",
  false
);
export const ENABLE_PRIORITY = parseBoolLike(
  process.env.AGENTCHATBUS_ENABLE_PRIORITY
    ?? persistedConfigForFlags.ENABLE_PRIORITY
    ?? "false",
  false
);

/**
 * Get persisted config from data/config.json (matches Python get_config_dict)
 */
function getPersistedConfig(): Record<string, unknown> {
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = readFileSync(CONFIG_FILE, "utf-8");
      return JSON.parse(content);
    }
  } catch {
    // Ignore read errors
  }
  return {};
}

/**
 * Save config to data/config.json (matches Python save_config_dict)
 * Only saves non-transient flags (SHOW_AD is intentionally excluded)
 */
export function saveConfigDict(newData: Record<string, unknown>): void {
  const current = getPersistedConfig();
  const merged = { ...current, ...newData };
  
  // Prevent saving transient/show-only flags by default
  if ("SHOW_AD" in merged) {
    delete merged.SHOW_AD;
  }
  
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
  } catch {
    // Ignore write errors
  }
}

/**
 * Get config dict for API response (matches Python get_config_dict)
 */
export function getConfigDict(): Record<string, unknown> {
  const persisted = getPersistedConfig();
  return {
    HOST: pickEnvOrPersisted(process.env.AGENTCHATBUS_HOST, persisted.HOST, "127.0.0.1"),
    PORT: Number(pickEnvOrPersisted(process.env.AGENTCHATBUS_PORT, persisted.PORT, "39765")),
    AGENT_HEARTBEAT_TIMEOUT: Number(
      pickEnvOrPersisted(process.env.AGENTCHATBUS_HEARTBEAT_TIMEOUT, persisted.AGENT_HEARTBEAT_TIMEOUT, "60")
    ),
    MSG_WAIT_TIMEOUT: Number(
      pickEnvOrPersisted(process.env.AGENTCHATBUS_WAIT_TIMEOUT, persisted.MSG_WAIT_TIMEOUT, "300")
    ),
    // TS-only: minimum timeout clamp for msg_wait blocking branch.
    // Not present in Python backend config.
    MSG_WAIT_MIN_TIMEOUT_MS: Number(
      pickEnvOrPersisted(
        process.env.AGENTCHATBUS_WAIT_MIN_TIMEOUT_MS,
        persisted.MSG_WAIT_MIN_TIMEOUT_MS,
        DEFAULT_MSG_WAIT_MIN_TIMEOUT_MS
      )
    ),
    REPLY_TOKEN_LEASE_SECONDS: Number(
      pickEnvOrPersisted(
        process.env.AGENTCHATBUS_REPLY_TOKEN_LEASE_SECONDS,
        persisted.REPLY_TOKEN_LEASE_SECONDS,
        "3600"
      )
    ),
    SEQ_TOLERANCE: Number(
      pickEnvOrPersisted(process.env.AGENTCHATBUS_SEQ_TOLERANCE, persisted.SEQ_TOLERANCE, "0")
    ),
    SEQ_MISMATCH_MAX_MESSAGES: Number(
      pickEnvOrPersisted(
        process.env.AGENTCHATBUS_SEQ_MISMATCH_MAX_MESSAGES,
        persisted.SEQ_MISMATCH_MAX_MESSAGES,
        "100"
      )
    ),
    RATE_LIMIT_MSG_PER_MINUTE: Number(
      pickEnvOrPersisted(process.env.AGENTCHATBUS_RATE_LIMIT, persisted.RATE_LIMIT_MSG_PER_MINUTE, "30")
    ),
    EXPOSE_THREAD_RESOURCES: parseBoolLike(
      process.env.AGENTCHATBUS_EXPOSE_THREAD_RESOURCES ?? persisted.EXPOSE_THREAD_RESOURCES ?? "false",
      false
    ),
    ENABLE_HANDOFF_TARGET: parseBoolLike(
      process.env.AGENTCHATBUS_ENABLE_HANDOFF_TARGET ?? persisted.ENABLE_HANDOFF_TARGET ?? "false",
      false
    ),
    ENABLE_STOP_REASON: parseBoolLike(
      process.env.AGENTCHATBUS_ENABLE_STOP_REASON ?? persisted.ENABLE_STOP_REASON ?? "false",
      false
    ),
    ENABLE_PRIORITY: parseBoolLike(
      process.env.AGENTCHATBUS_ENABLE_PRIORITY ?? persisted.ENABLE_PRIORITY ?? "false",
      false
    ),
    SHOW_AD: parseBoolLike(process.env.AGENTCHATBUS_SHOW_AD, false),
  };
}

export function getConfig(): AppConfig {
  const persisted = getPersistedConfig();
  const host = pickEnvOrPersisted(process.env.AGENTCHATBUS_HOST, persisted.HOST, "127.0.0.1");
  const appDir = getAppDir();
  return {
    host,
    port: Number(pickEnvOrPersisted(process.env.AGENTCHATBUS_PORT, persisted.PORT, "39765")),
    dbPath: process.env.AGENTCHATBUS_DB || join(appDir, "bus-ts.db"),
    adminToken: ADMIN_TOKEN,
    agentHeartbeatTimeout: Number(
      pickEnvOrPersisted(process.env.AGENTCHATBUS_HEARTBEAT_TIMEOUT, persisted.AGENT_HEARTBEAT_TIMEOUT, "60")
    ),
    msgWaitTimeout: Number(
      pickEnvOrPersisted(process.env.AGENTCHATBUS_WAIT_TIMEOUT, persisted.MSG_WAIT_TIMEOUT, "300")
    ),
    // TS-only enhancement (non-Python parity):
    // clamp short msg_wait timeout_ms values for blocking waits.
    msgWaitMinTimeoutMs: Number(
      pickEnvOrPersisted(
        process.env.AGENTCHATBUS_WAIT_MIN_TIMEOUT_MS,
        persisted.MSG_WAIT_MIN_TIMEOUT_MS,
        DEFAULT_MSG_WAIT_MIN_TIMEOUT_MS
      )
    ),
    replyTokenLeaseSeconds: Number(
      pickEnvOrPersisted(
        process.env.AGENTCHATBUS_REPLY_TOKEN_LEASE_SECONDS,
        persisted.REPLY_TOKEN_LEASE_SECONDS,
        "3600"
      )
    ),
    seqTolerance: Number(
      pickEnvOrPersisted(process.env.AGENTCHATBUS_SEQ_TOLERANCE, persisted.SEQ_TOLERANCE, "0")
    ),
    seqMismatchMaxMessages: Number(
      pickEnvOrPersisted(
        process.env.AGENTCHATBUS_SEQ_MISMATCH_MAX_MESSAGES,
        persisted.SEQ_MISMATCH_MAX_MESSAGES,
        "100"
      )
    ),
    rateLimitMsgPerMinute: Number(
      pickEnvOrPersisted(process.env.AGENTCHATBUS_RATE_LIMIT, persisted.RATE_LIMIT_MSG_PER_MINUTE, "30")
    ),
    threadTimeoutMinutes: Number(process.env.AGENTCHATBUS_THREAD_TIMEOUT || "0"),
    threadTimeoutSweepInterval: Number(process.env.AGENTCHATBUS_TIMEOUT_SWEEP_INTERVAL || "60"),
    reloadEnabled: parseBoolLike(process.env.AGENTCHATBUS_RELOAD, false),
    exposeThreadResources: parseBoolLike(
      process.env.AGENTCHATBUS_EXPOSE_THREAD_RESOURCES ?? persisted.EXPOSE_THREAD_RESOURCES ?? "false",
      false
    ),
    contentFilterEnabled: parseBoolLike(process.env.AGENTCHATBUS_CONTENT_FILTER_ENABLED ?? "true", true),
  };
}
