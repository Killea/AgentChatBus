/**
 * Simple MCP utilities for AgentChatBus TS.
 * Provides helper functions for handling MCP protocol requests.
 */
import { callTool, listTools } from "../../adapters/mcp/tools.js";
import { getMemoryStore } from "../http/server.js";

/**
 * Handle initialize request
 */
export async function handleInitialize(body: any): Promise<any> {
  return {
    jsonrpc: "2.0",
    id: body.id,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      serverInfo: {
        name: "agentchatbus",
        version: "0.2.2",
      },
    },
  };
}

/**
 * Handle tools/list request
 */
export async function handleToolsList(body: any): Promise<any> {
  const tools = listTools();
  return { jsonrpc: "2.0", id: body.id, result: { tools } };
}

/**
 * Handle tools/call request
 */
export async function handleToolsCall(body: any): Promise<any> {
  const args = body.params || {};
  const result = await callTool(args.name || "", args.arguments || {});

  if (Array.isArray(result)) {
    return { jsonrpc: "2.0", id: body.id, result: { content: result } };
  }
  return {
    jsonrpc: "2.0",
    id: body.id,
    result: { content: [{ type: "text", text: JSON.stringify(result) }] },
  };
}

/**
 * Handle resources/list request
 */
export async function handleResourcesList(body: any): Promise<any> {
  const store = getMemoryStore();
  const threads = store.getThreads(false);
  return {
    jsonrpc: "2.0",
    id: body.id,
    result: {
      resources: threads.map((thread: any) => ({
        uri: `agentchatbus://threads/${thread.id}`,
        name: thread.topic,
        mimeType: "application/json",
      })),
    },
  };
}

/**
 * Handle prompts/list request
 */
export async function handlePromptsList(body: any): Promise<any> {
  return {
    jsonrpc: "2.0",
    id: body.id,
    result: {
      prompts: [
        {
          name: "agent_coordination",
          description: "Prompt for agent coordination",
          arguments: [{ name: "thread_topic", required: true }],
        },
      ],
    },
  };
}

/**
 * Handle MCP request based on method
 */
export async function handleMcpRequest(body: any): Promise<any> {
  const method = body.method;

  switch (method) {
    case "initialize":
      return handleInitialize(body);
    case "tools/list":
      return handleToolsList(body);
    case "tools/call":
      return handleToolsCall(body);
    case "resources/list":
      return handleResourcesList(body);
    case "prompts/list":
      return handlePromptsList(body);
    case "notifications/initialized":
      return null; // No response for notifications
    default:
      return {
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}
