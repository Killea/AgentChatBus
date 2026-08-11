/**
 * Stdio MCP proxy for AgentChatBus.
 *
 * This script is launched as a child process by ACP agents (e.g., Devin CLI)
 * that only support stdio MCP servers. It reads JSON-RPC 2.0 messages from
 * stdin, forwards tool calls to the AgentChatBus HTTP MCP endpoint, and
 * writes JSON-RPC 2.0 responses to stdout.
 *
 * The proxy handles the Streamable HTTP MCP session lifecycle:
 *   1. On the first `initialize` request from the agent, it initializes a
 *      session with the HTTP MCP server and captures the `mcp-session-id`.
 *   2. Subsequent `tools/call` and `tools/list` requests are forwarded to
 *      the HTTP MCP server with the session ID header.
 *
 * Environment variables (set by the ACP adapter):
 *   AGENTCHATBUS_BASE_URL   - Base URL of the AgentChatBus HTTP server
 */

import { createInterface } from "node:readline";
import { request } from "node:http";

const BASE_URL = process.env.AGENTCHATBUS_BASE_URL || "http://127.0.0.1:39766";
const MCP_URL = `${BASE_URL.replace(/\/+$/, "")}/mcp`;

// Parse the URL for use with node:http
const urlObj = new URL(MCP_URL);

let mcpSessionId = null;
let initialized = false;
let initPromise = null;

// MCP tools list — must match the tools registered in src/adapters/mcp/tools.ts
const TOOLS = [
  {
    name: "bus_connect",
    description: "One-step connect: register an agent and join (or create) a thread. Returns agent identity, thread details, full message history, and sync context (current_seq, reply_token, reply_window). Clients can use that sync context directly for the first msg_post without an extra msg_wait call. If the thread does not exist, it is created automatically and the agent becomes the thread administrator.",
    inputSchema: {
      type: "object",
      properties: {
        thread_name: { type: "string" },
        thread_id: { type: "string" },
        agent_id: { type: "string" },
        token: { type: "string" },
        ide: { type: "string" },
        model: { type: "string" },
        display_name: { type: "string" },
        description: { type: "string" },
      },
    },
  },
  {
    name: "msg_post",
    description: "Post a message to a thread. Requires strict sync fields (reply_token, current_seq).",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        agent_id: { type: "string" },
        token: { type: "string" },
        content: { type: "string" },
        reply_token: { type: "string" },
      },
      required: ["thread_id", "agent_id", "token", "content"],
    },
  },
  {
    name: "msg_wait",
    description: "Block until at least one new message arrives in the thread after after_seq. Returns immediately if messages are already available. Always includes sync context (current_seq, reply_token, reply_window) for the next strict msg_post call.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        agent_id: { type: "string" },
        token: { type: "string" },
        after_seq: { type: "number" },
        timeout: { type: "number" },
        max_messages: { type: "number" },
        reply_token: { type: "string" },
      },
      required: ["thread_id", "agent_id", "token"],
    },
  },
  {
    name: "thread_create",
    description: "Create a new conversation thread (topic / task context) on the bus. Authentication is mandatory: provide creator credentials explicitly in input using agent_id and token.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        agent_id: { type: "string" },
        token: { type: "string" },
      },
      required: ["topic", "agent_id", "token"],
    },
  },
  {
    name: "thread_list",
    description: "List all threads on the bus.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "agent_register",
    description: "Register a new agent on the bus.",
    inputSchema: {
      type: "object",
      properties: {
        ide: { type: "string" },
        model: { type: "string" },
        display_name: { type: "string" },
      },
    },
  },
  {
    name: "agent_resume",
    description: "Resume an existing agent session using agent_id and token.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        token: { type: "string" },
      },
      required: ["agent_id", "token"],
    },
  },
  {
    name: "sync_context",
    description: "Get sync context for a thread (current_seq, reply_token, reply_window).",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        agent_id: { type: "string" },
        token: { type: "string" },
      },
      required: ["thread_id", "agent_id", "token"],
    },
  },
  {
    name: "get_wait_states",
    description: "Get current wait states for a thread.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
      },
      required: ["thread_id"],
    },
  },
];

/**
 * Send a JSON-RPC request to the HTTP MCP server and parse the SSE response.
 * Returns the result object, or null for notifications.
 */
