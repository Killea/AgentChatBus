import { startHttpServer } from "../transports/http/server.js";
import { startSocketServer, getAgentSocketPath } from "../transports/socket/server.js";
import { getConfig } from "../core/config/env.js";
import { logInfo } from "../shared/logger.js";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * In V2 mode, copy the proxy script to the shared app directory so that
 * agent MCP configs can reference a stable path (~/.agentchatbus/proxy.mjs)
 * regardless of which IDE extension is running the daemon.
 */
function ensureProxyScriptInAppDir(): string | null {
  try {
    const config = getConfig();
    const targetPath = join(config.appDir, "proxy.mjs");
    // Find the source proxy.mjs relative to this compiled file.
    // In bundled mode: dist/cli/index.js → dist/transports/socket/proxy.mjs
    // In dev mode:     src/cli/serve.ts  → src/transports/socket/proxy.mjs (via tsx)
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(thisDir, "transports", "socket", "proxy.mjs"),
      join(thisDir, "..", "transports", "socket", "proxy.mjs"),
      join(thisDir, "..", "..", "transports", "socket", "proxy.mjs"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        if (!existsSync(targetPath) || readFileSyncSafe(candidate) !== readFileSyncSafe(targetPath)) {
          copyFileSync(candidate, targetPath);
          logInfo(`[v2] Copied proxy script to ${targetPath}`);
        }
        return targetPath;
      }
    }
    logInfo(`[v2] Warning: could not locate proxy.mjs to copy to app dir`);
    return null;
  } catch (err) {
    logInfo(`[v2] Warning: failed to copy proxy script: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function readFileSyncSafe(p: string): string {
  try {
    return require("node:fs").readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

export async function runServe(): Promise<void> {
  const config = getConfig();
  const server = await startHttpServer();
  const address = server.addresses().map((entry) => `${entry.address}:${entry.port}`).join(", ");
  logInfo(`serve mode listening on ${address}`);

  // V2: start the socket server for agent connections (no IP/port needed).
  // The HTTP server remains for the Web UI backend and is not affected.
  if (config.agentTransport === "v2-socket") {
    const sockPath = getAgentSocketPath();
    startSocketServer(sockPath);
    logInfo(`serve mode v2 agent transport on ${sockPath}`);
    // Copy proxy script to shared app dir for stable agent MCP config paths.
    ensureProxyScriptInAppDir();
  } else {
    logInfo(`serve mode v1 agent transport (HTTP) on ${address}/mcp`);
  }
}
