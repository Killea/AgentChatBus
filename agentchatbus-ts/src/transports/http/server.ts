import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyReply, FastifyRequest } from "fastify";
import { callTool, listTools } from "../../adapters/mcp/tools.js";
import { getConfig } from "../../core/config/env.js";
import { MemoryStore } from "../../core/services/memoryStore.js";
import { eventBus } from "../../shared/eventBus.js";

// Allow tests to override the global memoryStore instance
export let memoryStoreInstance: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore {
  if (!memoryStoreInstance) {
    // Use environment variable for test database path
    const dbPath = process.env.AGENTCHATBUS_TEST_DB || process.env.AGENTCHATBUS_DB || "data/bus-ts.db";
    memoryStoreInstance = new MemoryStore(dbPath);
  }
  return memoryStoreInstance;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type JsonBody = Record<string, unknown>;

export function createHttpServer() {
  const fastify = Fastify({ logger: false });
  void fastify.register(multipart);

  const staticPath = join(__dirname, "../../static");
  void fastify.register(fastifyStatic, {
    root: staticPath,
    prefix: "/static/",
  });

  fastify.get("/", async (request, reply) => {
    return reply.sendFile("index.html");
  });

  fastify.get("/health", async () => ({ ok: true, service: "agentchatbus-ts" }));

  fastify.get("/events", async (_request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    reply.raw.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    const unsubscribe = eventBus.subscribe((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    reply.raw.on("close", () => {
      unsubscribe();
    });
    return reply;
  });

  fastify.get("/mcp/sse", async (_request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    reply.raw.write(`data: ${JSON.stringify({ message: "TS MCP SSE skeleton ready" })}\n\n`);
    return reply;
  });

  fastify.post("/mcp/messages/", async (_request, reply) => {
    const request = _request.body as { method?: string; params?: Record<string, unknown> } | undefined;
    if (request?.method === "tools/list") {
      return { result: listTools() };
    }
    if (request?.method === "tools/call") {
      try {
        const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        return { result: await callTool(String(params?.name || ""), params?.arguments || {}) };
      } catch (error) {
        reply.code(400);
        return { error: (error as Error).message };
      }
    }
    reply.code(501);
    return {
      error: "NOT_IMPLEMENTED",
      detail: "Only tools/list and tools/call are implemented in the initial TS compatibility shell."
    };
  });

  // REST-style MCP tool endpoints (for easier testing)
  fastify.post("/api/mcp/tool/:toolName", async (request, reply) => {
    const params = request.params as { toolName: string };
    const body = request.body as Record<string, unknown> | undefined;
    try {
      const result = await callTool(params.toolName, body || {});
      return { result };
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.get("/api/threads", async (request) => {
    const query = request.query as { include_archived?: boolean; status?: string; limit?: number; before?: string };
    let threads = memoryStoreInstance!.getThreads(Boolean(query.include_archived));
    if (query.status) {
      threads = threads.filter((thread) => thread.status === query.status);
    }
    return {
      threads,
      total: threads.length,
      has_more: false,
      next_cursor: null
    };
  });

  fastify.get("/api/threads/:threadId/messages", async (request, reply) => {
    const params = request.params as { threadId: string };
    const query = request.query as { after_seq?: number };
    const thread = memoryStoreInstance!.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return memoryStoreInstance!.getMessages(params.threadId, Number(query.after_seq || 0));
  });

  fastify.post("/api/threads/:threadId/sync-context", async (request, reply) => {
    const params = request.params as { threadId: string };
    const thread = memoryStoreInstance!.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return memoryStoreInstance!.issueSyncContext(params.threadId);
  });

  fastify.post("/api/threads", async (request, reply) => {
    const body = request.body as JsonBody;
    const topic = String(body.topic || "").trim();
    if (!topic) {
      reply.code(400);
      return { detail: "topic is required" };
    }
    const created = memoryStoreInstance!.createThread(topic, typeof body.system_prompt === "string" ? body.system_prompt : undefined);
    reply.code(201);
    return {
      id: created.thread.id,
      topic: created.thread.topic,
      status: created.thread.status,
      system_prompt: created.thread.system_prompt,
      created_at: created.thread.created_at,
      current_seq: created.sync.current_seq,
      reply_token: created.sync.reply_token,
      reply_window: created.sync.reply_window
    };
  });

  fastify.post("/api/threads/:threadId/messages", async (request, reply) => {
    const params = request.params as { threadId: string };
    const body = request.body as JsonBody;
    let expectedLastSeq = typeof body.expected_last_seq === "number" ? body.expected_last_seq : undefined;
    let replyToken = typeof body.reply_token === "string" ? body.reply_token : undefined;

    if (expectedLastSeq === undefined || !replyToken) {
      const sync = memoryStoreInstance!.issueSyncContext(params.threadId);
      expectedLastSeq = sync.current_seq;
      replyToken = sync.reply_token;
    }

    try {
      const message = memoryStoreInstance!.postMessage({
        threadId: params.threadId,
        author: String(body.author || "human"),
        content: String(body.content || ""),
        expectedLastSeq,
        replyToken,
        role: typeof body.role === "string" ? body.role : undefined,
        metadata: typeof body.metadata === "object" && body.metadata !== null ? body.metadata as Record<string, unknown> : undefined,
        replyToMsgId: typeof body.reply_to_msg_id === "string" ? body.reply_to_msg_id : undefined,
        priority: typeof body.priority === "string" ? body.priority : undefined
      });
      reply.code(201);
      return message;
    } catch (error) {
      const detail = (error as Error & { detail?: unknown }).detail;
      if (detail) {
        reply.code((detail as { error?: string }).error === "SEQ_MISMATCH" ? 409 : 400);
        return { detail };
      }
      if ((error as Error).message === "Thread not found") {
        reply.code(404);
        return { detail: "Thread not found" };
      }
      reply.code(400);
      return { detail: (error as Error).message };
    }
  });

  fastify.get("/api/agents", async () => memoryStoreInstance!.listAgents());

  fastify.get("/api/threads/:threadId/agents", async (request) => {
    const params = request.params as { threadId: string };
    return memoryStoreInstance!.getThreadAgents(params.threadId);
  });

  fastify.get("/api/agents/:agentId", async (request, reply) => {
    const params = request.params as { agentId: string };
    const agent = memoryStoreInstance!.getAgent(params.agentId);
    if (!agent) {
      reply.code(404);
      return { detail: "Agent not found" };
    }
    return agent;
  });

  fastify.put("/api/agents/:agentId", async (request, reply) => {
    const params = request.params as { agentId: string };
    const body = request.body as JsonBody;
    const agent = memoryStoreInstance!.updateAgent(params.agentId, String(body.token || ""), {
      description: typeof body.description === "string" ? body.description : undefined,
      display_name: typeof body.display_name === "string" ? body.display_name : undefined,
      capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : undefined,
      skills: Array.isArray(body.skills) ? body.skills : undefined
    });
    if (!agent) {
      reply.code(401);
      return { detail: "Invalid agent_id/token" };
    }
    return { ok: true, ...agent, agent_id: agent.id };
  });

  fastify.post("/api/agents/register", async (request, reply) => {
    try {
      const body = request.body as JsonBody;
      const ide = String(body.ide || "CLI");
      const model = String(body.model || "unknown");
      const agent = memoryStoreInstance!.registerAgent({
        ide,
        model,
        description: typeof body.description === "string" ? body.description : undefined,
        capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : undefined,
        display_name: typeof body.display_name === "string" ? body.display_name : undefined,
        skills: Array.isArray(body.skills) ? body.skills : undefined
      });
      reply.code(200);
      return {
        ok: true,
        id: agent.id,
        agent_id: agent.id,
        name: agent.name,
        display_name: agent.display_name,
        token: agent.token,
        capabilities: agent.capabilities,
        skills: agent.skills,
        emoji: (agent as any).emoji || "🤖"
      };
    } catch (err) {
      console.error("Registration error:", err);
      reply.code(500);
      return { detail: (err as Error).message };
    }
  });

  fastify.post("/api/agents/heartbeat", async (request, reply) => {
    const body = request.body as JsonBody;
    const ok = memoryStoreInstance!.heartbeatAgent(String(body.agent_id || ""), String(body.token || ""));
    if (!ok) {
      reply.code(401);
      return { detail: "Invalid agent_id/token" };
    }
    return { ok: true };
  });

  fastify.post("/api/agents/resume", async (request, reply) => {
    const body = request.body as JsonBody;
    const agent = memoryStore.resumeAgent(String(body.agent_id || ""), String(body.token || ""));
    if (!agent) {
      reply.code(401);
      return { detail: "Invalid agent_id/token" };
    }
    return {
      ok: true,
      agent_id: agent.id,
      name: agent.name,
      display_name: agent.display_name,
      is_online: agent.is_online,
      last_heartbeat: agent.last_heartbeat
    };
  });

  fastify.post("/api/agents/unregister", async (request, reply) => {
    const body = request.body as JsonBody;
    const ok = memoryStore.unregisterAgent(String(body.agent_id || ""), String(body.token || ""));
    if (!ok) {
      reply.code(401);
      return { detail: "Invalid agent_id/token" };
    }
    return { ok: true };
  });

  fastify.get("/api/logs", async (request) => {
    const query = request.query as { after?: number; limit?: number };
    return memoryStore.getLogs(Number(query.after || 0), Number(query.limit || 200));
  });

  fastify.get("/api/system/diagnostics", async () => memoryStore.getDiagnostics());

  fastify.get("/api/ide/status", async (request) => {
    const query = request.query as { instance_id?: string; session_token?: string };
    return memoryStore.getIdeStatus(query.instance_id, query.session_token);
  });

  fastify.post("/api/ide/register", async (request) => {
    const body = request.body as JsonBody;
    return memoryStore.registerIde({
      instance_id: String(body.instance_id || ""),
      ide_label: String(body.ide_label || "")
    });
  });

  fastify.post("/api/ide/heartbeat", async (request, reply) => {
    try {
      const body = request.body as JsonBody;
      return memoryStore.ideHeartbeat({
        instance_id: String(body.instance_id || ""),
        session_token: String(body.session_token || "")
      });
    } catch (error) {
      reply.code(403);
      return { detail: (error as Error).message };
    }
  });

  fastify.post("/api/ide/unregister", async (request, reply) => {
    try {
      const body = request.body as JsonBody;
      return memoryStore.ideUnregister({
        instance_id: String(body.instance_id || ""),
        session_token: String(body.session_token || "")
      });
    } catch (error) {
      reply.code(403);
      return { detail: (error as Error).message };
    }
  });

  fastify.post("/api/shutdown", async (_request, reply) => {
    reply.code(200);
    setTimeout(() => process.exit(0), 50);
    return { ok: true };
  });

  fastify.post("/api/threads/:threadId/archive", async (request, reply) => setThreadStatus(request, reply, "archived"));
  fastify.post("/api/threads/:threadId/unarchive", async (request, reply) => setThreadStatus(request, reply, "discuss"));
  fastify.post("/api/threads/:threadId/close", async (request, reply) => setThreadStatus(request, reply, "closed"));
  fastify.post("/api/threads/:threadId/state", async (request, reply) => {
    const body = request.body as JsonBody;
    return setThreadStatus(request, reply, String(body.state || "discuss") as never);
  });
  fastify.delete("/api/threads/:threadId", async (request, reply) => {
    const params = request.params as { threadId: string };
    const ok = memoryStore.deleteThread(params.threadId);
    if (!ok) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return { ok: true, deleted: params.threadId };
  });

  fastify.get("/api/messages/:messageId/reactions", async (request, reply) => {
    const params = request.params as { messageId: string };
    const message = memoryStore.getMessage(params.messageId);
    if (!message) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    return { reactions: memoryStore.getReactions(params.messageId) };
  });

  fastify.post("/api/messages/:messageId/reactions", async (request, reply) => {
    const params = request.params as { messageId: string };
    const body = request.body as JsonBody;
    const message = memoryStore.addReaction(params.messageId, String(body.agent_id || ""), String(body.reaction || ""));
    if (!message) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    reply.code(201);
    return { ok: true, reactions: memoryStore.getReactions(params.messageId) };
  });

  fastify.delete("/api/messages/:messageId/reactions/:reaction", async (request, reply) => {
    const params = request.params as { messageId: string; reaction: string };
    const query = request.query as { agent_id?: string };
    const result = memoryStore.removeReaction(params.messageId, String(query.agent_id || ""), params.reaction);
    if (!result) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    return { removed: result.removed };
  });

  fastify.put("/api/messages/:messageId", async (request, reply) => {
    const params = request.params as { messageId: string };
    const body = request.body as JsonBody;
    const result = memoryStore.editMessage(params.messageId, String(body.new_content || ""), String(body.edited_by || "system"));
    if (!result) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    return result;
  });

  fastify.get("/api/messages/:messageId/history", async (request, reply) => {
    const params = request.params as { messageId: string };
    const message = memoryStore.getMessage(params.messageId);
    if (!message) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    return { edits: memoryStore.getMessageHistory(params.messageId) };
  });

  fastify.get("/api/settings", async () => memoryStore.getSettings());
  fastify.put("/api/settings", async () => ({ ok: true }));

  fastify.get("/api/templates", async () => ({ templates: memoryStore.getTemplates() }));
  fastify.get("/api/templates/:templateId", async (_request, reply) => {
    reply.code(404);
    return { detail: "Template not found" };
  });
  fastify.post("/api/templates", async (request, reply) => {
    reply.code(201);
    return request.body || {};
  });
  fastify.delete("/api/templates/:templateId", async (_request, reply) => {
    reply.code(204);
    return reply.send();
  });

  fastify.get("/api/threads/:threadId/settings", async (request, reply) => {
    const params = request.params as { threadId: string };
    const settings = memoryStoreInstance!.getThreadSettings(params.threadId);
    if (!settings) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return settings;
  });

  fastify.post("/api/threads/:threadId/settings", async (request, reply) => {
    const params = request.params as { threadId: string };
    const body = request.body as JsonBody;
    const settings = memoryStore.updateThreadSettings(params.threadId, {
      auto_administrator_enabled: typeof body.auto_administrator_enabled === "boolean" ? body.auto_administrator_enabled : undefined,
      timeout_seconds: typeof body.timeout_seconds === "number" ? body.timeout_seconds : undefined,
      switch_timeout_seconds: typeof body.switch_timeout_seconds === "number" ? body.switch_timeout_seconds : undefined
    });
    if (!settings) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return settings;
  });

  fastify.get("/api/threads/:threadId/admin", async (request, reply) => {
    const params = request.params as { threadId: string };
    const thread = memoryStoreInstance!.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return { thread_id: thread.id, admin_agent_id: null, auto_administrator_enabled: true };
  });

  fastify.post("/api/threads/:threadId/admin/decision", async (request, reply) => {
    const params = request.params as { threadId: string };
    const thread = memoryStoreInstance!.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return { ok: true, thread_id: params.threadId, decision: request.body || null };
  });

  fastify.get("/api/threads/:threadId/export", async (request, reply) => {
    const params = request.params as { threadId: string };
    const thread = memoryStoreInstance!.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return {
      thread,
      messages: memoryStoreInstance!.getMessages(params.threadId, 0)
    };
  });

  fastify.get("/api/search", async (request) => {
    const query = request.query as { q?: string; query?: string };
    const q = String(query.q || query.query || "");
    return { results: memoryStore.searchMessages(q) };
  });

  fastify.get("/api/metrics", async () => memoryStore.getMetrics());

  fastify.get("/api/debug/sse-status", async () => ({
    subscribers: eventBus.listenerCount()
  }));

  fastify.post("/api/agents/:agentId/kick", async (request, reply) => {
    const params = request.params as { agentId: string };
    const result = memoryStore.kickAgent(params.agentId);
    if (!result.ok) {
      reply.code(404);
      return { detail: "Agent not found" };
    }
    return result;
  });

  fastify.post("/api/upload/image", async (request, reply) => {
    const file = await request.file();
    if (!file) {
      reply.code(400);
      return { detail: "file is required" };
    }
    const buffer = await file.toBuffer();
    const url = `data:${file.mimetype};base64,${buffer.toString("base64")}`;
    return {
      url,
      name: file.filename
    };
  });

  return fastify;
}

async function setThreadStatus(request: FastifyRequest, reply: FastifyReply, status: string) {
  const params = request.params as { threadId: string };
  const ok = memoryStore.setThreadStatus(params.threadId, status as never);
  if (!ok) {
    reply.code(404);
    return { detail: "Thread not found" };
  }
  return { ok: true };
}

export async function startHttpServer() {
  const config = getConfig();
  const server = createHttpServer();
  await server.listen({ host: config.host, port: config.port });
  return server;
}