/**
 * V2 agent transport: Unix domain socket / Windows named pipe server.
 *
 * Exposes the MCP JSON-RPC protocol over a local socket (no HTTP, no IP config).
 * Reuses the same handler logic as the HTTP MCP endpoint (handlers.ts).
 *
 * The socket path is derived from the app directory so it automatically follows
 * the database location. On Linux/macOS this is a filesystem path
 * (e.g. ~/.agentchatbus/agent.sock); on Windows xpipe rewrites it to a named
 * pipe (e.g. \\.\pipe\agent.sock).
 */
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import xpipe from "xpipe";
import { handleMcpRequest } from "../mcp/handlers.js";
import { getConfig } from "../../core/config/env.js";
import { logInfo, logError } from "../../shared/logger.js";

/**
 * Resolve the socket path for the v2 agent transport.
 * Placed in the app directory alongside the SQLite database.
 */
export function getAgentSocketPath(): string {
  const { appDir } = getConfig();
  const raw = join(appDir, "agent.sock");
  return xpipe.eq(raw);
}

/**
 * Start the v2 socket server.
 *
 * Returns the net.Server instance. The caller is responsible for shutting it
 * down during the normal HTTP server lifecycle.
 */
export function startSocketServer(socketPath?: string): Server {
  const path = socketPath || getAgentSocketPath();

  // Clean up any stale socket file from a previous crash (Unix only).
  // On Windows named pipes are auto-removed when the owning process exits.
  if (process.platform !== "win32") {
    try {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    } catch {
      // best-effort cleanup
    }
  }

  const server = createServer((sock: Socket) => {
    let buffer = "";

    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      // Newline-delimited JSON-RPC (same framing as stdio MCP).
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          handleSocketLine(line, sock).catch((err) => {
            logError(`[socket-v2] handler error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }
    });

    sock.on("error", (err: Error) => {
      // Suppress ECONNRESET — normal when a client disconnects abruptly.
      if (!String(err.message).includes("ECONNRESET")) {
        logError(`[socket-v2] socket error: ${err.message}`);
      }
    });
  });

  server.on("error", (err: Error) => {
    logError(`[socket-v2] server error: ${err.message}`);
  });

  server.listen(path, () => {
    logInfo(`[socket-v2] agent transport listening on ${path}`);
  });

  return server;
}

/**
 * Parse one JSON-RPC line, dispatch to handleMcpRequest, and write the response
 * back to the socket as a newline-delimited JSON string.
 */
async function handleSocketLine(line: string, sock: Socket): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(line);
  } catch {
    sock.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
    );
    return;
  }

  try {
    const response = await handleMcpRequest(payload);
    // Notifications (e.g. notifications/initialized) return null — no response.
    if (response !== null) {
      sock.write(`${JSON.stringify(response)}\n`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    sock.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id ?? null,
        error: { code: -32603, message: detail },
      })}\n`,
    );
  }
}
