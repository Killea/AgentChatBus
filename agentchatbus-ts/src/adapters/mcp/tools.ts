import { memoryStore } from "../../core/services/memoryStore.js";
import { eventBus } from "../../shared/eventBus.js";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const toolDefinitions: ToolDefinition[] = [
  // Thread Management
  { 
    name: "thread_create", 
    description: "Create a new conversation thread (topic / task context) on the bus. Authentication is mandatory: provide creator credentials explicitly in input using `agent_id` and `token` (you can obtain them from agent_register/agent_resume). Returns thread details plus initial sync context (`current_seq`, `reply_token`, `reply_window`) for the creator's first msg_post.", 
    inputSchema: { 
      type: "object", 
      required: ["topic", "agent_id", "token"],
      properties: {
        topic: { type: "string", description: "Short description of the thread's purpose." },
        agent_id: { type: "string", description: "Creator agent id. Required." },
        token: { type: "string", description: "Creator token for authentication. Required." },
        metadata: { type: "object", description: "Optional arbitrary key-value metadata." },
        system_prompt: { type: "string", description: "Optional system prompt defining collaboration rules for this thread. Overrides template default." },
        template: { type: "string", description: "Template ID to apply defaults (system_prompt, metadata). Caller-provided values take precedence." }
      }
    } 
  },
  { 
    name: "thread_list", 
    description: "List threads, optionally filtered by status. Supports cursor pagination via `limit` and `before`. Returns an envelope with `threads`, `total`, `has_more`, and `next_cursor`.", 
    inputSchema: { 
      type: "object",
      properties: {
        status: { type: "string", enum: ["discuss", "implement", "review", "done", "closed", "archived"], description: "Filter by lifecycle state. Omit for all threads." },
        include_archived: { type: "boolean", default: false, description: "If true and no status filter is provided, include archived threads." },
        limit: { type: "integer", default: 0, description: "Max threads to return. 0 means all (no limit). Hard cap: 200." },
        before: { type: "string", description: "Pagination cursor: ISO datetime string. Returns threads created strictly before this timestamp. Pass `next_cursor` from a previous response to fetch the next page." }
      }
    } 
  },
  { 
    name: "thread_delete", 
    description: "Permanently delete a thread and ALL its messages. IRREVERSIBLE — data cannot be recovered. Prefer thread_archive for reversible removal. Requires confirm=true to proceed.", 
    inputSchema: { 
      type: "object", 
      required: ["thread_id", "confirm"],
      properties: {
        thread_id: { type: "string", description: "ID of the thread to delete." },
        confirm: { type: "boolean", description: "Must be true to proceed. Safeguard against accidental deletion." }
      }
    } 
  },
  { 
    name: "thread_get", 
    description: "Get details of a single thread by ID.", 
    inputSchema: { 
      type: "object", 
      required: ["thread_id"],
      properties: {
        thread_id: { type: "string" }
      }
    } 
  },
  { 
    name: "thread_settings_get", 
    description: "Get thread settings (coordination config, timeouts, admin assignment). Returns auto_administrator_enabled, timeout_seconds, switch_timeout_seconds, and current admin info. Use before thread_settings_update to inspect current values.", 
    inputSchema: { 
      type: "object", 
      required: ["thread_id"],
      properties: {
        thread_id: { type: "string", description: "Thread ID." }
      }
    } 
  },
  { 
    name: "thread_settings_update", 
    description: "Update thread settings for coordination and timeouts. Key use case: set auto_administrator_enabled=false to disable the coordinator for debate threads (removes ORCH-14/15/16 Shell workaround). All fields are optional — only provided fields are updated. timeout_seconds and switch_timeout_seconds must be >= 30.", 
    inputSchema: { 
      type: "object", 
      required: ["thread_id"],
      properties: {
        thread_id: { type: "string", description: "Thread ID." },
        auto_administrator_enabled: { type: "boolean", description: "Enable/disable automatic admin coordinator." },
        timeout_seconds: { type: "integer", minimum: 30, description: "Admin takeover timeout in seconds (>= 30)." },
        switch_timeout_seconds: { type: "integer", minimum: 30, description: "Admin switch timeout in seconds (>= 30)." }
      }
    } 
  },
  { 
    name: "msg_post", 
    description: "Post a message to a thread. Returns the new message ID and global seq number.", 
    inputSchema: { 
      type: "object", 
      required: ["thread_id", "author", "content", "expected_last_seq", "reply_token"],
      properties: {
        thread_id: { type: "string" },
        author: { type: "string", description: "Agent ID, 'system', or 'human'." },
        content: { type: "string" },
        expected_last_seq: { type: "integer", description: "Strict sync field. Thread seq the sender used as context baseline." },
        reply_token: { type: "string", description: "Strict sync field. Unconsumed reply token from thread_create/msg_wait/sync-context." },
        role: { type: "string", enum: ["user", "assistant", "system"], default: "user" },
        priority: { type: "string", enum: ["normal", "urgent", "system"], default: "normal", description: "Message priority level. 'urgent' for time-sensitive content, 'system' for automated coordination messages." },
        mentions: { type: "array", items: { type: "string" }, description: "List of agent IDs to mention in this message." },
        metadata: { 
          type: "object", 
          description: "Structured message metadata for orchestration and routing.",
          properties: {
            handoff_target: { type: "string", description: "Agent ID that should handle this message next (triggers msg.handoff SSE event)." },
            stop_reason: { type: "string", enum: ["convergence", "timeout", "error", "complete", "impasse"], description: "Why the posting agent is ending its turn (triggers msg.stop SSE event)." },
            attachments: { type: "array", items: { type: "object" }, description: "File or image attachments." }
          }
        },
        reply_to_msg_id: { type: "string", description: "Optional ID of the message being replied to. Must belong to the same thread. Triggers a msg.reply SSE event." }
      }
    } 
  },
  { 
    name: "msg_list", 
    description: "Fetch messages in a thread after a given seq cursor.", 
    inputSchema: { 
      type: "object",
      required: ["thread_id"],
      properties: {
        thread_id: { type: "string" },
        after_seq: { type: "integer", default: 0, description: "Return messages with seq > this value." },
        limit: { type: "integer", default: 100 },
        priority: { type: "string", enum: ["normal", "urgent", "system"], description: "Optional: filter messages by priority level." },
        return_format: { type: "string", enum: ["json", "blocks"], default: "blocks", description: "Return format for tool result content. 'blocks' returns native MCP content blocks (TextContent/ImageContent...). 'json' returns a single JSON-encoded text payload (legacy)." },
        include_system_prompt: { type: "boolean", default: true, description: "If true and after_seq=0, prepend a synthetic system prompt row." },
        include_attachments: { type: "boolean", default: true, description: "If false, omit image/attachment content from blocks format (text-only). Reduces payload size when images are not needed." }
      }
    } 
  },
  { 
    name: "msg_get", 
    description: "Fetch a single message by its ID. Returns full message details including content, author, seq, priority, reply_to_msg_id, metadata, and reactions. Returns {found: false} if the message does not exist. Useful for reply-to context lookup, verification before reacting, or retrieving a specific message referenced by ID.", 
    inputSchema: { 
      type: "object",
      required: ["message_id"],
      properties: {
        message_id: { type: "string", description: "ID of the message to fetch." }
      }
    } 
  },
  { 
    name: "msg_wait", 
    description: "Block until at least one new message arrives in the thread after `after_seq`. Returns immediately if messages are already available. Always includes sync context (`current_seq`, `reply_token`, `reply_window`) for the next strict `msg_post` call. If this tool returns an empty list (timeout), avoid spammy waiting messages, but after repeated timeouts you SHOULD send a concise, meaningful progress update (status/blocker/next action) and optionally @mention a relevant online agent.", 
    inputSchema: { 
      type: "object",
      required: ["thread_id", "after_seq"],
      properties: {
        thread_id: { type: "string" },
        after_seq: { type: "integer" },
        timeout_ms: { type: "integer", default: 300000, description: "Max wait in milliseconds." },
        return_format: { type: "string", enum: ["json", "blocks"], default: "blocks", description: "Return format for tool result content. 'blocks' returns native MCP content blocks (TextContent/ImageContent...). 'json' returns a single JSON-encoded text payload (legacy)." },
        agent_id: { type: "string", description: "Optional: your agent ID for activity tracking." },
        token: { type: "string", description: "Optional: your agent token for verification." },
        for_agent: { type: "string", description: "Only return messages where metadata.handoff_target matches this agent ID. Useful for directed handoff routing." },
        include_attachments: { type: "boolean", default: true, description: "If false, omit image/attachment content from blocks format (text-only). Reduces payload size when images are not needed." }
      }
    } 
  },
  { name: "template_list", description: "List templates.", inputSchema: { type: "object" } },
  { name: "template_get", description: "Get template by ID.", inputSchema: { type: "object", required: ["template_id"] } },
  { name: "template_create", description: "Create a template.", inputSchema: { type: "object", required: ["id", "name"] } },
  { 
    name: "agent_register", 
    description: "Register an agent onto the bus. The display name is auto-generated as 'IDE (Model)' — e.g. 'Cursor (GPT-4)'. If the same IDE+Model pair is already registered, a numeric suffix is appended: 'Cursor (GPT-4) 2'. Optional `display_name` can be provided as a human-friendly alias. Use `capabilities` for simple string tags and `skills` for structured A2A-compatible skill declarations. Returns agent_id and a secret token for subsequent calls.", 
    inputSchema: { 
      type: "object",
      required: ["ide", "model"],
      properties: {
        ide: { type: "string", description: "Name of the IDE or client, e.g. 'Cursor', 'Claude Desktop', 'CLI'." },
        model: { type: "string", description: "Model name, e.g. 'claude-3-5-sonnet-20241022', 'GPT-4'." },
        description: { type: "string", description: "Optional short description of this agent's role." },
        capabilities: { type: "array", items: { type: "string" }, description: "Simple capability tags for fast matching, e.g. ['code', 'review', 'security']." },
        skills: { 
          type: "array", 
          description: "Structured skill declarations (A2A AgentCard compatible). Each skill has id and name at minimum.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Machine-readable skill identifier, e.g. 'code-review'." },
              name: { type: "string", description: "Human-readable skill name." },
              description: { type: "string", description: "What this skill does." },
              tags: { type: "array", items: { type: "string" }, description: "Additional tags for routing." },
              examples: { type: "array", items: { type: "string" }, description: "Example prompts this skill handles." }
            },
            required: ["id", "name"]
          }
        },
        display_name: { type: "string", description: "Optional human-friendly alias shown in UI and message labels." }
      }
    } 
  },
  { name: "agent_heartbeat", description: "Heartbeat an agent.", inputSchema: { type: "object", required: ["agent_id", "token"] } },
  { name: "agent_resume", description: "Resume an agent.", inputSchema: { type: "object", required: ["agent_id", "token"] } },
  { name: "agent_unregister", description: "Unregister an agent.", inputSchema: { type: "object", required: ["agent_id", "token"] } },
  { name: "agent_list", description: "List agents.", inputSchema: { type: "object" } },
  { name: "agent_update", description: "Update an agent.", inputSchema: { type: "object", required: ["agent_id", "token"] } },
  { name: "agent_set_typing", description: "Set typing indicator.", inputSchema: { type: "object", required: ["thread_id", "agent_id", "is_typing"] } },
  { name: "msg_react", description: "React to a message.", inputSchema: { type: "object", required: ["message_id", "agent_id", "reaction"] } },
  { name: "msg_unreact", description: "Remove a reaction from a message.", inputSchema: { type: "object", required: ["message_id", "agent_id", "reaction"] } },
  { 
    name: "bus_connect", 
    description: "One-step connect: register an agent and join (or create) a thread. Returns agent identity, thread details, full message history, and sync context (current_seq, reply_token, reply_window). Clients can use that sync context directly for the first msg_post without an extra msg_wait call. If the thread does not exist, it is created automatically and the agent becomes the thread administrator.", 
    inputSchema: { 
      type: "object",
      required: ["thread_name"],
      properties: {
        thread_name: { type: "string", description: "Thread topic name to join or create." },
        ide: { type: "string", description: "IDE name for new registration." },
        model: { type: "string", description: "Model name for new registration." },
        after_seq: { type: "integer", default: 0, description: "Fetch messages with seq > this value. Default 0 (all)." },
        agent_id: { type: "string", description: "Optional: existing agent_id for session resumption (use with token)." },
        token: { type: "string", description: "Optional: agent token for session resumption (use with agent_id)." },
        description: { type: "string", description: "Optional: agent description for new registration." },
        capabilities: { type: "array", items: { type: "string" }, description: "Optional: capability tags for new registration, e.g. ['code', 'review', 'security']." },
        display_name: { type: "string", description: "Optional: human-friendly alias for new registration." },
        skills: { 
          type: "array", 
          description: "Optional: structured skill declarations for new registration (A2A compatible).",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Machine-readable skill identifier." },
              name: { type: "string", description: "Human-readable skill name." },
              description: { type: "string", description: "What this skill does." },
              tags: { type: "array", items: { type: "string" }, description: "Additional tags for routing." },
              examples: { type: "array", items: { type: "string" }, description: "Example prompts." }
            },
            required: ["id", "name"]
          }
        },
        system_prompt: { type: "string", description: "Optional system prompt for thread creation. Only applied when creating a new thread (ignored when joining an existing one). Overrides template default." },
        template: { type: "string", description: "Optional template ID for thread creation. Only applied when creating a new thread (ignored when joining an existing one)." }
      }
    } 
  },
  { name: "bus_get_config", description: "Get bus config.", inputSchema: { type: "object" } },
  { name: "msg_search", description: "Search messages.", inputSchema: { type: "object", required: ["query"] } },
  { name: "msg_edit", description: "Edit a message.", inputSchema: { type: "object", required: ["message_id", "new_content"] } },
  { name: "msg_edit_history", description: "Get message edit history.", inputSchema: { type: "object", required: ["message_id"] } }
];

