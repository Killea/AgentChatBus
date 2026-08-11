/**
 * Stdio MCP proxy for AgentChatBus.
 *
 * This script is launched as a child process by ACP agents (e.g., Devin CLI)
 * that only support stdio MCP servers. It reads JSON-RPC 2.0 messages from
 * stdin, forwards tool calls to the AgentChatBus HTTP API, and writes
 * JSON-RPC 2.0 responses to stdout.
 *
 * Environment variables (set by the ACP adapter):
 *   AGENTCHATBUS_BASE_URL   - Base URL of the AgentChatBus HTTP server
 *   AGENTCHATBUS_THREAD_ID  - Thread ID (optional, for context)
 *   AGENTCHATBUS_AGENT_ID   - Agent ID (optional, for context)
 *   AGENTCHATBUS_AGENT_TOKEN - Agent token (optional, for context)
 */

import { createInterface } from "node:readline";

const BASE_URL = process.env.AGENTCHATBUS_BASE_URL || "http://127.0.0.1:39766";
const MCP_URL = `${BASE_URL.replace(/\/+$/, "")}/mcp`;

// MCP tools list — must match the tools registered in src/adapters/mcp/tools.ts
const TOOLS = [
  {
    name: "bus_connect",
    description: "One-step connect: register an agent and join (or create) a thread.",
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
    description: "Post a message to a thread.",
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
    description: "Wait for new messages in a thread.",
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
    description: "Create a new conversation thread.",
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
    description: "List all threads.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "agent_register",
    description: "Register a new agent.",
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
    description: "Resume an existing agent session.",
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
    description: "Get sync context for a thread.",
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

async function callToolViaHttp(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Use the MCP HTTP endpoint to forward the tool call
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`MCP HTTP error: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream")) {
    // Parse SSE response
    const text = await response.text();
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data) {
          const parsed = JSON.parse(data);
          if (parsed.result?.content) {
            return parsed.result.content;
          }
          return parsed.result || parsed;
        }
      }
    }
    throw new Error("Empty SSE response");
  } else {
    // JSON response
    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || "MCP tool call failed");
    }
    return data.result?.content || data.result;
  }
}

async function handleRequest(payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const method = payload.method;
  const id = payload.id;

  if (method === "initialize") {
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

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS },
    };
  }

  if (method === "tools/call") {
    const params = (payload.params || {}) as { name?: string; arguments?: Record<string, unknown> };
    const toolName = String(params.name || "");
    const toolArgs = params.arguments || {};
    try {
      const result = await callToolViaHttp(toolName, toolArgs);
      return {
        jsonrpc: "2.0",
        id,
        result: { content: Array.isArray(result) ? result : [{ type: "text", text: JSON.stringify(result) }] },
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

  // Unknown method
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

// Main loop: read JSON-RPC messages from stdin, write responses to stdout
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(trimmed);
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
});

// Keep the process alive
rl.on("close", () => {
  process.exit(0);
});
