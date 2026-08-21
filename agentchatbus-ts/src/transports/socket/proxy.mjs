/**
 * V2 stdio-to-socket MCP proxy for AgentChatBus.
 *
 * This script is launched as a child process by agent CLIs (Cursor, Claude,
 * Codex, etc.) configured with a stdio MCP server entry. It reads JSON-RPC 2.0
 * messages from stdin, forwards them to the AgentChatBus v2 socket server
 * (Unix domain socket on Linux/macOS, named pipe on Windows), and writes
 * JSON-RPC 2.0 responses to stdout.
 *
 * Zero external dependencies — runs on any Node.js version that VSCode ships.
 *
 * Environment variables (set by the daemon when patching agent MCP config):
 *   AGENTCHATBUS_SOCKET_PATH  - Path to the v2 socket (Unix path or Windows pipe)
 *
 * Fallback: if AGENTCHATBUS_SOCKET_PATH is not set, falls back to v1 HTTP mode
 * using AGENTCHATBUS_BASE_URL (legacy compatibility).
 */

import { createInterface } from "node:readline";
import { connect as netConnect } from "node:net";

const SOCKET_PATH = process.env.AGENTCHATBUS_SOCKET_PATH || "";
const BASE_URL = process.env.AGENTCHATBUS_BASE_URL || "http://127.0.0.1:39766";
const MCP_URL = `${BASE_URL.replace(/\/+$/, "")}/mcp`;

// ── Socket connection (v2) ──────────────────────────────────────────────────

let socketClient = null;
let socketBuffer = "";
const pendingSocketRequests = new Map(); // id -> { resolve, reject }
let nextSocketReqId = 1;

function ensureSocketClient() {
  if (socketClient) {
    return socketClient;
  }
  return new Promise((resolve, reject) => {
    const sock = netConnect(SOCKET_PATH);
    let connectTimeout = setTimeout(() => {
      sock.destroy();
      reject(new Error(`socket connect timeout: ${SOCKET_PATH}`));
    }, 5000);

    sock.on("connect", () => {
      clearTimeout(connectTimeout);
      connectTimeout = null;
      socketClient = sock;
      resolve(sock);
    });

    sock.on("error", (err) => {
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
        reject(new Error(`socket connect failed: ${err.message}`));
      }
    });

    sock.on("data", (chunk) => {
      socketBuffer += chunk.toString("utf8");
      let idx;
      while ((idx = socketBuffer.indexOf("\n")) >= 0) {
        const line = socketBuffer.slice(0, idx).trim();
        socketBuffer = socketBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && pendingSocketRequests.has(msg.id)) {
            const pending = pendingSocketRequests.get(msg.id);
            pendingSocketRequests.delete(msg.id);
            pending.resolve(msg);
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    sock.on("close", () => {
      socketClient = null;
      // Reject all pending requests
      for (const [, pending] of pendingSocketRequests) {
        pending.reject(new Error("socket closed"));
      }
      pendingSocketRequests.clear();
    });
  });
}

async function callViaSocket(payload) {
  const sock = await ensureSocketClient();
  const reqId = payload.id !== undefined ? payload.id : nextSocketReqId++;
  const forwarded = { ...payload, id: reqId };

  return new Promise((resolve, reject) => {
    pendingSocketRequests.set(reqId, { resolve, reject });
    sock.write(`${JSON.stringify(forwarded)}\n`);

    // Timeout: match msg_wait max (5 min) + buffer
    setTimeout(() => {
      if (pendingSocketRequests.has(reqId)) {
        pendingSocketRequests.delete(reqId);
        reject(new Error("socket request timeout"));
      }
    }, 330000);
  });
}

// ── HTTP fallback (v1) ──────────────────────────────────────────────────────

async function callViaHttp(payload) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`MCP HTTP error: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data) {
          return JSON.parse(data);
        }
      }
    }
    throw new Error("Empty SSE response");
  } else {
    return await response.json();
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

async function forwardRequest(payload) {
  if (SOCKET_PATH) {
    return await callViaSocket(payload);
  }
  return await callViaHttp(payload);
}

// ── Main loop: read JSON-RPC from stdin, forward, write response to stdout ──

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
    );
    return;
  }

  // Notifications (no id) — forward but don't expect a response on stdout.
  const isNotification = payload.id === undefined || payload.id === null;

  try {
    const response = await forwardRequest(payload);
    if (response !== null && response !== undefined) {
      // For socket mode, response is the raw JSON-RPC reply.
      // For HTTP mode, response is the parsed JSON body.
      const result = response.result !== undefined ? response.result : response;
      if (isNotification) {
        // No response expected for notifications, but if server returned one, drop it.
        return;
      }
      const out = response.jsonrpc
        ? response
        : { jsonrpc: "2.0", id: payload.id, result };
      process.stdout.write(`${JSON.stringify(out)}\n`);
    }
  } catch (error) {
    if (isNotification) return;
    const detail = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id || null,
        error: { code: -32000, message: detail },
      })}\n`,
    );
  }
});

rl.on("close", () => {
  if (socketClient) {
    socketClient.destroy();
  }
  process.exit(0);
});
