/**
 * MCP utilities shared by HTTP legacy endpoint and stdio transport.
 * Keeps MCP method semantics aligned with Python `src/mcp_server.py`.
 */
import { callTool, listTools, withToolCallContext } from "../../adapters/mcp/tools.js";
import { BUS_VERSION, getConfig, getConfigDict } from "../../core/config/env.js";
import { getMemoryStore } from "../http/server.js";

type JsonRpcRequest = {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export function getResourcesList(): Array<{
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}> {
  const store = getMemoryStore();
  const threads = store.getThreads(false);
  const cfg = getConfig();

  const resources = [
    {
      uri: "chat://bus/config",
      name: "Bus Configuration",
      description:
        "Bus-level settings including preferred language and endpoint information.",
      mimeType: "application/json",
    },
    {
      uri: "chat://agents/active",
      name: "Active Agents",
      description: "All currently registered agents and their online status.",
      mimeType: "application/json",
    },
    {
      uri: "chat://threads/active",
      name: "Active Threads",
      description: "Summary list of all threads.",
      mimeType: "application/json",
    },
  ];

  if (cfg.exposeThreadResources) {
    for (const thread of threads) {
      resources.push(
        {
          uri: `chat://threads/${thread.id}/transcript`,
          name: `Transcript: ${thread.topic.slice(0, 40)}`,
          description: `Full conversation history for thread '${thread.topic}'`,
          mimeType: "text/plain",
        },
        {
          uri: `chat://threads/${thread.id}/state`,
          name: `State: ${thread.topic.slice(0, 40)}`,
          description: `Current state snapshot for thread '${thread.topic}'`,
          mimeType: "application/json",
        }
      );
      const summary = String((thread as unknown as { summary?: string }).summary || "");
      if (summary) {
        resources.push({
          uri: `chat://threads/${thread.id}/summary`,
          name: `Summary: ${thread.topic.slice(0, 40)}`,
          description: `Closed-thread summary for '${thread.topic}'`,
          mimeType: "text/plain",
        });
      }
    }
  }

  return resources;
}

export function readResourceText(uri: string): string {
  const store = getMemoryStore();
  const settings = getConfigDict();
  const cfg = getConfig();

  if (uri === "chat://bus/config") {
    return JSON.stringify(
      {
        preferred_language: "English",
        language_source: "default",
        language_note:
          "Please respond in English whenever possible. This is a soft preference - use your best judgement.",
        bus_name: "AgentChatBus",
        version: BUS_VERSION,
        endpoint: `http://${cfg.host}:${cfg.port}`,
        config: settings,
      },
      null,
      2
    );
  }

  if (uri === "chat://agents/active") {
    const agents = store.listAgents().map((agent) => ({
      agent_id: agent.id,
      name: agent.name,
      description: agent.description,
      capabilities: agent.capabilities || [],
      skills: agent.skills || [],
      is_online: agent.is_online,
    }));
    return JSON.stringify(agents, null, 2);
  }

  if (uri === "chat://threads/active") {
    const threads = store.getThreads(false).map((thread) => ({
      thread_id: thread.id,
      topic: thread.topic,
      status: thread.status,
      created_at: thread.created_at,
    }));
    return JSON.stringify(threads, null, 2);
  }

  if (uri.includes("/transcript")) {
    const parts = uri.split("/");
    const threadId = parts.length >= 4 ? parts[3] : "";
    const thread = store.getThread(threadId);
    if (!thread) {
      return "Thread not found.";
    }
    const messages = store.getMessages(threadId, 0);
    const lines = [`# Thread: ${thread.topic}  [status: ${thread.status}]`, ""];
    for (const msg of messages) {
      lines.push(`[seq=${msg.seq}] ${msg.author} (${msg.role}): ${msg.content}`);
    }
    return lines.join("\n");
  }

  if (uri.includes("/summary")) {
    const parts = uri.split("/");
    const threadId = parts.length >= 4 ? parts[3] : "";
    const thread = store.getThread(threadId);
    if (!thread) {
      return "Thread not found.";
    }
    return String((thread as unknown as { summary?: string }).summary || "(No summary recorded for this thread.)");
  }

  if (uri.includes("/state")) {
    const parts = uri.split("/");
    const threadId = parts.length >= 4 ? parts[3] : "";
    const thread = store.getThread(threadId);
    if (!thread) {
      return "Thread not found.";
    }
    const latest = store.getMessages(threadId, 0);
    const latestSeq = latest.length > 0 ? latest[latest.length - 1].seq : 0;
    return JSON.stringify(
      {
        thread_id: thread.id,
        topic: thread.topic,
        status: thread.status,
        latest_seq: latestSeq,
        created_at: thread.created_at,
      },
      null,
      2
    );
  }

  return `Unknown resource URI: ${uri}`;
}

export function getPromptsList(): Array<{
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
}> {
  return [
    {
      name: "summarize_thread",
      description: "Instructs an agent to produce a concise summary of a thread's transcript.",
      arguments: [
        { name: "topic", description: "The thread topic.", required: true },
        { name: "transcript", description: "The full transcript text.", required: true },
      ],
    },
    {
      name: "handoff_to_agent",
      description: "Standard format for handing off a task from one agent to another.",
      arguments: [
        { name: "from_agent", description: "Name of the delegating agent.", required: true },
        { name: "to_agent", description: "Name of the receiving agent.", required: true },
        { name: "task_description", description: "What needs to be done.", required: true },
        { name: "context", description: "Relevant background or prior decisions.", required: false },
      ],
    },
  ];
}

export function getPromptResult(
  name: string,
  args: Record<string, unknown>
): {
  description: string;
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
} {
  if (name === "summarize_thread") {
    const topic = String(args.topic || "(unknown)");
    const transcript = String(args.transcript || "");
    return {
      description: "Summarize the thread transcript.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Please read the following conversation transcript for the topic "${topic}" ` +
              "and write a concise summary capturing key decisions, conclusions, and open questions.\n\n" +
              `--- TRANSCRIPT ---\n${transcript}\n--- END ---`,
          },
        },
      ],
    };
  }

  if (name === "handoff_to_agent") {
    const toAgent = String(args.to_agent || "Agent");
    const fromAgent = String(args.from_agent || "Agent");
    const taskDescription = String(args.task_description || "");
    const contextText = args.context ? `\n\nRelevant context:\n${String(args.context)}` : "";
    return {
      description: "Task handoff message.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Hi ${toAgent}, this is ${fromAgent} handing off a task to you.\n\n` +
              `**Task:** ${taskDescription}${contextText}\n\n` +
              "Please acknowledge and proceed.",
          },
        },
      ],
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
}

