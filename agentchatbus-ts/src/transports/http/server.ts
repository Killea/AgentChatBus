import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { callTool, listTools, withToolCallContext } from "../../adapters/mcp/tools.js";
import { SeqMismatchError, MissingSyncFieldsError, ReplyTokenInvalidError, ReplyTokenExpiredError, ReplyTokenReplayError, BusError } from "../../core/types/errors.js";
import {
  BUS_VERSION,
  ConfigValidationError,
  getConfig,
  getConfigDict,
  getSettingsManifest,
  isIpAllowed,
  saveConfigDict,
} from "../../core/config/env.js";
import { CliSessionManager } from "../../core/services/cliSessionManager.js";
import { MemoryStore, memoryStore } from "../../core/services/memoryStore.js";
import { registerStore } from "../../core/services/storeSingleton.js";
import { eventBus } from "../../shared/eventBus.js";
import { handleMcpRequest } from "../mcp/handlers.js";
import {
  getOrCreateTransport,
  deleteTransport,
  registerLegacySseTransport,
  connectLegacySseTransport,
  getLegacySseTransport,
} from "../mcp/streamableHttp.js";

// Allow tests to override the global memoryStore instance
export let memoryStoreInstance: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore {
  return memoryStoreInstance || memoryStore;
}

type JsonBody = Record<string, unknown>;