export function listTools(): ToolDefinition[] {
  return toolDefinitions;
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "thread_create": {
      // Strict creator auth: explicit id/token are mandatory
      const agentId = String(args.agent_id || "");
      const token = String(args.token || "");
      if (!agentId || !token) {
        throw new Error(
          "thread_create requires explicit agent_id and token in input. " +
          "Use agent_register or agent_resume to obtain credentials first."
        );
      }

      // Verify agent credentials
      const agent = memoryStore.getAgent(agentId);
      if (!agent || agent.token !== token) {
        throw new Error("Invalid agent_id or token");
      }

      const topic = String(args.topic || "").trim();
      if (!topic) {
        throw new Error("topic is required");
      }

      const templateId = typeof args.template === "string" ? args.template : undefined;
      const systemPrompt = typeof args.system_prompt === "string" ? args.system_prompt : undefined;
      
      const created = memoryStore.createThread(topic, systemPrompt, templateId);
      return {
        thread_id: created.thread.id,
        topic: created.thread.topic,
        status: created.thread.status,
        system_prompt: created.thread.system_prompt,
        template_id: created.thread.template_id,
        current_seq: created.sync.current_seq,
        reply_token: created.sync.reply_token,
        reply_window: created.sync.reply_window
      };
    }
    case "thread_list": {
      const status = typeof args.status === "string" ? args.status : undefined;
      const includeArchived = Boolean(args.include_archived);
      const limit = typeof args.limit === "number" ? args.limit : 0;
      const before = typeof args.before === "string" ? args.before : undefined;

      let threads = memoryStore.getThreads(includeArchived);
      
      // Filter by status if provided
      if (status) {
        threads = threads.filter(t => t.status === status);
      }

      // Apply pagination
      let total = threads.length;
      let hasMore = false;
      let nextCursor: string | null = null;

      if (before) {
        const beforeDate = new Date(before);
        threads = threads.filter(t => new Date(t.created_at) < beforeDate);
      }

      if (limit > 0) {
        if (threads.length > limit) {
          hasMore = true;
          nextCursor = threads[limit - 1].created_at;
          threads = threads.slice(0, limit);
        }
      }

      return {
        threads: threads.map(t => ({
          thread_id: t.id,
          topic: t.topic,
          status: t.status,
          created_at: t.created_at
        })),
        total,
        has_more: hasMore,
        next_cursor: nextCursor
      };
    }
    case "thread_get": {
      const thread = memoryStore.getThread(String(args.thread_id || ""));
      if (!thread) {
        return { error: "Thread not found" };
      }
      return {
        thread_id: thread.id,
        topic: thread.topic,
        status: thread.status,
        created_at: thread.created_at,
        closed_at: (thread as any).closed_at || null,
        summary: (thread as any).summary || null
      };
    }
    case "thread_delete": {
      const threadId = String(args.thread_id || "");
      const confirm = Boolean(args.confirm);
      
      if (!confirm) {
        return {
          error: "Deletion aborted: confirm must be true. This action is irreversible.",
        };
      }

      const deleted = memoryStore.deleteThread(threadId);
      if (!deleted) {
        return { error: "Thread not found" };
      }
      return { ok: true, deleted: threadId };
    }
    case "thread_settings_get":
      return memoryStore.getThreadSettings(String(args.thread_id || "")) || { found: false };
    case "thread_settings_update":
      return memoryStore.updateThreadSettings(String(args.thread_id || ""), {
        auto_administrator_enabled: typeof args.auto_administrator_enabled === "boolean" ? args.auto_administrator_enabled : undefined,
        timeout_seconds: typeof args.timeout_seconds === "number" ? args.timeout_seconds : undefined,
        switch_timeout_seconds: typeof args.switch_timeout_seconds === "number" ? args.switch_timeout_seconds : undefined
      }) || { found: false };
    case "msg_post": {
      const threadId = String(args.thread_id || "");
      const author = String(args.author || "human");
      const content = String(args.content || "");
      const expectedLastSeq = typeof args.expected_last_seq === "number" ? args.expected_last_seq : undefined;
      const replyToken = typeof args.reply_token === "string" ? args.reply_token : undefined;
      const role = typeof args.role === "string" ? args.role : "user";
      const priority = typeof args.priority === "string" ? args.priority : "normal";
      const metadata = typeof args.metadata === "object" && args.metadata !== null ? args.metadata as Record<string, unknown> : undefined;
      const replyToMsgId = typeof args.reply_to_msg_id === "string" ? args.reply_to_msg_id : undefined;

      try {
        const message = memoryStore.postMessage({
          threadId,
          author,
          content,
          expectedLastSeq,
          replyToken,
          role,
          priority,
          metadata,
          replyToMsgId
        });

        // Chain token: issue a fresh reply_token so the agent can post again
        const chainSync = memoryStore.issueSyncContext(threadId, message.author_id, "msg_post_chain");

        return {
          msg_id: message.id,
          seq: message.seq,
          reply_to_msg_id: message.reply_to_msg_id,
          priority: message.priority,
          reply_token: chainSync.reply_token,
          current_seq: chainSync.current_seq,
          reply_window: chainSync.reply_window
        };
      } catch (error) {
        const err = error as any;
        if (err.detail) {
          throw new Error(JSON.stringify(err.detail));
        }
        throw err;
      }
    }
    case "msg_list": {
      const threadId = String(args.thread_id || "");
      const afterSeq = typeof args.after_seq === "number" ? args.after_seq : 0;
      const limit = typeof args.limit === "number" ? args.limit : 100;
      const priority = typeof args.priority === "string" ? args.priority : undefined;
      const returnFormat = typeof args.return_format === "string" ? args.return_format : "blocks";
      const includeAttachments = typeof args.include_attachments === "boolean" ? args.include_attachments : true;

      let messages = memoryStore.getMessages(threadId, afterSeq);

      // Filter by priority if provided
      if (priority) {
        messages = messages.filter(m => m.priority === priority);
      }

      // Apply limit
      if (limit > 0 && messages.length > limit) {
        messages = messages.slice(0, limit);
      }

      if (returnFormat === "blocks") {
        // Return as MCP content blocks
        const blocks: any[] = [];
        for (const msg of messages) {
          blocks.push({
            type: "text",
            text: `[${msg.seq}] ${msg.author_name || msg.author} (${msg.role}) ${msg.created_at}`
          });
          if (msg.content) {
            blocks.push({
              type: "text",
              text: msg.content
            });
          }
          // Add images/attachments if requested
          if (includeAttachments && msg.metadata) {
            const meta = msg.metadata as any;
            const attachments = meta.attachments || meta.images || meta.image || [];
            const attArray = Array.isArray(attachments) ? attachments : [attachments];
            for (const att of attArray) {
              if (att && typeof att === 'object' && 'data' in att) {
                blocks.push({
                  type: "image",
                  data: att.data || att.base64,
                  mimeType: att.mimeType || att.mime_type || "image/png"
                });
              }
            }
          }
        }
        return { messages: blocks };
      } else {
        // Return as JSON
        return {
          messages: messages.map(m => ({
            msg_id: m.id,
            thread_id: m.thread_id,
            seq: m.seq,
            author: m.author,
            author_id: m.author_id,
            author_name: m.author_name,
            role: m.role,
            content: m.content,
            created_at: m.created_at,
            metadata: m.metadata,
            reply_to_msg_id: m.reply_to_msg_id,
            reactions: m.reactions || [],
            priority: m.priority
          }))
        };
      }
    }
    case "msg_get": {
      const messageId = String(args.message_id || "");
      const message = memoryStore.getMessage(messageId);
      
      if (!message) {
        return { found: false, message: null };
      }

      const reactions = memoryStore.getReactions(messageId);
      return {
        found: true,
        message: {
          msg_id: message.id,
          thread_id: message.thread_id,
          author: message.author,
          author_id: message.author_id,
          author_name: message.author_name,
          content: message.content,
          seq: message.seq,
          role: message.role,
          reply_to_msg_id: message.reply_to_msg_id,
          metadata: message.metadata,
          created_at: message.created_at,
          edited_at: message.edited_at,
          edit_version: message.edit_version,
          reactions: reactions,
          priority: message.priority
        }
      };
    }
    case "msg_wait": {
      const threadId = String(args.thread_id || "");
      const afterSeq = Number(args.after_seq || 0);
      const agentId = typeof args.agent_id === "string" ? args.agent_id : undefined;
      const token = typeof args.token === "string" ? args.token : undefined;
      const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 300_000;

      // Verify credentials if provided
      if (agentId && token) {
        const ok = memoryStore.verifyAgentToken(agentId, token);
        if (!ok) {
          return { error: "InvalidCredentials", detail: "Invalid agent_id/token for msg_wait." };
        }
      }

      try {
        // Delegate to MemoryStore.waitForMessages which records wait states
        const result = memoryStore.waitForMessages({ threadId, afterSeq, agentId, timeoutMs });
        return result;
      } catch (err) {
        return { error: (err as Error).message };
      }
    }
    case "template_list": {
      const templates = memoryStore.getTemplates();
      return {
        templates: templates.map(t => ({
          id: t.id,
          name: t.name,
          description: t.description,
          is_builtin: t.is_builtin,
          created_at: t.created_at
        }))
      };
    }
    case "template_get": {
      const templateId = String(args.template_id || "");
      const template = memoryStore.getTemplate(templateId);
      if (!template) {
        return { error: "Template not found" };
      }
      return {
        id: template.id,
        name: template.name,
        description: template.description,
        system_prompt: template.system_prompt,
        default_metadata: template.default_metadata,
        is_builtin: template.is_builtin,
        created_at: template.created_at
      };
    }
    case "template_create": {
      const id = String(args.id || "");
      const name = String(args.name || "");
      const description = typeof args.description === "string" ? args.description : undefined;
      const systemPrompt = typeof args.system_prompt === "string" ? args.system_prompt : undefined;
      const defaultMetadata = typeof args.default_metadata === "object" && args.default_metadata !== null ? args.default_metadata as Record<string, unknown> : undefined;

      if (!id || !name) {
        throw new Error("id and name are required");
      }

      const ok = memoryStore.createTemplate({ id, name, description, system_prompt: systemPrompt, default_metadata: defaultMetadata });
      if (!ok) {
        return { error: "Failed to create template (may already exist)" };
      }
      const template = memoryStore.getTemplate(id);
      return {
        ok: true,
        id: template?.id,
        name: template?.name,
        description: template?.description,
        is_builtin: template?.is_builtin,
        created_at: template?.created_at
      };
    }
    case "agent_register": {
      const ide = String(args.ide || "CLI");
      const model = String(args.model || "unknown");
      const description = typeof args.description === "string" ? args.description : undefined;
      const displayName = typeof args.display_name === "string" ? args.display_name : undefined;
      const capabilities = Array.isArray(args.capabilities) ? args.capabilities.map(String) : undefined;
      const skills = Array.isArray(args.skills) ? args.skills : undefined;

      const agent = memoryStore.registerAgent({
        ide,
        model,
        description,
        display_name: displayName,
        capabilities,
        skills
      });
      
      return {
        agent_id: agent.id,
        name: agent.name,
        display_name: agent.display_name,
        alias_source: (agent as any).alias_source || "user",
        token: agent.token,
        capabilities: agent.capabilities || [],
        skills: agent.skills || [],
        last_activity: agent.last_activity,
        last_activity_time: agent.last_activity_time,
        thread_create_requirement: "When calling thread_create, you must provide both agent_id and token explicitly in input.",
        deprecation_info: {
          status: "deprecated",
          recommended_replacement: "bus_connect",
          reason: "agent_register only handles agent identity registration. bus_connect provides unified one-step lifecycle.",
          timeline: "Soft-warn in v1.1 → Soft-disable in v1.3 → Hard-remove in v2.0"
        }
      };
    }
    case "agent_heartbeat": {
      const agentId = String(args.agent_id || "");
      const token = String(args.token || "");
      const ok = memoryStore.heartbeatAgent(agentId, token);
      if (!ok) {
        return { error: "Invalid agent_id or token" };
      }
      return { ok: true };
    }
    case "agent_resume": {
      const agentId = String(args.agent_id || "");
      const token = String(args.token || "");
      const agent = memoryStore.resumeAgent(agentId, token);
      if (!agent) {
        return { error: "Invalid agent_id or token", found: false };
      }
      return {
        ok: true,
        agent_id: agent.id,
        name: agent.name,
        display_name: agent.display_name,
        alias_source: (agent as any).alias_source || "user",
        is_online: agent.is_online,
        last_heartbeat: agent.last_heartbeat,
        last_activity: agent.last_activity,
        last_activity_time: agent.last_activity_time,
        thread_create_requirement: "When calling thread_create, you must provide both agent_id and token explicitly in input."
      };
    }
    case "agent_unregister": {
      const agentId = String(args.agent_id || "");
      const token = String(args.token || "");
      const ok = memoryStore.unregisterAgent(agentId, token);
      if (!ok) {
        return { error: "Invalid agent_id or token" };
      }
      return { ok: true };
    }
    case "agent_list": {
      const agents = memoryStore.listAgents();
      return {
        agents: agents.map(a => ({
          agent_id: a.id,
          name: a.name,
          ide: a.ide,
          model: a.model,
          display_name: a.display_name,
          alias_source: (a as any).alias_source || "user",
          description: a.description,
          is_online: a.is_online,
          capabilities: a.capabilities || [],
          skills: a.skills || [],
          last_heartbeat: a.last_heartbeat,
          last_activity: a.last_activity,
          last_activity_time: a.last_activity_time
        }))
      };
    }
    case "agent_update": {
      const agentId = String(args.agent_id || "");
      const token = String(args.token || "");
      const description = typeof args.description === "string" ? args.description : undefined;
      const displayName = typeof args.display_name === "string" ? args.display_name : undefined;
      const capabilities = Array.isArray(args.capabilities) ? args.capabilities.map(String) : undefined;
      const skills = Array.isArray(args.skills) ? args.skills : undefined;

      const agent = memoryStore.updateAgent(agentId, token, {
        description,
        display_name: displayName,
        capabilities,
        skills
      });

      if (!agent) {
        return { error: "Invalid agent_id or token", found: false };
      }

      return {
        ok: true,
        agent_id: agent.id,
        name: agent.name,
        display_name: agent.display_name,
        description: agent.description,
        capabilities: agent.capabilities || [],
        skills: agent.skills || [],
        last_activity: agent.last_activity,
        last_activity_time: agent.last_activity_time
      };
    }
    case "agent_set_typing": {
      const threadId = String(args.thread_id || "");
      const agentId = String(args.agent_id || "");
      const isTyping = Boolean(args.is_typing);
      // Emit typing event via eventBus
      eventBus.emit({ type: "agent.typing", payload: { thread_id: threadId, agent_id: agentId, is_typing: isTyping } });
      return { ok: true, thread_id: threadId, agent_id: agentId, is_typing: isTyping };
    }
    case "msg_react": {
      const messageId = String(args.message_id || "");
      const agentId = String(args.agent_id || "");
      const reaction = String(args.reaction || "");
      
      const message = memoryStore.addReaction(messageId, agentId, reaction);
      if (!message) {
        return { error: "Message not found" };
      }
      
      return {
        reaction_id: `${messageId}-${agentId}-${reaction}`,
        message_id: messageId,
        agent_id: agentId,
        agent_name: (memoryStore.getAgent(agentId))?.name || agentId,
        reaction: reaction,
        created_at: new Date().toISOString()
      };
    }
    case "msg_unreact": {
      const messageId = String(args.message_id || "");
      const agentId = String(args.agent_id || "");
      const reaction = String(args.reaction || "");
      
      const result = memoryStore.removeReaction(messageId, agentId, reaction);
      if (!result) {
        return { error: "Message not found" };
      }
      
      return {
        removed: result.removed,
        message_id: messageId,
        reaction: reaction
      };
    }
    case "bus_connect": {
      const threadName = String(args.thread_name || "");
      if (!threadName) {
        throw new Error("thread_name is required");
      }

      // Phase 1: Agent Identity (Register or Resume)
      let agent;
      const agentIdArg = typeof args.agent_id === "string" ? args.agent_id : undefined;
      const tokenArg = typeof args.token === "string" ? args.token : undefined;

      if (agentIdArg && tokenArg) {
        // Resume existing agent
        agent = memoryStore.resumeAgent(agentIdArg, tokenArg);
        if (!agent) {
          return { error: `Failed to resume agent: Invalid agent_id or token` };
        }
      }

      if (!agent) {
        // Register new agent
        const ide = typeof args.ide === "string" ? args.ide : "CLI";
        const model = typeof args.model === "string" ? args.model : "unknown";
        const description = typeof args.description === "string" ? args.description : undefined;
        const displayName = typeof args.display_name === "string" ? args.display_name : undefined;
        const capabilities = Array.isArray(args.capabilities) ? args.capabilities.map(String) : undefined;
        const skills = Array.isArray(args.skills) ? args.skills : undefined;

        agent = memoryStore.registerAgent({
          ide,
          model,
          description,
          display_name: displayName,
          capabilities,
          skills
        });
      }

      // Phase 2: Find or Create Thread
      let thread = memoryStore.getThreads(false).find(t => t.topic === threadName);
      let threadCreated = false;

      if (!thread) {
        const templateId = typeof args.template === "string" ? args.template : undefined;
        const systemPrompt = typeof args.system_prompt === "string" ? args.system_prompt : undefined;
        const created = memoryStore.createThread(threadName, systemPrompt, templateId);
        thread = created.thread;
        threadCreated = true;
      }

      // Phase 3: Fetch Messages + Sync Context
      const afterSeq = typeof args.after_seq === "number" ? args.after_seq : 0;
      const messages = memoryStore.getMessages(thread.id, afterSeq);

      // Invalidate old bus_connect tokens and issue new one
      memoryStore.invalidateReplyTokensForAgentSource(thread.id, agent.id, "bus_connect");
      const sync = memoryStore.issueSyncContext(thread.id, agent.id, "bus_connect");

      // Phase 4: Identify Administrator Role
      const settings = memoryStore.getThreadSettings(thread.id);
      const adminId = (settings as any)?.auto_assigned_admin_id || (settings as any)?.creator_admin_id;
      const adminName = (settings as any)?.auto_assigned_admin_name || (settings as any)?.creator_admin_name;

      const isAdmin = adminId === agent.id;
      const roleAssignment = isAdmin
        ? `You are the ADMINISTRATOR for this thread. You are responsible for coordination and task assignment.`
        : adminId
          ? `You are a PARTICIPANT in this thread. Please wait for the administrator (@${adminId}) to coordinate or assign you tasks.`
          : `You are the administrator for thread ${thread.topic}. Coordinate work and keep progress moving.`;

      return {
        agent: {
          agent_id: agent.id,
          name: agent.name,
          registered: true,
          token: agent.token,
          is_administrator: isAdmin,
          role_assignment: roleAssignment
        },
        thread: {
          thread_id: thread.id,
          topic: thread.topic,
          status: thread.status,
          created: threadCreated,
          ...(threadCreated && thread.system_prompt ? { system_prompt: thread.system_prompt } : {}),
          ...(adminId ? { administrator: { agent_id: adminId, name: adminName } } : {})
        },
        messages: messages.map(m => ({
          seq: m.seq,
          author: m.author_name || m.author,
          role: m.role,
          content: m.content,
          created_at: m.created_at
        })),
        current_seq: sync.current_seq,
        reply_token: sync.reply_token,
        reply_window: sync.reply_window
      };
    }
    case "bus_get_config": {
      const settings = memoryStore.getSettings();
      return {
        preferred_language: (settings as any).preferred_language || "English",
        language_source: "default",
        language_note: "Please respond in English whenever possible. This is a soft preference — use your best judgement.",
        bus_name: "AgentChatBus",
        version: "0.2.2",
        endpoint: `http://localhost:${process.env.AGENTCHATBUS_PORT || "39765"}`,
        auth_requirements: {
          mcp_thread_create: {
            required: true,
            body: ["topic", "agent_id", "token"],
            rule: "agent_id and token must be provided explicitly in thread_create input."
          },
          rest_thread_create: {
            required: true,
            body: ["topic", "creator_agent_id"],
            headers: ["X-Agent-Token"]
          }
        },
        recommended_workflow: {
          join_or_create_thread: {
            tool: "bus_connect",
            input: { thread_name: "My Topic", ide: "Cursor", model: "Claude" },
            note: "One call: auto-registers agent, joins or creates thread, returns messages + sync context. For resuming an existing identity, use 'agent_resume' explicitly instead."
          }
        }
      };
    }
    case "msg_search": {
      const query = String(args.query || "");
      if (!query) {
        return { error: "query must not be empty" };
      }
      const threadId = typeof args.thread_id === "string" ? args.thread_id : undefined;
      const limit = typeof args.limit === "number" ? args.limit : 50;

      let results = memoryStore.searchMessages(query);
      
      // Filter by thread if provided
      if (threadId) {
        results = results.filter(m => m.thread_id === threadId);
      }

      // Apply limit
      if (limit > 0 && results.length > limit) {
        results = results.slice(0, limit);
      }

      return {
        results: results.map(m => ({
          msg_id: m.id,
          thread_id: m.thread_id,
          seq: m.seq,
          author: m.author,
          content: m.content,
          created_at: m.created_at,
          snippet: m.content.substring(0, 200) + (m.content.length > 200 ? "..." : "")
        })),
        total: results.length,
        query: query
      };
    }
    case "msg_edit": {
      const messageId = String(args.message_id || "");
      const newContent = String(args.new_content || "");
      
      if (!messageId || !newContent) {
        return { error: "message_id and new_content are required" };
      }

      // Deduce edited_by from connection context (simplified - would need real context in production)
      const editedBy = "system";
      
      const result = memoryStore.editMessage(messageId, newContent, editedBy);
      if (!result) {
        return { error: `Message '${messageId}' not found` };
      }
      
      if ('no_change' in result) {
        return { no_change: true, version: (result as any).version };
      }
      
      return {
        msg_id: messageId,
        version: result.edit_version,
        edited_at: result.edited_at,
        edited_by: editedBy
      };
    }
    case "msg_edit_history": {
      const messageId = String(args.message_id || "");
      if (!messageId) {
        return { error: "message_id is required" };
      }

      const message = memoryStore.getMessage(messageId);
      if (!message) {
        return { found: false, message_id: messageId };
      }

      const edits = memoryStore.getMessageHistory(messageId);
      return {
        message_id: messageId,
        current_content: message.content,
        edit_version: message.edit_version || 1,
        edits: edits
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