/**
 * Handle initialize request.
 */
export async function handleInitialize(body: JsonRpcRequest): Promise<Record<string, unknown>> {
  return {
    jsonrpc: "2.0",
    id: body.id ?? null,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      serverInfo: {
        name: "agentchatbus",
        version: BUS_VERSION,
      },
    },
  };
}

/**
 * Handle tools/list request.
 */
export async function handleToolsList(body: JsonRpcRequest): Promise<Record<string, unknown>> {
  const tools = listTools();
  return { jsonrpc: "2.0", id: body.id ?? null, result: { tools } };
}

/**
 * Handle tools/call request.
 */
export async function handleToolsCall(body: JsonRpcRequest): Promise<Record<string, unknown>> {
  const params = body.params || {};
  const name = String(params.name || "");
  const args = (params.arguments as Record<string, unknown> | undefined) || {};
  const result = await withToolCallContext({}, () => callTool(name, args));

  if (Array.isArray(result)) {
    return { jsonrpc: "2.0", id: body.id ?? null, result: { content: result } };
  }
  return {
    jsonrpc: "2.0",
    id: body.id ?? null,
    result: { content: [{ type: "text", text: JSON.stringify(result) }] },
  };
}

/**
 * Handle resources/list request.
 */
export async function handleResourcesList(body: JsonRpcRequest): Promise<Record<string, unknown>> {
  return {
    jsonrpc: "2.0",
    id: body.id ?? null,
    result: { resources: getResourcesList() },
  };
}

/**
 * Handle resources/read request.
 */
export async function handleResourcesRead(body: JsonRpcRequest): Promise<Record<string, unknown>> {
  const params = body.params || {};
  const uri = String(params.uri || "");
  const text = readResourceText(uri);
  return {
    jsonrpc: "2.0",
    id: body.id ?? null,
    result: {
      contents: [
        {
          uri,
          mimeType: uri.endsWith("/transcript") || uri.endsWith("/summary") ? "text/plain" : "application/json",
          text,
        },
      ],
    },
  };
}

/**
 * Handle prompts/list request.
 */
export async function handlePromptsList(body: JsonRpcRequest): Promise<Record<string, unknown>> {
  return {
    jsonrpc: "2.0",
    id: body.id ?? null,
    result: { prompts: getPromptsList() },
  };
}

/**
 * Handle prompts/get request.
 */
export async function handlePromptsGet(body: JsonRpcRequest): Promise<Record<string, unknown>> {
  const params = body.params || {};
  const name = String(params.name || "");
  const args = (params.arguments as Record<string, unknown> | undefined) || {};
  const prompt = getPromptResult(name, args);
  return {
    jsonrpc: "2.0",
    id: body.id ?? null,
    result: prompt,
  };
}

/**
 * Handle MCP request based on method.
 */
export async function handleMcpRequest(body: JsonRpcRequest): Promise<Record<string, unknown> | null> {
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
    case "resources/read":
      return handleResourcesRead(body);
    case "prompts/list":
      return handlePromptsList(body);
    case "prompts/get":
      return handlePromptsGet(body);
    case "notifications/initialized":
      return null;
    default:
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}