function resolveStaticPath(): string {
  const envStaticPath = getConfig().webUiDir;
  const candidates = [
    envStaticPath,
    join(process.cwd(), "resources", "web-ui"),
    join(process.cwd(), "web-ui"),
    join(process.cwd(), "..", "web-ui"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return candidates[0] ?? join(process.cwd(), "web-ui");
}

function resolvePackageRoot(packageName: string): string | null {
  const segments = packageName.split("/");
  const candidates = [
    join(process.cwd(), "resources", "bundled-server", "node_modules", ...segments),
    join(process.cwd(), "node_modules", ...segments),
    join(process.cwd(), "..", "node_modules", ...segments),
    join(process.cwd(), "..", "..", "node_modules", ...segments),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isLoopbackRequest(request: FastifyRequest): boolean {
  const ip = request.ip || request.socket.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost";
}

export function createHttpServer() {
  const fastify = Fastify({ logger: false });
  // If AGENTCHATBUS_DB env is set for this process, create a dedicated store
  // instance so in-process tests can control the DB path and teardown.
  let store: ReturnType<typeof getMemoryStore>;
  // Allow tests to override the DB path using AGENTCHATBUS_TEST_DB
  const cfg = getConfig();
  const envDb = cfg.testDbPath || (cfg.dbPathConfigured ? cfg.dbPath : null);
  // Track ownership: only close the store on shutdown if this server created it.
  const ownsStore = Boolean(envDb);
  if (envDb) {
    try {
      // Lazily create an instance bound to this DB path.
      memoryStoreInstance = new MemoryStore(envDb);
      // Ensure MCP tools and other modules use the same store instance
      try { registerStore(memoryStoreInstance); } catch (_) { }
      store = memoryStoreInstance;
    } catch (e) {
      // Fallback to global store on error
      store = getMemoryStore();
    }
  } else {
    store = getMemoryStore();
  }
  const cliSessionManager = new CliSessionManager();

  const adminDecisionBySource = new Map<string, {
    action: string;
    new_admin_id?: string;
    notified_admin_id?: string;
  }>();

  function requireAuthorizedAgent(
    request: FastifyRequest,
    reply: FastifyReply,
    body: JsonBody,
    fieldName: string,
  ): string | null {
    const rawAgentId = typeof body[fieldName] === "string" ? body[fieldName] : "";
    const agentId = rawAgentId.trim();
    if (!agentId) {
      reply.code(400);
      void reply.send({ detail: `${fieldName} is required` });
      return null;
    }

    const token = String(request.headers["x-agent-token"] || "");
    if (!token) {
      reply.code(401);
      void reply.send({ detail: "X-Agent-Token header required" });
      return null;
    }
    if (!store.verifyAgentToken(agentId, token)) {
      reply.code(401);
      void reply.send({ detail: "Invalid agent_id/token" });
      return null;
    }
    return agentId;
  }

  void fastify.register(multipart);

  const staticPath = resolveStaticPath();
  void fastify.register(fastifyStatic, {
    root: staticPath,
    prefix: "/static/",
  });
  const xtermRoot = resolvePackageRoot("@xterm/xterm");
  if (xtermRoot) {
    void fastify.register(fastifyStatic, {
      root: xtermRoot,
      prefix: "/static/vendor/xterm/",
      decorateReply: false,
    });
  }
  const xtermFitRoot = resolvePackageRoot("@xterm/addon-fit");
  if (xtermFitRoot) {
    void fastify.register(fastifyStatic, {
      root: xtermFitRoot,
      prefix: "/static/vendor/xterm-addon-fit/",
      decorateReply: false,
    });
  }

  // ── SEC-05: Security middleware ──────────────────────────────────────────────
  // Config is read per-request (not captured at server creation time) to avoid
  // test isolation issues and support dynamic reconfiguration.

  // Patterns of URL prefixes/exact routes that are agent-auth-gated (exempt from SHOW_AD guard)
  const SHOW_AD_AGENT_AUTH_EXEMPT_PREFIXES = [
    "/api/agents/register",
    "/api/agents/heartbeat",
    "/api/agents/resume",
    "/api/agents/unregister",
  ];
  const SHOW_AD_AGENT_AUTH_EXEMPT_EXACT: Array<{ method: string; pattern: RegExp }> = [
    { method: "POST", pattern: /^\/api\/threads$/ },
    { method: "POST", pattern: /^\/api\/threads\/[^/]+\/messages$/ },
  ];

  fastify.addHook("onRequest", async (request, reply) => {
    // Re-read config on each request for test isolation and dynamic support
    const cfg = getConfig();

    // Layer 1: IP allowlist — enforced when AGENTCHATBUS_ALLOWED_HOSTS is set.
    // Loopback addresses always bypass the allowlist.
    if (cfg.allowedHosts.length > 0 && !isLoopbackRequest(request)) {
      const ip = request.ip || request.socket.remoteAddress || "";
      if (!isIpAllowed(ip, cfg.allowedHosts)) {
        reply.code(403);
        await reply.send({ detail: "Forbidden: source IP not in AGENTCHATBUS_ALLOWED_HOSTS" });
        return;
      }
    }

    // Layer 2: SHOW_AD write guard — when SHOW_AD=true, protect all write endpoints
    // that are not already gated by X-Agent-Token.
    if (cfg.showAd) {
      // Allow all GET requests (read-only)
      if (request.method === "GET") return;
      // Allow OPTIONS/HEAD
      if (request.method === "OPTIONS" || request.method === "HEAD") return;
      // Allow loopback — admin can always manage from localhost
      if (isLoopbackRequest(request)) return;

      const url = request.url.split("?")[0];

      // Allow agent-auth-gated endpoints
      if (SHOW_AD_AGENT_AUTH_EXEMPT_PREFIXES.some(p => url === p || url.startsWith(p + "/"))) return;
      for (const { method, pattern } of SHOW_AD_AGENT_AUTH_EXEMPT_EXACT) {
        if (request.method === method && pattern.test(url)) return;
      }

      // All other write/delete endpoints require X-Admin-Token
      const adminToken = request.headers["x-admin-token"] as string | undefined;
      if (!cfg.adminToken || adminToken !== cfg.adminToken) {
        reply.code(401);
        await reply.send({ detail: "Unauthorized: X-Admin-Token required in SHOW_AD mode" });
      }
    }
  });

  // ── End SEC-05 ───────────────────────────────────────────────────────────────

  fastify.get("/", async (request, reply) => {
    return reply.sendFile("index.html");
  });

  fastify.get("/health", async () => {
    const ideStatus = store.getIdeStatus();
    const cfg = getConfig();
    const startupMode = cfg.ownerBootToken
      ? "bundled-ts-service"
      : (ideStatus.ownership_assignable === true
        ? "external-service-extension-managed"
        : (ideStatus.ownership_assignable === false
          ? "external-service-manual"
          : "external-service-unknown"));
    return {
      status: "ok",
      service: "AgentChatBus",
      engine: "node",
      version: BUS_VERSION,
      runtime: `node ${process.version}`,
      transport: "http+sse",
      startup_mode: startupMode,
      // TS-only diagnostics enhancement:
      // Python backend may omit this shape. Web clients should treat it as optional.
      // This reports the currently effective msg_wait minimum-wait policy.
      wait_policy: {
        msg_wait_min_timeout_ms: Math.max(0, Number(cfg.msgWaitMinTimeoutMs || 0)),
        enforce_min_timeout: Boolean(cfg.enforceMsgWaitMinTimeout),
        behavior: cfg.enforceMsgWaitMinTimeout
          ? "reject_below_min_non_quick_return"
          : "clamp_below_min_non_quick_return",
      },
      management: {
        ownership_assignable: Boolean(ideStatus.ownership_assignable),
        owner_instance_id: ideStatus.owner_instance_id ?? null,
        registered_sessions_count: ideStatus.registered_sessions_count ?? 0,
      },
    };
  });

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

  async function handleStreamableHttpRequest(request: FastifyRequest, reply: FastifyReply) {
    // Get session ID from header (MCP SDK uses 'mcp-session-id')
    const headerSessionId = request.headers["mcp-session-id"] as string | undefined;

    console.log(`[MCP] ${request.method} request: session=${headerSessionId?.slice(0, 8) || "new"}`);

    try {
      // Get or create transport (async - waits for server to be ready)
      const { transport, sessionId, isNew } = await getOrCreateTransport(headerSessionId);

      // Set session ID header in response
      if (isNew) {
        reply.header("mcp-session-id", sessionId);
      }

      // Use native Node.js request/response objects for StreamableHTTPServerTransport
      await transport.handleRequest(request.raw, reply.raw, request.body);

      return reply;
    } catch (error: any) {
      console.error(`[MCP] ${request.method} Error: ${error.message}`);
      reply.code(500);
      return { error: error.message };
    }
  }

  // POST /mcp - Streamable HTTP endpoint (preferred modern MCP endpoint)
  fastify.post("/mcp", handleStreamableHttpRequest);

  // GET /mcp - SSE stream for the modern Streamable HTTP transport
  fastify.get("/mcp", async (request, reply) => {
    const headerSessionId = request.headers["mcp-session-id"] as string | undefined;

    try {
      if (!headerSessionId) {
        reply.code(400);
        return { error: "Missing mcp-session-id header" };
      }

      const { transport } = await getOrCreateTransport(headerSessionId);
      await transport.handleRequest(request.raw, reply.raw);

      return reply;
    } catch (error: any) {
      console.error(`[MCP] GET Error: ${error.message}`);
      reply.code(500);
      return { error: error.message };
    }
  });

  // DELETE /mcp - Close modern Streamable HTTP session
  fastify.delete("/mcp", async (request, reply) => {
    const headerSessionId = request.headers["mcp-session-id"] as string | undefined;

    if (headerSessionId) {
      deleteTransport(headerSessionId);
      console.log(`[MCP] DELETE session: ${headerSessionId.slice(0, 8)}`);
    }

    reply.code(204);
    return reply;
  });

  // Keep /mcp/sse as an alias for existing configs already shipped to users.
  fastify.post("/mcp/sse", handleStreamableHttpRequest);
  fastify.get("/mcp/sse", async (request, reply) => {
    const headerSessionId = request.headers["mcp-session-id"] as string | undefined;
    if (!headerSessionId) {
      reply.code(400);
      return { error: "Missing mcp-session-id header" };
    }
    try {
      const { transport } = await getOrCreateTransport(headerSessionId);
      await transport.handleRequest(request.raw, reply.raw);
      return reply;
    } catch (error: any) {
      console.error(`[MCP-ALIAS] GET Error: ${error.message}`);
      reply.code(500);
      return { error: error.message };
    }
  });
  fastify.delete("/mcp/sse", async (request, reply) => {
    const headerSessionId = request.headers["mcp-session-id"] as string | undefined;
    if (headerSessionId) {
      deleteTransport(headerSessionId);
    }
    reply.code(204);
    return reply;
  });

  // Deprecated HTTP+SSE transport for clients that still fall back to the old protocol.
  fastify.get("/sse", async (_request, reply) => {
    try {
      const transport = new SSEServerTransport("/messages", reply.raw);
      registerLegacySseTransport(transport);
      await connectLegacySseTransport(transport);
      return reply;
    } catch (error: any) {
      console.error(`[MCP-SSE-LEGACY] GET Error: ${error.message}`);
      if (!reply.sent) {
        reply.code(500);
        return { error: error.message };
      }
      return reply;
    }
  });

  const handleLegacySsePost = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { sessionId?: string };
    // Accept both sessionId and session_id for wider legacy compatibility.
    const fallbackQuery = request.query as { session_id?: string };
    const sessionId =
      (typeof query.sessionId === "string" ? query.sessionId : "") ||
      (typeof fallbackQuery.session_id === "string" ? fallbackQuery.session_id : "");
    if (!sessionId) {
      reply.code(400);
      return { error: "Missing sessionId parameter" };
    }

    const transport = getLegacySseTransport(sessionId);
    if (!transport) {
      reply.code(404);
      return { error: "Session not found" };
    }

    try {
      await transport.handlePostMessage(request.raw, reply.raw, request.body);
      return reply;
    } catch (error: any) {
      console.error(`[MCP-SSE-LEGACY] POST Error: ${error.message}`);
      if (!reply.sent) {
        reply.code(500);
        return { error: error.message };
      }
      return reply;
    }
  };

  fastify.post("/messages", handleLegacySsePost);
  fastify.post("/messages/", handleLegacySsePost);

  // Legacy endpoint for backwards compatibility
  // Supports the full MCP method set used by Python server parity.
  const handleLegacyMcpMessages = async (_request: FastifyRequest, reply: FastifyReply) => {
    const request = _request.body as
      | { id?: string | number | null; method?: string; params?: Record<string, unknown> }
      | undefined;
    if (!request?.method) {
      reply.code(400);
      return { error: "INVALID_REQUEST", detail: "method is required" };
    }

    // Keep legacy response shape for existing tools/list and tools/call tests.
    if (request.method === "tools/list") {
      return { result: listTools() };
    }
    if (request.method === "tools/call") {
      try {
        const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        const sessionId =
          typeof _request.headers["mcp-session-id"] === "string"
            ? _request.headers["mcp-session-id"]
            : "legacy-mcp";
        const result = await withToolCallContext({ sessionId }, () =>
          callTool(String(params?.name || ""), params?.arguments || {})
        );
        try { console.log(`[mcp-call] ${String(params?.name || "")} => ${JSON.stringify(result).slice(0, 200)}`); } catch (_) {}
        return { result };
      } catch (error) {
        try { console.error(`[mcp-call-error] ${String((error as Error).message || error)}`); } catch (_) {}
        reply.code(400);
        return { error: (error as Error).message };
      }
    }

    // For other MCP methods, run through unified MCP handler and expose result payload.
    const rpc = await handleMcpRequest({
      id: request.id ?? null,
      method: request.method,
      params: request.params || {},
    });

    if (rpc === null) {
      reply.code(204);
      return reply.send();
    }
    if ("error" in rpc) {
      reply.code(400);
      return { error: (rpc as { error: { message?: string } }).error?.message || "MCP_ERROR", detail: rpc };
    }
    return { result: (rpc as { result?: unknown }).result };
  };

  fastify.post("/mcp/messages/", handleLegacyMcpMessages);
  fastify.post("/mcp/messages", handleLegacyMcpMessages);

  // REST-style MCP tool endpoints (for easier testing)
  fastify.post("/api/mcp/tool/:toolName", async (request, reply) => {
    const params = request.params as { toolName: string };
    const body = request.body as Record<string, unknown> | undefined;
    try {
      const sessionId =
        typeof request.headers["mcp-session-id"] === "string"
          ? request.headers["mcp-session-id"]
          : "api-mcp-tool";
      const result = await withToolCallContext({ sessionId }, () =>
        callTool(params.toolName, body || {})
      );
      // All tools should return a blocks-style MCP payload for consistency
      try {
        // If the tool already returned a blocks-style array, forward it unchanged
        if (Array.isArray(result)) {
          return result as unknown;
        }
        // Ensure a consistent blocks-style response expected by parity tests
        // Use a safe stringify that tolerates functions and circular refs
        const safeStringify = (obj: unknown) => {
          const seen = new Set();
          return JSON.stringify(obj, (_key, value) => {
            if (typeof value === 'function') return undefined;
            if (typeof value === 'object' && value !== null) {
              if (seen.has(value)) return undefined;
              seen.add(value);
            }
            return value;
          });
        };
        // Always produce a string payload; if stringify returns falsy, fall back to '{}'
        let payloadText = safeStringify(result) || "{}";
        // debug log to help parity tests diagnose response shape in subprocesses
        try { console.log(`[mcp-rest] ${params.toolName} -> ${String(payloadText).slice(0,200)}`); } catch (e) { }
        try {
          // write a copy for debugging when running in a child process
          writeFileSync("tmp_last_mcp_response.json", String(payloadText), { encoding: "utf8" });
        } catch (e) {}
        // Always return a blocks-style array with a text block containing the JSON payload
        return [ { type: "text", text: payloadText } ];
      } catch (e) {
        // If anything unexpected happens here, return a minimal safe text block
        return [ { type: "text", text: "{}" } ];
      }
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.get("/api/threads", async (request) => {
    const query = request.query as { include_archived?: boolean; status?: string; limit?: number; before?: string };
    let threads = store.getThreads(Boolean(query.include_archived));
    if (query.status) {
      threads = threads.filter((thread) => thread.status === query.status);
    }
    
    // Add waiting_agents for each thread (match Python main.py L990-1002)
    const threadsWithWaitingAgents = threads.map(thread => {
      const waitingAgents = store.getWaitingAgentsForThread(thread.id);
      return {
        ...thread,
        waiting_agents: waitingAgents.map(agent => ({
          id: agent.id,
          display_name: agent.display_name || agent.name,
          emoji: agent.emoji || "🤖"
        }))
      };
    });
    
    return {
      threads: threadsWithWaitingAgents,
      total: threads.length,
      has_more: false,
      next_cursor: null
    };
  });

  fastify.get("/api/threads/:threadId/messages", async (request, reply) => {
    const params = request.params as { threadId: string };
    const query = request.query as {
      after_seq?: number | string;
      limit?: number | string;
      include_system_prompt?: boolean | string | number;
      priority?: string;
    };
    const thread = store.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    const afterSeq = Number(query.after_seq || 0);
    const limit = Math.min(Math.max(1, Number(query.limit || 200) || 200), 1000);
    const includeSystemPrompt =
      query.include_system_prompt === true
      || query.include_system_prompt === 1
      || query.include_system_prompt === "1"
      || query.include_system_prompt === "true";
    const priority = typeof query.priority === "string" ? query.priority : undefined;
    if (priority && !["normal", "urgent", "system"].includes(priority)) {
      reply.code(400);
      return { detail: `Invalid priority filter '${priority}'` };
    }
    return store.getMessages(params.threadId, afterSeq, includeSystemPrompt, priority).slice(0, limit);
  });

  fastify.get("/api/threads/:threadId/cli-sessions", async (request, reply) => {
    const params = request.params as { threadId: string };
    const thread = store.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return {
      sessions: cliSessionManager.listSessionsForThread(params.threadId),
    };
  });

  fastify.post("/api/threads/:threadId/sync-context", async (request, reply) => {
    const params = request.params as { threadId: string };
    const thread = store.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return store.issueSyncContext(params.threadId);
  });

  fastify.post("/api/threads/:threadId/cli-sessions", async (request, reply) => {
    const params = request.params as { threadId: string };
    const body = request.body as JsonBody;
    const thread = store.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }

    const requestedByAgentId = requireAuthorizedAgent(request, reply, body, "requested_by_agent_id");
    if (!requestedByAgentId) {
      return reply;
    }

    try {
      const session = cliSessionManager.createSession({
        threadId: params.threadId,
        adapter: String(body.adapter || "cursor").trim() as "cursor" | "codex",
        mode: String(body.mode || "headless").trim() as "headless" | "interactive",
        prompt: String(body.prompt || ""),
        workspace: typeof body.workspace === "string" ? body.workspace : undefined,
        requestedByAgentId,
        cols: body.cols === undefined ? undefined : Number(body.cols),
        rows: body.rows === undefined ? undefined : Number(body.rows),
      });
      reply.code(201);
      return { session };
    } catch (error) {
      reply.code(400);
      return { detail: error instanceof Error ? error.message : String(error) };
    }
  });

  fastify.post("/api/threads", async (request, reply) => {
    const body = request.body as JsonBody;
    const topic = String(body.topic || "").trim();
    if (!topic) {
      reply.code(400);
      return { detail: "topic is required" };
    }

    const creatorAgentIdRaw = typeof body.creator_agent_id === "string" ? body.creator_agent_id : "";
    const creatorAgentId = creatorAgentIdRaw.trim();
    if (!creatorAgentId) {
      reply.code(400);
      return { detail: "creator_agent_id is required" };
    }

    const token = String(request.headers["x-agent-token"] || "");
    if (!token) {
      reply.code(401);
      return { detail: "X-Agent-Token header required to create thread as a registered agent" };
    }
    if (!store.verifyAgentToken(creatorAgentId, token)) {
      reply.code(401);
      return { detail: "Invalid agent_id/token" };
    }

    const creator = store.getAgent(creatorAgentId);
    if (!creator) {
      reply.code(401);
      return { detail: "Invalid agent_id/token" };
    }

    const created = store.createThread(
      topic,
      typeof body.system_prompt === "string" ? body.system_prompt : undefined,
      undefined,
      {
        creatorAdminId: creatorAgentId,
        creatorAdminName: creator.display_name || creator.name || creatorAgentId,
        applySystemPromptContentFilter: true
      }
    );

    reply.code(201);
    return {
      id: created.thread.id,
      topic: created.thread.topic,
      status: created.thread.status,
      system_prompt: created.thread.system_prompt,
      created_at: created.thread.created_at,
      updated_at: created.thread.updated_at,
      current_seq: created.sync.current_seq,
      reply_token: created.sync.reply_token,
      reply_window: created.sync.reply_window
    };
  });

  fastify.post("/api/threads/:threadId/messages", async (request, reply) => {
    const params = request.params as { threadId: string };
    const body = request.body as JsonBody;
    const author = String(body.author || "human");
    const role = (typeof body.role === "string" ? body.role : "user") as any;

    if (role === "system" && (author === "human" || author === "")) {
      reply.code(400);
      return { detail: "role 'system' is not allowed for human messages" };
    }

    let expectedLastSeq = typeof body.expected_last_seq === "number" ? body.expected_last_seq : undefined;
    let replyToken = typeof body.reply_token === "string" ? body.reply_token : undefined;

    if (expectedLastSeq === undefined || !replyToken) {
      const sync = store.issueSyncContext(params.threadId);
      expectedLastSeq = sync.current_seq;
      replyToken = sync.reply_token;
    }

    const msgMetadata = (typeof body.metadata === "object" && body.metadata !== null)
      ? { ...(body.metadata as Record<string, unknown>) }
      : {};
    if (Array.isArray(body.mentions)) {
      msgMetadata.mentions = body.mentions;
    }
    if (Array.isArray(body.images)) {
      msgMetadata.images = body.images;
    }

    try {
      const message = store.postMessage({
        threadId: params.threadId,
        author,
        content: String(body.content || ""),
        expectedLastSeq,
        replyToken,
        role,
        metadata: Object.keys(msgMetadata).length > 0 ? msgMetadata : undefined,
        replyToMsgId: typeof body.reply_to_msg_id === "string" ? body.reply_to_msg_id : undefined,
        priority: (typeof body.priority === "string" ? body.priority : "normal") as any
      });

      reply.code(201);
      return {
        id: message.id,
        seq: message.seq,
        author: message.author,
        author_id: message.author_id,
        author_name: message.author_name,
        author_emoji: message.author_emoji || "🤖",
        role: message.role,
        content: message.content,
        created_at: message.created_at,
        metadata: message.metadata,
        reply_to_msg_id: message.reply_to_msg_id,
        priority: message.priority
      };
    } catch (error) {
      // Prefer structured BusError handling
      if (error instanceof SeqMismatchError || (error as any)?.detail?.error === 'SEQ_MISMATCH') {
        reply.code(409);
        const err = error as SeqMismatchError | any;
        return { 
          error: 'SEQ_MISMATCH',
          current_seq: err.current_seq,
          expected_last_seq: err.expected_last_seq,
          new_messages_1st_read: err.new_messages,
          action: 'READ_MESSAGES_THEN_CALL_MSG_WAIT'
        };
      }
      if (error instanceof ReplyTokenReplayError || (error as any)?.detail?.error === 'TOKEN_REPLAY') {
        // Tests expect TOKEN_REPLAY to surface as a 400 with detail.error = 'TOKEN_REPLAY'
        reply.code(400);
        return { detail: (error as any).detail || { error: 'TOKEN_REPLAY' } };
      }
      if (error instanceof MissingSyncFieldsError) {
        reply.code(400);
        return { detail: (error as any).detail || { error: 'MISSING_SYNC_FIELDS' } };
      }
      if (error instanceof ReplyTokenInvalidError || error instanceof ReplyTokenExpiredError) {
        reply.code(400);
        return { detail: (error as any).detail || { error: 'TOKEN_INVALID' } };
      }
      if ((error as Error).message === "Thread not found") {
        reply.code(404);
        return { detail: "Thread not found" };
      }
      // Fallback: if it's a BusError with detail, surface it
      if ((error as any)?.detail) {
        reply.code(400);
        return { detail: (error as any).detail };
      }
      reply.code(400);
      return { detail: (error as Error).message };
    }
  });

  fastify.get("/api/agents", async () => store.listAgents());

  fastify.get("/api/cli-sessions/:sessionId", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const session = cliSessionManager.getSession(params.sessionId);
    if (!session) {
      reply.code(404);
      return { detail: "CLI session not found" };
    }
    return { session };
  });

  fastify.get("/api/cli-sessions/:sessionId/output", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const query = request.query as { after?: number | string; limit?: number | string };
    const output = cliSessionManager.getSessionOutput(
      params.sessionId,
      Number(query.after || 0),
      Number(query.limit || 200),
    );
    if (!output) {
      reply.code(404);
      return { detail: "CLI session not found" };
    }
    return output;
  });

  fastify.post("/api/cli-sessions/:sessionId/restart", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const body = request.body as JsonBody;
    const agentId = requireAuthorizedAgent(request, reply, body, "requested_by_agent_id");
    if (!agentId) {
      return reply;
    }
    try {
      const session = await cliSessionManager.restartSession(params.sessionId);
      if (!session) {
        reply.code(404);
        return { detail: "CLI session not found" };
      }
      return { session, requested_by_agent_id: agentId };
    } catch (error) {
      reply.code(400);
      return { detail: error instanceof Error ? error.message : String(error) };
    }
  });

  fastify.post("/api/cli-sessions/:sessionId/stop", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const body = request.body as JsonBody;
    const agentId = requireAuthorizedAgent(request, reply, body, "requested_by_agent_id");
    if (!agentId) {
      return reply;
    }
    const session = await cliSessionManager.stopSession(params.sessionId);
    if (!session) {
      reply.code(404);
      return { detail: "CLI session not found" };
    }
    return { session, requested_by_agent_id: agentId };
  });

  fastify.post("/api/cli-sessions/:sessionId/input", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const body = request.body as JsonBody;
    const agentId = requireAuthorizedAgent(request, reply, body, "requested_by_agent_id");
    if (!agentId) {
      return reply;
    }
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.length) {
      reply.code(400);
      return { detail: "text is required" };
    }
    const result = await cliSessionManager.sendInput(params.sessionId, text);
    if (!result) {
      reply.code(404);
      return { detail: "CLI session not found" };
    }
    reply.code(result.ok ? 200 : 400);
    return { ...result, requested_by_agent_id: agentId };
  });

  fastify.post("/api/cli-sessions/:sessionId/resize", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const body = request.body as JsonBody;
    const agentId = requireAuthorizedAgent(request, reply, body, "requested_by_agent_id");
    if (!agentId) {
      return reply;
    }
    const cols = Number(body.cols);
    const rows = Number(body.rows);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      reply.code(400);
      return { detail: "cols and rows are required" };
    }
    const result = await cliSessionManager.resizeSession(params.sessionId, cols, rows);
    if (!result) {
      reply.code(404);
      return { detail: "CLI session not found" };
    }
    reply.code(result.ok ? 200 : 400);
    return { ...result, requested_by_agent_id: agentId };
  });

  fastify.get("/api/threads/:threadId/agents", async (request) => {
    const params = request.params as { threadId: string };
    return store.getThreadAgents(params.threadId);
  });

  fastify.get("/api/agents/:agentId", async (request, reply) => {
    const params = request.params as { agentId: string };
    const agent = store.getAgent(params.agentId);
    if (!agent) {
      reply.code(404);
      return { detail: "Agent not found" };
    }
    return agent;
  });

  fastify.put("/api/agents/:agentId", async (request, reply) => {
    const params = request.params as { agentId: string };
    const body = request.body as JsonBody;
    const { validateEmoji } = await import("../../main.js");
    const validatedEmoji = typeof body.emoji === "string" ? validateEmoji(body.emoji) : undefined;
    const agent = store.updateAgent(params.agentId, String(body.token || ""), {
      description: typeof body.description === "string" ? body.description : undefined,
      display_name: typeof body.display_name === "string" ? body.display_name : undefined,
      capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : undefined,
      skills: Array.isArray(body.skills) ? body.skills : undefined,
      emoji: validatedEmoji !== undefined ? (validatedEmoji || undefined) : undefined
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
      const { validateEmoji } = await import("../../main.js");
      const validatedEmoji = typeof body.emoji === "string" ? validateEmoji(body.emoji) : null;
      const agent = store.registerAgent({
        ide,
        model,
        description: typeof body.description === "string" ? body.description : undefined,
        capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : undefined,
        display_name: typeof body.display_name === "string" ? body.display_name : undefined,
        skills: Array.isArray(body.skills) ? body.skills : undefined,
        emoji: validatedEmoji || undefined
      });
      reply.code(200);
      const cfg = getConfig();
      const isShowAd = cfg.showAd;
      return {
        ok: true,
        id: agent.id,
        agent_id: agent.id,
        name: agent.name,
        display_name: agent.display_name,
        // SEC-05: Suppress token in public demo mode (SHOW_AD=true) to prevent token leakage.
        // Private deployments (localhost or non-SHOW_AD) still receive the token for agent auth.
        ...(cfg.showAd ? {} : { token: agent.token }),
        capabilities: agent.capabilities,
        skills: agent.skills,
        emoji: (agent as any).emoji || "🤖",
        ...(isShowAd ? { restricted_mode: true, restrictions: ["no_filesystem_disclosure"] } : {})
      };
    } catch (err) {
      console.error("Registration error:", err);
      reply.code(500);
      return { detail: (err as Error).message };
    }
  });

  fastify.post("/api/agents/heartbeat", async (request, reply) => {
    const body = request.body as JsonBody;
    const ok = store.heartbeatAgent(String(body.agent_id || ""), String(body.token || ""));
    if (!ok) {
      reply.code(401);
      return { detail: "Invalid agent_id/token" };
    }
    return { ok: true };
  });

  fastify.post("/api/agents/resume", async (request, reply) => {
    const body = request.body as JsonBody;
    const agent = store.resumeAgent(String(body.agent_id || ""), String(body.token || ""));
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
    const ok = store.unregisterAgent(String(body.agent_id || ""), String(body.token || ""));
    if (!ok) {
      reply.code(401);
      return { detail: "Invalid agent_id/token" };
    }
    return { ok: true };
  });

  fastify.get("/api/logs", async (request) => {
    const query = request.query as { after?: number; limit?: number };
    return store.getLogs(Number(query.after || 0), Number(query.limit || 200));
  });

  fastify.get("/api/system/diagnostics", async () => store.getDiagnostics());

  fastify.get("/api/ide/status", async (request) => {
    const query = request.query as { instance_id?: string; session_token?: string };
    return store.getIdeStatus(query.instance_id, query.session_token);
  });

  fastify.post("/api/ide/register", async (request, reply) => {
    if (!isLoopbackRequest(request)) {
      reply.code(403);
      return { detail: "IDE registration APIs are only available from localhost" };
    }
    const body = request.body as JsonBody;
    return store.registerIde({
      instance_id: String(body.instance_id || ""),
      ide_label: String(body.ide_label || ""),
      claim_owner: Boolean(body.claim_owner),
      owner_boot_token: typeof body.owner_boot_token === "string" ? body.owner_boot_token : undefined,
    });
  });

  fastify.post("/api/ide/heartbeat", async (request, reply) => {
    if (!isLoopbackRequest(request)) {
      reply.code(403);
      return { detail: "IDE registration APIs are only available from localhost" };
    }
    try {
      const body = request.body as JsonBody;
      return store.ideHeartbeat({
        instance_id: String(body.instance_id || ""),
        session_token: String(body.session_token || "")
      });
    } catch (error) {
      reply.code(403);
      return { detail: (error as Error).message };
    }
  });

  fastify.post("/api/ide/unregister", async (request, reply) => {
    if (!isLoopbackRequest(request)) {
      reply.code(403);
      return { detail: "IDE registration APIs are only available from localhost" };
    }
    try {
      const body = request.body as JsonBody;
      const result = store.ideUnregister({
        instance_id: String(body.instance_id || ""),
        session_token: String(body.session_token || "")
      });
      if (result.shutdown_requested) {
        setTimeout(() => process.exit(0), 50);
      }
      return result;
    } catch (error) {
      reply.code(403);
      return { detail: (error as Error).message };
    }
  });

  fastify.post("/api/shutdown", async (request, reply) => {
    const body = request.body as JsonBody;
    const force = Boolean(body.force);

    if (!isLoopbackRequest(request)) {
      reply.code(403);
      return { detail: "Shutdown is only allowed from localhost" };
    }

    if (!force) {
      try {
        store.authorizeIdeShutdown({
          instance_id: String(body.instance_id || ""),
          session_token: String(body.session_token || ""),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply.code(message.includes("registered") ? 404 : 403);
        return { detail: message };
      }
    }

    reply.code(200);
    setTimeout(() => process.exit(0), 50);
    return { ok: true, force };
  });

  fastify.post("/api/threads/:threadId/archive", async (request, reply) => setThreadStatus(request, reply, "archived"));
  fastify.post("/api/threads/:threadId/unarchive", async (request, reply) => setThreadStatus(request, reply, "discuss"));
  fastify.post("/api/threads/:threadId/close", async (request, reply) => {
    const params = request.params as { threadId: string };
    const body = (request.body || {}) as JsonBody;
    const summary = typeof body.summary === "string" ? body.summary : undefined;
    const ok = store.closeThread(params.threadId, summary);
    if (!ok) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return { ok: true, thread_id: params.threadId, status: "closed" };
  });
  fastify.post("/api/threads/:threadId/state", async (request, reply) => {
    const body = request.body as JsonBody;
    return setThreadStatus(request, reply, String(body.state || "discuss") as never);
  });
  fastify.delete("/api/threads/:threadId", async (request, reply) => {
    const params = request.params as { threadId: string };
    const ok = store.deleteThread(params.threadId);
    if (!ok) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return { ok: true, deleted: params.threadId };
  });

  fastify.get("/api/messages/:messageId/reactions", async (request, reply) => {
    const params = request.params as { messageId: string };
    const message = store.getMessage(params.messageId);
    if (!message) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    return { reactions: store.getReactions(params.messageId) };
  });

  fastify.post("/api/messages/:messageId/reactions", async (request, reply) => {
    const params = request.params as { messageId: string };
    const body = request.body as JsonBody;
    const message = store.addReaction(params.messageId, String(body.agent_id || ""), String(body.reaction || ""));
    if (!message) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    reply.code(201);
    return { ok: true, reactions: store.getReactions(params.messageId) };
  });

  fastify.delete("/api/messages/:messageId/reactions/:reaction", async (request, reply) => {
    const params = request.params as { messageId: string; reaction: string };
    const query = request.query as { agent_id?: string };
    const result = store.removeReaction(params.messageId, String(query.agent_id || ""), params.reaction);
    if (!result) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    return { removed: result.removed };
  });

  fastify.put("/api/messages/:messageId", async (request, reply) => {
    const params = request.params as { messageId: string };
    const body = request.body as JsonBody;
    const result = store.editMessage(params.messageId, String(body.new_content || ""), String(body.edited_by || "system"));
    if (!result) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    return result;
  });

  fastify.get("/api/messages/:messageId/history", async (request, reply) => {
    const params = request.params as { messageId: string };
    const message = store.getMessage(params.messageId);
    if (!message) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    return { edits: store.getMessageHistory(params.messageId) };
  });

  // Settings API - Python parity
  fastify.get("/api/settings", async () => getConfigDict());

  fastify.get("/api/settings/manifest", async () => getSettingsManifest());
  
  fastify.put("/api/settings", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const adminToken = request.headers["x-admin-token"] as string | undefined;
    const cfg = getConfig();
    
    if (cfg.adminToken && adminToken !== cfg.adminToken) {
      reply.code(401);
      return { detail: "Invalid admin token" };
    }

    try {
      if (Object.keys(body).length > 0) {
        saveConfigDict(body);
      }
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        reply.code(400);
        return {
          detail: "Invalid settings payload",
          errors: error.errors,
        };
      }
      throw error;
    }
    
    return { 
      ok: true, 
      message: "Settings saved. Restart the server to apply changes." 
    };
  });

  // Templates API - Python parity
  fastify.get("/api/templates", async () => {
    const templates = store.getTemplates();
    // Python returns array directly with subset of fields
    return templates.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      is_builtin: t.is_builtin,
      created_at: t.created_at
    }));
  });

  fastify.get("/api/templates/:templateId", async (request, reply) => {
    const params = request.params as { templateId: string };
    const template = store.getTemplate(params.templateId);
    if (!template) {
      reply.code(404);
      return { detail: "Template not found" };
    }
    // Python returns full template details
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      system_prompt: template.system_prompt,
      default_metadata: template.default_metadata,
      is_builtin: template.is_builtin,
      created_at: template.created_at
    };
  });

  fastify.post("/api/templates", async (request, reply) => {
    const body = request.body as JsonBody;
    try {
      // Fix #7: Content filter on system_prompt
      if (body.system_prompt) {
        const { checkContentOrThrow } = await import("../../core/services/contentFilter.js");
        checkContentOrThrow(String(body.system_prompt));
      }
      const success = store.createTemplate({
        id: String(body.id),
        name: String(body.name),
        description: body.description ? String(body.description) : undefined,
        system_prompt: body.system_prompt ? String(body.system_prompt) : undefined,
        default_metadata: body.default_metadata as Record<string, unknown> | undefined
      });
      if (success) {
        const template = store.getTemplate(String(body.id));
        reply.code(201);
        return {
          id: template!.id,
          name: template!.name,
          description: template!.description,
          is_builtin: template!.is_builtin
        };
      }
      reply.code(500);
      return { detail: "Failed to create template" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message.includes("already exists")) {
        reply.code(409);
        return { detail: message };
      }
      reply.code(400);
      return { detail: message };
    }
  });

  fastify.delete("/api/templates/:templateId", async (request, reply) => {
    const params = request.params as { templateId: string };
    try {
      const deleted = store.deleteTemplate(params.templateId);
      if (!deleted) {
        reply.code(404);
        return { detail: "Template not found" };
      }
      reply.code(204);
      return reply.send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message.includes("built-in")) {
        reply.code(403);
        return { detail: message };
      }
      reply.code(404);
      return { detail: message };
    }
  });

  fastify.get("/api/threads/:threadId/settings", async (request, reply) => {
    const params = request.params as { threadId: string };
    const settings = store.getThreadSettings(params.threadId);
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
    const thread = store.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    const settings = store.getThreadSettings(params.threadId);
    // Priority: creator_admin > auto_assigned_admin
    const adminId = settings?.creator_admin_id || settings?.auto_assigned_admin_id || null;
    const adminName = settings?.creator_admin_name || settings?.auto_assigned_admin_name || null;
    const adminType = settings?.creator_admin_id ? "creator" : (settings?.auto_assigned_admin_id ? "auto_assigned" : null);
    const assignedAt = settings?.creator_assignment_time || settings?.admin_assignment_time || null;
    
    // Get emoji from agent record
    let adminEmoji: string | null = null;
    if (adminId) {
      const agents = store.listAgents();
      const agent = agents.find(a => a.id === adminId);
      adminEmoji = agent?.emoji || null;
    }
    
    return {
      admin_id: adminId,
      admin_name: adminName,
      admin_emoji: adminEmoji,
      admin_type: adminType,
      assigned_at: assignedAt
    };
  });

  fastify.post("/api/threads/:threadId/admin/decision", async (request, reply) => {
    const params = request.params as { threadId: string };
    const body = request.body as {
      action: "switch" | "keep" | "takeover" | "cancel";
      candidate_admin_id?: string;
      source_message_id?: string;
    };

    const thread = store.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }

    // Helper to get agent emoji
    const getAgentEmoji = (agentId: string | null | undefined): string => {
      if (!agentId) return "❔";
      const agents = store.listAgents();
      const agent = agents.find(a => a.id === agentId);
      return agent?.emoji || "🤖";
    };

    // Helper to get agent name
    const getAgentName = (agentId: string | null | undefined): string => {
      if (!agentId) return "Unknown";
      const agents = store.listAgents();
      const agent = agents.find(a => a.id === agentId);
      return agent?.display_name || agent?.name || agentId;
    };

    const settings = store.getThreadSettings(params.threadId);
    const currentAdminId = settings?.creator_admin_id || settings?.auto_assigned_admin_id || null;
    const currentAdminName = settings?.creator_admin_name || settings?.auto_assigned_admin_name || null;

    // Check for source_message_id and already decided
    if (body.source_message_id) {
      const sourceMsg = store.getMessage(body.source_message_id);
      if (!sourceMsg) {
        reply.code(404);
        return { detail: "source_message_id not found" };
      }
      if (sourceMsg.thread_id !== params.threadId) {
        reply.code(400);
        return { detail: "source_message_id does not belong to this thread" };
      }

      // Parse metadata (already an object in TS version)
      const sourceMeta: Record<string, unknown> = sourceMsg.metadata || {};
      const sourceUiType = String(sourceMeta.ui_type || "");

      // Validate ui_type
      if (!["admin_switch_confirmation_required", "admin_takeover_confirmation_required"].includes(sourceUiType)) {
        reply.code(400);
        return { detail: "source_message_id is not an admin confirmation prompt" };
      }

      // Validate action for ui_type
      const allowedActions: Record<string, string[]> = {
        "admin_switch_confirmation_required": ["switch", "keep"],
        "admin_takeover_confirmation_required": ["takeover", "cancel"]
      };
      if (!allowedActions[sourceUiType]?.includes(body.action)) {
        reply.code(400);
        return { detail: `Invalid action '${body.action}' for source_message_id ui_type=${sourceUiType}` };
      }

      // Check if already decided
      if (sourceMeta.decision_status === "resolved") {
        return {
          ok: true,
          thread_id: params.threadId,
          action: sourceMeta.decision_action || body.action,
          already_decided: true,
          source_message_id: body.source_message_id,
          decided_at: sourceMeta.decision_at
        };
      }

      // Handle switch action
      if (body.action === "switch") {
        if (!body.candidate_admin_id) {
          reply.code(400);
          return { detail: "candidate_admin_id is required for action='switch'" };
        }

        const candidate = store.getAgent(body.candidate_admin_id);
        if (!candidate) {
          reply.code(404);
          return { detail: "Candidate admin agent not found" };
        }

        const candidateName = candidate.display_name || candidate.name || candidate.id;
        store.switchAdmin(params.threadId, candidate.id, candidateName);

        const oldBadge = `${getAgentEmoji(currentAdminId)} ${currentAdminName || currentAdminId || "Unknown"}`;
        const newBadge = `${getAgentEmoji(candidate.id)} ${candidateName}`;
        const confirmation = `Administrator switched by human decision: ${oldBadge} -> ${newBadge}.`;
        const decidedAt = new Date().toISOString();

        const metadata = {
          ui_type: "admin_switch_decision_result",
          visibility: "human_only",
          decision: "switch",
          thread_id: params.threadId,
          source_message_id: body.source_message_id,
          previous_admin_id: currentAdminId,
          new_admin_id: candidate.id,
          new_admin_name: candidateName,
          new_admin_emoji: getAgentEmoji(candidate.id),
          decided_at: decidedAt
        };

        store.postSystemMessage(params.threadId, confirmation, JSON.stringify(metadata));

        // Update source message metadata
        sourceMeta.decision_status = "resolved";
        sourceMeta.decision_action = "switch";
        sourceMeta.decision_at = decidedAt;
        store.updateMessageMetadata(body.source_message_id, sourceMeta);

        return {
          ok: true,
          action: "switch",
          thread_id: params.threadId,
          new_admin_id: candidate.id,
          new_admin_name: candidateName,
          already_decided: false
        };
      }

      // Handle keep action
      if (body.action === "keep") {
        const keptBadge = `${getAgentEmoji(currentAdminId)} ${currentAdminName || currentAdminId || "Unknown"}`;
        const confirmation = `Administrator kept by human decision: ${keptBadge}.`;
        const decidedAt = new Date().toISOString();

        const metadata = {
          ui_type: "admin_switch_decision_result",
          visibility: "human_only",
          decision: "keep",
          thread_id: params.threadId,
          source_message_id: body.source_message_id,
          kept_admin_id: currentAdminId,
          kept_admin_name: currentAdminName,
          kept_admin_emoji: getAgentEmoji(currentAdminId),
          decided_at: decidedAt
        };

        store.postSystemMessage(params.threadId, confirmation, JSON.stringify(metadata));

        // Update source message metadata
        sourceMeta.decision_status = "resolved";
        sourceMeta.decision_action = "keep";
        sourceMeta.decision_at = decidedAt;
        store.updateMessageMetadata(body.source_message_id, sourceMeta);

        return {
          ok: true,
          action: "keep",
          thread_id: params.threadId,
          kept_admin_id: currentAdminId,
          kept_admin_name: currentAdminName,
          already_decided: false
        };
      }

      // Handle takeover action
      if (body.action === "takeover") {
        const targetAdminId = String(sourceMeta.current_admin_id || currentAdminId || body.candidate_admin_id || "");
        if (!targetAdminId) {
          reply.code(400);
          return { detail: "No actionable administrator found for takeover" };
        }

        const targetAdmin = store.getAgent(targetAdminId);
        if (!targetAdmin) {
          reply.code(404);
          return { detail: "Takeover administrator agent not found" };
        }

        const targetName = targetAdmin.display_name || targetAdmin.name || targetAdmin.id;
        const targetEmoji = getAgentEmoji(targetAdmin.id);
        const instruction = `Coordinator decision: ${targetEmoji} ${targetName}, all other agents appear offline/unavailable. Please take over now, continue work directly, and do not keep waiting in msg_wait.`;
        const decidedAt = new Date().toISOString();

        const metadata = {
          ui_type: "admin_coordination_takeover_instruction",
          decision: "takeover",
          thread_id: params.threadId,
          source_message_id: body.source_message_id,
          handoff_target: targetAdmin.id,
          target_admin_id: targetAdmin.id,
          target_admin_name: targetName,
          target_admin_emoji: targetEmoji,
          decided_at: decidedAt
        };

        store.postSystemMessage(params.threadId, instruction, JSON.stringify(metadata));

        // Update source message metadata
        sourceMeta.decision_status = "resolved";
        sourceMeta.decision_action = "takeover";
        sourceMeta.decision_at = decidedAt;
        store.updateMessageMetadata(body.source_message_id, sourceMeta);

        return {
          ok: true,
          action: "takeover",
          thread_id: params.threadId,
          notified_admin_id: targetAdmin.id,
          notified_admin_name: targetName,
          already_decided: false
        };
      }

      // Handle cancel action
      if (body.action === "cancel") {
        const cancelContent = "Administrator takeover request canceled by human decision. System will continue waiting for other agents to come online.";
        const decidedAt = new Date().toISOString();

        const cancelMeta = {
          ui_type: "admin_takeover_decision_result",
          decision: "cancel",
          visibility: "human_only",
          thread_id: params.threadId,
          source_message_id: body.source_message_id,
          decided_at: decidedAt
        };

        store.postSystemMessage(params.threadId, cancelContent, JSON.stringify(cancelMeta));

        // Update source message metadata
        sourceMeta.decision_status = "resolved";
        sourceMeta.decision_action = "cancel";
        sourceMeta.decision_at = decidedAt;
        store.updateMessageMetadata(body.source_message_id, sourceMeta);

        return {
          ok: true,
          action: "cancel",
          thread_id: params.threadId,
          already_decided: false
        };
      }
    }

    // No source_message_id - simple switch without confirmation prompt
    if (body.action === "switch") {
      if (!body.candidate_admin_id) {
        reply.code(400);
        return { detail: "candidate_admin_id is required for action='switch'" };
      }

      const candidate = store.getAgent(body.candidate_admin_id);
      if (!candidate) {
        reply.code(404);
        return { detail: "Candidate admin agent not found" };
      }

      const candidateName = candidate.display_name || candidate.name || candidate.id;
      store.switchAdmin(params.threadId, candidate.id, candidateName);

      return {
        ok: true,
        action: "switch",
        thread_id: params.threadId,
        new_admin_id: candidate.id,
        new_admin_name: candidateName,
        already_decided: false
      };
    }

    return { ok: true, thread_id: params.threadId, action: body.action };
  });

  fastify.get("/api/threads/:threadId/export", async (request, reply) => {
    const params = request.params as { threadId: string };
    const md = store.exportThreadMarkdown(params.threadId);
    if (md === null) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    
    // Generate filename from topic
    const thread = store.getThread(params.threadId);
    const rawTopic = thread?.topic || params.threadId;
    const slug = rawTopic
      .toLowerCase()
      .replace(/[^\w\-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "thread";
    const filename = `${slug}.md`;
    
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    return md;
  });

  fastify.get("/api/search", async (request, reply) => {
    const query = request.query as { q?: string; query?: string; thread_id?: string; limit?: number };
    const q = String(query.q || query.query || "").trim();
    if (!q) {
      reply.code(400);
      return { detail: "Query parameter 'q' must not be empty" };
    }
    const limit = Math.min(Math.max(1, query.limit || 50), 200);
    const results = store.searchMessages(q, query.thread_id, limit);
    return { results, total: results.length, query: q };
  });

  fastify.get("/api/metrics", async () => store.getMetrics());

  fastify.get("/api/debug/sse-status", async () => ({
    subscribers: eventBus.listenerCount()
  }));

  fastify.post("/api/agents/:agentId/kick", async (request, reply) => {
    const params = request.params as { agentId: string };
    const result = store.kickAgent(params.agentId);
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

  // Ensure underlying persistence DB is closed when the server shuts down.
  fastify.addHook('onClose', async () => {
    try {
      await cliSessionManager.close();
    } catch {
      // ignore
    }
    try {
      if (ownsStore && store && typeof (store as any).close === 'function') {
        try { (store as any).close(); } catch (e) { }
        // If we created a per-process instance, clear the global override
        try { memoryStoreInstance = null; } catch (_) { }
      }
    } catch (e) {
      // ignore
    }
  });

  // Fix #4: Background tasks (Python parity)
  // Event cleanup every 60s — remove events older than 1 hour
  const cleanupInterval = setInterval(() => {
    try { store.cleanupOldEvents(3600); } catch (_) { /* ignore */ }
  }, 60_000);
  // Thread timeout sweep — configurable interval
  const timeoutInterval = setInterval(() => {
    try { store.threadTimeoutSweep(30); } catch (_) { /* ignore */ }
  }, 30_000);
  const adminCoordinatorInterval = setInterval(() => {
    try { store.adminCoordinatorSweep(); } catch (_) { /* ignore */ }
  }, 10_000);
  // Cleanup intervals on server close
  fastify.addHook("onClose", () => {
    clearInterval(cleanupInterval);
    clearInterval(timeoutInterval);
    clearInterval(adminCoordinatorInterval);
  });

  return fastify;
}

async function setThreadStatus(request: FastifyRequest, reply: FastifyReply, status: string) {
  const params = request.params as { threadId: string };
  const ok = getMemoryStore().setThreadStatus(params.threadId, status as never);
  if (!ok) {
    reply.code(404);
    return { detail: "Thread not found" };
  }
  return { ok: true };
}

export async function startHttpServer() {
  const config = getConfig();

  if (config.showAd && !config.adminToken) {
    console.error(
      "[SEC-05] FATAL: SHOW_AD=true but AGENTCHATBUS_ADMIN_TOKEN is not set. " +
      "Set AGENTCHATBUS_ADMIN_TOKEN to a secure value before starting in public demo mode."
    );
    process.exit(1);
  }

  const server = createHttpServer();
  await server.listen({ host: config.host, port: config.port });
  return server;
}
