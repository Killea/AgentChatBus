export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
}

/**
 * Attention mechanism feature flags (UP-17).
 * Ported from Python src/config.py and src/tools/dispatch.py
 * Controls whether handoff_target, stop_reason, and priority fields
 * are returned to agents or stripped from responses.
 */
export const ENABLE_HANDOFF_TARGET = process.env.AGENTCHATBUS_ENABLE_HANDOFF_TARGET !== "false";
export const ENABLE_STOP_REASON = process.env.AGENTCHATBUS_ENABLE_STOP_REASON !== "false";
export const ENABLE_PRIORITY = process.env.AGENTCHATBUS_ENABLE_PRIORITY !== "false";

export function getConfig(): AppConfig {
  return {
    host: process.env.AGENTCHATBUS_HOST || "127.0.0.1",
    port: Number(process.env.AGENTCHATBUS_PORT || "39765"),
    dbPath: process.env.AGENTCHATBUS_DB || "data/bus-ts.db"
  };
}