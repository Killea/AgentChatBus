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
import { getMemoryStore } from "../http/server.js";

// Store active transports by session ID
const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * Create a new MCP server instance with all handlers configured.
 */
function createMcpServer(): Server {
  const server = new Server(
    {
      name: "agentchatbus",
      version: "0.2.2",
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
    const store = getMemoryStore();
    const threads = store.getThreads(false);
    return {
      resources: threads.map((thread: any) => ({
        uri: `agentchatbus://threads/${thread.id}`,
        name: thread.topic,
        mimeType: "application/json",
      })),
    };
  });

  // Read resource handler
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params?.uri as string;
    // Parse thread ID from URI
    const match = uri.match(/agentchatbus:\/\/threads\/(.+)/);
    if (!match) {
      throw new Error(`Invalid resource URI: ${uri}`);
    }
    const threadId = match[1];
    const store = getMemoryStore();
    const thread = store.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(thread),
        },
      ],
    };
  });

  // List prompts handler
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: "agent_coordination",
          description: "Prompt for agent coordination",
          arguments: [{ name: "thread_topic", required: true }],
        },
      ],
    };
  });

  // Get prompt handler
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const args = request.params?.arguments || {};
    const topic = (args as any).thread_topic || "General";
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are coordinating agents for thread: ${topic}. Help manage the conversation flow.`,
          },
        },
      ],
    };
  });

  return server;
}

/**
 * Get or create a transport for a session.
 */
export function getOrCreateTransport(sessionId?: string): {
  transport: StreamableHTTPServerTransport;
  sessionId: string;
  isNew: boolean;
} {
  if (sessionId && transports.has(sessionId)) {
    return { transport: transports.get(sessionId)!, sessionId, isNew: false };
  }

  const newSessionId = sessionId || randomUUID();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
  });

  transports.set(newSessionId, transport);

  // Create and connect MCP server to transport
  const mcpServer = createMcpServer();
  mcpServer.connect(transport).catch((err) => {
    console.error(`[MCP] Failed to connect server to transport: ${err.message}`);
    transports.delete(newSessionId);
  });

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
}

/**
 * Get all active session IDs.
 */
export function getActiveSessions(): string[] {
  return Array.from(transports.keys());
}
