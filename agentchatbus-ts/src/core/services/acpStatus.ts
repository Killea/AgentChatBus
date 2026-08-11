/**
 * ACP agent status detection and enabled-state management.
 *
 * Provides:
 * - Binary availability detection (which/where) for system-path agents
 * - npx availability check (npx itself must be on PATH)
 * - Per-agent enabled state persisted to a JSON file
 * - Cached status snapshots with manual refresh
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { logError, logInfo } from "../../shared/logger.js";
import {
  ACP_AGENTS,
  resolveAcpSpawnCommand,
  getPlatformKey,
  type AcpAgentConfig,
} from "./acpRegistry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AcpAgentStatus = "available" | "not_found" | "unknown";

export interface AcpAgentStatusEntry {
  id: string;
  name: string;
  description: string;
  distribution: "binary" | "npx";
  mode: "acp";
  status: AcpAgentStatus;
  status_detail: string;
  command: string;
  args: string[];
  enabled: boolean;
  platform: string;
}

export interface AcpAgentStatusResult {
  default_agent: string;
  agents: AcpAgentStatusEntry[];
  refreshed_at: string;
}

// ---------------------------------------------------------------------------
// Enabled-state persistence
// ---------------------------------------------------------------------------

function getEnabledStatePath(): string {
  const dir = join(homedir(), ".config", "agentchatbus");
  return join(dir, "acp-agents-enabled.json");
}

function loadEnabledState(): Record<string, boolean> {
  try {
    const path = getEnabledStatePath();
    if (!existsSync(path)) {
      return {};
    }
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
  } catch (error) {
    logError(`[acp-status] Failed to load enabled state: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {};
}

function saveEnabledState(state: Record<string, boolean>): void {
  try {
    const path = getEnabledStatePath();
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    logError(`[acp-status] Failed to save enabled state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

/**
 * Check if a command is available on PATH.
 * Uses `which` on Unix and `where` on Windows.
 */
function isCommandOnPath(command: string): boolean {
  // Don't check "npx" — it's virtually always available if Node is installed.
  // We check it anyway for completeness.
  try {
    const checker = process.platform === "win32" ? "where" : "which";
    execFileSync(checker, [command], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if npx is available (for npx-distributed agents).
 */
function isNpxAvailable(): boolean {
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  return isCommandOnPath(npxCmd);
}

// ---------------------------------------------------------------------------
// Status detection
// ---------------------------------------------------------------------------

let cachedResult: AcpAgentStatusResult | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

function detectAgentStatus(
  agent: AcpAgentConfig,
  enabledState: Record<string, boolean>,
): AcpAgentStatusEntry {
  const spawnInfo = resolveAcpSpawnCommand(agent.id);
  const platform = getPlatformKey();

  if (!spawnInfo) {
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description || "",
      distribution: agent.distribution,
      mode: "acp",
      status: "not_found",
      status_detail: `No binary distribution for platform ${platform}`,
      command: "",
      args: [],
      enabled: enabledState[agent.id] ?? false,
      platform,
    };
  }

  let status: AcpAgentStatus = "unknown";
  let statusDetail = "";

  if (agent.distribution === "npx") {
    // npx agents are "available" if npx itself is on PATH.
    // The package will be auto-downloaded on first spawn.
    if (isNpxAvailable()) {
      status = "available";
      statusDetail = "Will auto-download via npx on first use";
    } else {
      status = "not_found";
      statusDetail = "npx not found on PATH. Install Node.js to use npx-distributed agents.";
    }
  } else if (agent.distribution === "binary" && agent.useSystemPath) {
    // For system-path binaries, check if the command is on PATH.
    if (isCommandOnPath(spawnInfo.command)) {
      status = "available";
      statusDetail = `Found "${spawnInfo.command}" on PATH`;
    } else {
      status = "not_found";
      statusDetail = `"${spawnInfo.command}" not found on PATH. Install it or add to PATH.`;
    }
  } else if (agent.distribution === "binary") {
    // For non-system-path binaries, we'd need to download the archive.
    // For now, mark as unknown — archive download is a future feature.
    status = "unknown";
    statusDetail = "Binary archive download not yet implemented. Install manually and set useSystemPath.";
  }

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description || "",
    distribution: agent.distribution,
    mode: "acp",
    status,
    status_detail: statusDetail,
    command: spawnInfo.command,
    args: spawnInfo.args,
    enabled: enabledState[agent.id] ?? false,
    platform,
  };
}

/**
 * Detect status for all ACP agents and return a full status result.
 */
export function detectAllAgentStatuses(force = false): AcpAgentStatusResult {
  const now = Date.now();
  if (!force && cachedResult && now - cacheTime < CACHE_TTL_MS) {
    return cachedResult;
  }

  const enabledState = loadEnabledState();
  const agents = ACP_AGENTS.map((agent) => detectAgentStatus(agent, enabledState));

  // Determine default agent: first enabled + available agent, or "devin"
  const defaultAgent =
    agents.find((a) => a.enabled && a.status === "available")?.id || "devin";

  cachedResult = {
    default_agent: defaultAgent,
    agents,
    refreshed_at: new Date().toISOString(),
  };
  cacheTime = now;

  logInfo(
    `[acp-status] Detected ${agents.filter((a) => a.status === "available").length}/${agents.length} agents available, ${agents.filter((a) => a.enabled).length} enabled`,
  );

  return cachedResult;
}

/**
 * Update the enabled state for a set of agents.
 * Only agents with status "available" can be enabled.
 */
export function updateEnabledState(updates: Record<string, boolean>): AcpAgentStatusResult {
  const current = loadEnabledState();
  const statusResult = detectAllAgentStatuses(true);
  const statusMap = new Map(statusResult.agents.map((a) => [a.id, a]));

  for (const [id, enabled] of Object.entries(updates)) {
    const agentStatus = statusMap.get(id);
    if (!agentStatus) {
      continue; // Unknown agent ID, skip
    }
    if (enabled && agentStatus.status !== "available") {
      // Cannot enable an unavailable agent
      continue;
    }
    current[id] = enabled;
  }

  saveEnabledState(current);

  // Re-detect with updated enabled state
  return detectAllAgentStatuses(true);
}

/**
 * Get the list of agents that are both enabled and available.
 * This is what the frontend should show in the adapter selector.
 */
export function getEnabledAgents(): AcpAgentStatusEntry[] {
  const result = detectAllAgentStatuses();
  return result.agents.filter((a) => a.enabled && a.status === "available");
}