async function sendMcpRequest(method, params, isNotification = false) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (mcpSessionId) {
    headers["mcp-session-id"] = mcpSessionId;
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    ...(isNotification ? {} : { id: Date.now() }),
    method,
    params: params || {},
  });


  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: "POST",
        headers,
      },
      (res) => {
        
        // Capture session ID from response headers
        const newSessionId = res.headers["mcp-session-id"];
        if (newSessionId) {
          mcpSessionId = newSessionId;
        }

        if (res.statusCode !== 200 && res.statusCode !== 202) {
          let errorText = "";
          res.on("data", (chunk) => (errorText += chunk));
          res.on("end", () => {
            reject(new Error(`MCP HTTP error ${res.statusCode}: ${errorText.slice(0, 200)}`));
          });
          return;
        }

        // Notifications may return 202 with no body
        if (res.statusCode === 202) {
          resolve(null);
          return;
        }

        const contentType = res.headers["content-type"] || "";
        let responseBody = "";

        if (contentType.includes("text/event-stream")) {
          // SSE stream — parse events as they arrive, resolve when we get a complete event
          let lineBuffer = "";
          res.on("data", (chunk) => {
            const text = chunk.toString();
            lineBuffer += text;
            // Check if we have a complete SSE event (ends with \n\n)
            const eventEnd = lineBuffer.indexOf("\n\n");
            if (eventEnd !== -1) {
              const eventText = lineBuffer.slice(0, eventEnd);
              lineBuffer = lineBuffer.slice(eventEnd + 2);
              const lines = eventText.split("\n");
              let foundData = null;
              for (const line of lines) {
                if (line.startsWith("data: ")) {
                  const trimmed = line.slice(6).trim();
                  if (trimmed) {
                    foundData = JSON.parse(trimmed);
                  }
                }
              }
              if (foundData) {
                // We got our response — destroy the stream and resolve
                res.destroy();
                if (foundData.error) {
                  reject(new Error(foundData.error.message || "MCP tool call failed"));
                  return;
                }
                resolve(foundData.result);
              }
            }
          });
          res.on("end", () => {
            resolve(null);
          });
          res.on("error", (err) => {
            reject(err);
          });
        } else {
          // Regular JSON response
          res.on("data", (chunk) => (responseBody += chunk));
          res.on("end", () => {
            if (!responseBody) {
              resolve(null);
              return;
            }
            try {
              const data = JSON.parse(responseBody);
              if (data.error) {
                reject(new Error(data.error.message || "MCP tool call failed"));
                return;
              }
              resolve(data.result);
            } catch (e) {
              reject(new Error(`Failed to parse JSON response: ${e.message}`));
            }
          });
        }
      }
    );

    req.on("error", (err) => {
      reject(err);
    });
    req.on("socket", (socket) => {
    });
    req.write(body);
    req.end();
  });
}

/**
 * Initialize the MCP session with the HTTP server.
 */
async function ensureInitialized() {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = doInitialize();
  return initPromise;
}

async function doInitialize() {
  await sendMcpRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "agentchatbus-stdio-proxy", version: "1.0.0" },
  });
  // Send initialized notification (no response expected)
  try {
    await sendMcpRequest("notifications/initialized", {}, true);
  } catch {
    // Notifications may not return a result, ignore errors
  }
  initialized = true;
}

async function handleRequest(payload) {
  const method = payload.method;
  const id = payload.id;

  // Handle initialize locally — set up MCP HTTP session
  if (method === "initialize") {
    await ensureInitialized();
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agentchatbus-stdio-proxy", version: "1.0.0" },
      },
    };
  }

  if (method === "notifications/initialized") {
    return null; // Notification, no response
  }

  // For tools/list, return our local tool list (faster, no HTTP round-trip)
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS },
    };
  }

  // For tools/call, forward to the HTTP MCP server
  if (method === "tools/call") {
    const params = (payload.params || {});
    const toolName = String(params.name || "");
    const toolArgs = params.arguments || {};
    try {
      await ensureInitialized();
      const result = await sendMcpRequest("tools/call", { name: toolName, arguments: toolArgs });
      return {
        jsonrpc: "2.0",
        id,
        result: result || { content: [{ type: "text", text: "null" }] },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: detail },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

// Read stdin as a raw stream and split by newlines
let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let newlineIdx;
  while ((newlineIdx = stdinBuffer.indexOf("\n")) !== -1) {
    const line = stdinBuffer.slice(0, newlineIdx).trim();
    stdinBuffer = stdinBuffer.slice(newlineIdx + 1);
    if (line) {
      handleLine(line);
    }
  }
});

process.stdin.on("end", () => {
  if (stdinBuffer.trim()) {
    handleLine(stdinBuffer.trim());
  }
  process.exit(0);
});

async function handleLine(line) {

  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
    return;
  }

  try {
    const response = await handleRequest(payload);
    if (response !== null) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: payload.id || null, error: { code: -32603, message: detail } })}\n`);
  }
}
