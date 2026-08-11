/**
 * Streamable HTTP MCP Server Transport for AgentChatBus TS.
 * Uses official @modelcontextprotocol/sdk StreamableHTTPServerTransport.
 */
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callTool, listTools, withToolCallContext } from "../../adapters/mcp/tools.js";
import { BUS_VERSION } from "../../core/config/env.js";
import { getPromptResult, getPromptsList, getResourcesList, readResourceText } from "./handlers.js";

// Store active transports by session ID
const streamableTransports = new Map<string, StreamableHTTPServerTransport>();
const streamableServerReady = new Map<string, Promise<void>>();
const sseTransports = new Map<string, SSEServerTransport>();

/**
 * Create a new MCP server instance with all handlers configured.
 */
export function createMcpServer(sessionId?: string): Server {
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
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params || {};
    console.log(`[mcp-streamable] tools/call: name=${args.name}, args=${JSON.stringify(args.arguments || {}).slice(0, 200)}`);
    const result = await withToolCallContext(
      {
        sessionId: extra.sessionId || sessionId,
        abortSignal: extra.signal,
      },
      () => callTool(args.name || "", args.arguments || {})
    );
    console.log(`[mcp-streamable] tools/call result: ${JSON.stringify(result).slice(0, 200)}`);

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
  if (sessionId && streamableTransports.has(sessionId)) {
    const readyPromise = streamableServerReady.get(sessionId);
    if (readyPromise) {
      await readyPromise;
    }
    return { transport: streamableTransports.get(sessionId)!, sessionId, isNew: false };
  }

  const newSessionId = sessionId || randomUUID();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
  });

  transport.onclose = () => {
    streamableTransports.delete(newSessionId);
    streamableServerReady.delete(newSessionId);
  };

  streamableTransports.set(newSessionId, transport);

  // Create and connect MCP server to transport
  const mcpServer = createMcpServer(newSessionId);
  const connectPromise = mcpServer.connect(transport).catch((err) => {
    console.error(`[MCP] Failed to connect server to transport: ${err.message}`);
    streamableTransports.delete(newSessionId);
    streamableServerReady.delete(newSessionId);
    throw err;
  });

  streamableServerReady.set(newSessionId, connectPromise);
  await connectPromise;

  return { transport, sessionId: newSessionId, isNew: true };
}

/**
 * Get an existing transport by session ID.
 */
export function getTransport(sessionId: string): StreamableHTTPServerTransport | undefined {
  return streamableTransports.get(sessionId);
}

/**
 * Register a legacy SSE transport after it has been created in the HTTP layer.
 */
export function registerLegacySseTransport(transport: SSEServerTransport): string {
  const sessionId = transport.sessionId;
  sseTransports.set(sessionId, transport);
  transport.onclose = () => {
    sseTransports.delete(sessionId);
  };
  return sessionId;
}

/**
 * Connect a legacy SSE transport to a fresh MCP server instance.
 */
export async function connectLegacySseTransport(transport: SSEServerTransport): Promise<void> {
  const mcpServer = createMcpServer(transport.sessionId);
  await mcpServer.connect(transport);
}

/**
 * Get an existing legacy SSE transport by session ID.
 */
export function getLegacySseTransport(sessionId: string): SSEServerTransport | undefined {
  return sseTransports.get(sessionId);
}

/**
 * Delete a transport (cleanup).
 */
export function deleteTransport(sessionId: string): void {
  streamableTransports.delete(sessionId);
  streamableServerReady.delete(sessionId);
  sseTransports.delete(sessionId);
}

/**
 * Get all active session IDs.
 */
export function getActiveSessions(): string[] {
  return Array.from(new Set([
    ...streamableTransports.keys(),
    ...sseTransports.keys(),
  ]));
}
