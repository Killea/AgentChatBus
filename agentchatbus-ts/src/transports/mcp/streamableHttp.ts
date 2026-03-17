/**
 * Streamable HTTP MCP Server Transport for AgentChatBus TS.
 * Uses official @modelcontextprotocol/sdk StreamableHTTPServerTransport.
 */
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callTool, listTools } from "../../adapters/mcp/tools.js";
import { BUS_VERSION } from "../../core/config/env.js";
import { getPromptResult, getPromptsList, getResourcesList, readResourceText } from "./handlers.js";

// Store active transports by session ID
const transports = new Map<string, StreamableHTTPServerTransport>();
const serverReady = new Map<string, Promise<void>>();

/**
 * Create a new MCP server instance with all handlers configured.
 */
function createMcpServer(): Server {
  const server = new Server(
    {
      name: "agentchatbus",
      version: BUS_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = listTools();
    return { tools };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params || {};
    const result = await callTool(args.name || "", args.arguments || {});

    // Convert result to MCP content blocks format
    if (Array.isArray(result)) {
      return { content: result };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  });

  // List resources handler
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: getResourcesList() };
  });

  // Read resource handler
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params?.uri as string;
    const text = readResourceText(uri);
    return {
      contents: [
        {
          uri,
          mimeType: uri.endsWith("/transcript") || uri.endsWith("/summary") ? "text/plain" : "application/json",
          text,
        },
      ],
    };
  });

  // List prompts handler
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: getPromptsList() };
  });

  // Get prompt handler
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params?.name as string;
    const args = (request.params?.arguments || {}) as Record<string, unknown>;
    return getPromptResult(name, args);
  });

  return server;
}

/**
 * Get or create a transport for a session.
 * Returns the transport and a promise that resolves when server is ready.
 */
export async function getOrCreateTransport(sessionId?: string): Promise<{
  transport: StreamableHTTPServerTransport;
  sessionId: string;
  isNew: boolean;
}> {
  // If session exists and server is ready, return it
  if (sessionId && transports.has(sessionId)) {
    const readyPromise = serverReady.get(sessionId);
    if (readyPromise) {
      await readyPromise;
    }
    return { transport: transports.get(sessionId)!, sessionId, isNew: false };
  }

  const newSessionId = sessionId || randomUUID();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
  });

  transports.set(newSessionId, transport);

  // Create and connect MCP server to transport
  const mcpServer = createMcpServer();
  const connectPromise = mcpServer.connect(transport).catch((err) => {
    console.error(`[MCP] Failed to connect server to transport: ${err.message}`);
    transports.delete(newSessionId);
    serverReady.delete(newSessionId);
    throw err;
  });

  serverReady.set(newSessionId, connectPromise);
  await connectPromise;

  return { transport, sessionId: newSessionId, isNew: true };
}

/**
 * Get an existing transport by session ID.
 */
export function getTransport(sessionId: string): StreamableHTTPServerTransport | undefined {
  return transports.get(sessionId);
}

/**
 * Delete a transport (cleanup).
 */
export function deleteTransport(sessionId: string): void {
  transports.delete(sessionId);
  serverReady.delete(sessionId);
}

/**
 * Get all active session IDs.
 */
export function getActiveSessions(): string[] {
  return Array.from(transports.keys());
}
