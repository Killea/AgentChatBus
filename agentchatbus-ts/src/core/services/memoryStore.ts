import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRecord, IdeSessionState, MessageRecord, SyncContext, ThreadRecord, ThreadStatus } from "../types/models.js";
import { 
  BusError, 
  MissingSyncFieldsError, 
  SeqMismatchError, 
  ReplyTokenInvalidError, 
  ReplyTokenExpiredError, 
  ReplyTokenReplayError 
} from "../types/errors.js";
import { eventBus } from "../../shared/eventBus.js";
import { generateAgentEmoji } from "../../main.js";
import { registerStore } from "./storeSingleton.js";

type IdeSession = {
  instanceId: string;
  ideLabel: string;
  sessionToken: string;
  registeredAt: string;
  lastSeen: string;
};

type ReplyTokenRecord = {
  threadId: string;
  agentId?: string;
  source?: string;
  token: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt?: number;
  status: "issued" | "consumed";
};

type RefreshRequestRecord = {
  threadId: string;
  agentId: string;
  reason: string;
  createdAt: string;
};

type WaitStateRecord = {
  agentId: string;
  enteredAt: string;
  timeoutMs: number;
};

const NON_EXPIRING_TOKEN_TS = Date.parse("9999-12-31T23:59:59Z");

type PersistedState = {
  sequence: number;
  threads: ThreadRecord[];
  threadMessages: Array<[string, MessageRecord[]]>;
  threadParticipants: Array<[string, string[]]>;
  threadWaitStates: Array<[string, Array<[string, WaitStateRecord]>]>;
  agents: AgentRecord[];
  syncTokens: ReplyTokenRecord[];
  logEntries: Array<{ id: number; line: string }>;
  ideSessions: IdeSession[];
  ideOwnerInstanceId: string | null;
  logCursor: number;
  threadSettings: Array<[string, { auto_administrator_enabled: boolean; timeout_seconds: number; switch_timeout_seconds: number }]>;
  messageEditHistory: Array<[string, Array<{ version: number; old_content: string; edited_by: string; created_at: string }>]>;
};

export class MemoryStore {
  private static readonly SEQ_TOLERANCE = 5;
  private readonly startTime = Date.now();
  private sequence = 0;
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly threadMessages = new Map<string, MessageRecord[]>();
  private readonly threadParticipants = new Map<string, Set<string>>();
  private readonly threadWaitStates = new Map<string, Map<string, WaitStateRecord>>();
  private readonly agents = new Map<string, AgentRecord>();
  private readonly syncTokens = new Map<string, ReplyTokenRecord>();
  private readonly logEntries: Array<{ id: number; line: string }> = [];
  private readonly ideSessions = new Map<string, IdeSession>();
  private readonly threadSettings = new Map<string, { auto_administrator_enabled: boolean; timeout_seconds: number; switch_timeout_seconds: number }>();
  private readonly messageEditHistory = new Map<string, Array<{ version: number; old_content: string; edited_by: string; created_at: string }>>();
  private ideOwnerInstanceId: string | null = null;
  private logCursor = 0;
  private readonly persistencePath: string;
  private readonly persistenceDb: DatabaseSync;

  constructor(persistencePath = process.env.AGENTCHATBUS_DB || (process.env.VITEST_WORKER_ID ? `data/bus-ts-${process.env.VITEST_WORKER_ID}.db` : "data/bus-ts.db")) {
    this.persistencePath = persistencePath;
    
    // Support in-memory database for testing
    if (persistencePath === ':memory:') {
      this.persistenceDb = new DatabaseSync(':memory:');
    } else {
      mkdirSync(dirname(this.persistencePath), { recursive: true });
      this.persistenceDb = new DatabaseSync(this.persistencePath);
    }
    
    this.persistenceDb.exec(`
      CREATE TABLE IF NOT EXISTS state_snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.initializeRelationalTables();
    this.loadState();
  }

  getThreads(includeArchived: boolean): ThreadRecord[] {
    const rows = this.persistenceDb.prepare(
      `
        SELECT id, topic, status, created_at, system_prompt, template_id
        FROM threads
        ${includeArchived ? "" : "WHERE status != 'archived'"}
        ORDER BY created_at DESC
      `
    ).all() as Array<Record<string, unknown>>;
    return rows
      .map((row) => this.rowToThreadRecord(row))
      .map((thread) => ({
        ...thread,
        waiting_agents: this.getThreadWaitingAgents(thread.id)
      }));
  }

  getMetrics() {
    const threads = this.getThreads(true);
    const agents = this.listAgents();
    let messageCount = 0;
    try {
      const row = this.persistenceDb.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
      messageCount = row.count;
    } catch {}

    const byStatus: Record<string, number> = {};
    for (const t of threads) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    }

    return {
      uptime_seconds: (Date.now() - this.startTime) / 1000,
      started_at: new Date(this.startTime).toISOString(),
      schema_version: "1.0",
      threads: {
        total: threads.length,
        by_status: byStatus
      },
      messages: {
        total: messageCount,
        rate: {
          last_1m: 0,
          last_5m: 0,
          last_15m: 0
        }
      },
      agents: {
        total: agents.length,
        online: agents.filter(a => a.is_online).length
      }
    };
  }

  reset(): void {
    this.sequence = 0;
    this.threads.clear();
    this.threadMessages.clear();
    this.threadParticipants.clear();
    this.threadWaitStates.clear();
    this.agents.clear();
    this.syncTokens.clear();
    this.logEntries.length = 0;
    this.ideSessions.clear();
    this.threadSettings.clear();
    this.messageEditHistory.clear();
    this.ideOwnerInstanceId = null;
    this.logCursor = 0;
    try {
      // Attempt graceful close of DB if available to release file handles used in tests
      // Some sqlite implementations expose a close() method on the DatabaseSync object.
      // If present, call it and recreate an in-memory DB for a clean slate.
      if (typeof (this.persistenceDb as any).close === 'function') {
        try {
          (this.persistenceDb as any).close();
        } catch (e) {
          // ignore close errors during reset
        }
      }
    } finally {
      // Reinitialize persistence DB using the configured persistencePath so
      // tests that call reset() continue to operate against the same file.
      try {
        // Recreate the DatabaseSync using the original persistence path.
        // Some runtimes may throw if the DB was closed; handle gracefully.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any).persistenceDb = new (DatabaseSync as any)(this.persistencePath);
        this.initializeRelationalTables();
        this.persistState();
      } catch (e) {
        // If reinitialization fails, keep internal maps cleared; callers
        // should set an explicit DB path when running in separate processes.
      }
    }
  }

  createThread(topic: string, systemPrompt?: string, templateId?: string): { thread: ThreadRecord; sync: SyncContext } {
    const existing = this.getThreadByTopic(topic);
    if (existing) {
      return { thread: existing, sync: this.issueSyncContext(existing.id) };
    }

    // Apply template defaults if provided
    let finalSystemPrompt = systemPrompt;
    if (templateId && !systemPrompt) {
      const template = this.getTemplate(templateId);
      if (template?.system_prompt) {
        finalSystemPrompt = template.system_prompt;
      }
    }

    const thread: ThreadRecord = {
      id: randomUUID(),
      topic,
      status: "discuss",
      created_at: new Date().toISOString(),
      system_prompt: finalSystemPrompt,
      template_id: templateId
    };
    this.threads.set(thread.id, thread);
    this.threadMessages.set(thread.id, []);
    this.threadParticipants.set(thread.id, new Set());
    this.threadWaitStates.set(thread.id, new Map());
    this.threadSettings.set(thread.id, {
      auto_administrator_enabled: true,
      timeout_seconds: 300,
      switch_timeout_seconds: 300
    });
    this.appendLog(`thread created: ${thread.id} ${topic}`);
    eventBus.emit({ type: "thread.created", payload: thread });
    this.upsertThread(thread);
    this.upsertThreadSettings(thread.id);
    this.persistState();
    return { thread, sync: this.issueSyncContext(thread.id) };
  }

  getThread(threadId: string): ThreadRecord | undefined {
    const row = this.persistenceDb.prepare(
      "SELECT id, topic, status, created_at, system_prompt, template_id FROM threads WHERE id = ?"
    ).get(threadId) as Record<string, unknown> | undefined;
    return row ? this.rowToThreadRecord(row) : undefined;
  }

  setThreadStatus(threadId: string, status: ThreadStatus): boolean {
    const thread = this.getThread(threadId);
    if (!thread) {
      return false;
    }
    this.threads.set(threadId, thread);
    thread.status = status;
    this.appendLog(`thread state updated: ${threadId} ${status}`);
    eventBus.emit({ type: "thread.updated", payload: thread });
    this.upsertThread(thread);
    this.persistState();
    return true;
  }

  deleteThread(threadId: string): boolean {
    const existing = this.getThread(threadId);
    const deleted = Boolean(existing);
    this.threads.delete(threadId);
    this.threadMessages.delete(threadId);
    this.threadParticipants.delete(threadId);
    this.threadWaitStates.delete(threadId);
    this.threadSettings.delete(threadId);
    if (deleted) {
      this.appendLog(`thread deleted: ${threadId}`);
      eventBus.emit({ type: "thread.deleted", payload: { thread_id: threadId } });
      this.persistenceDb.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
      this.persistenceDb.prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
      this.persistenceDb.prepare("DELETE FROM reply_tokens WHERE thread_id = ?").run(threadId);
      this.persistenceDb.prepare("DELETE FROM thread_settings WHERE thread_id = ?").run(threadId);
      this.persistenceDb.prepare("DELETE FROM thread_wait_states WHERE thread_id = ?").run(threadId);
      this.persistState();
    }
    return deleted;
  }

  getMessages(threadId: string, afterSeq: number): MessageRecord[] {
    const rows = this.persistenceDb.prepare(
      `
        SELECT id, thread_id, seq, priority, author, author_id, author_name, author_emoji,
               role, content, metadata, reply_to_msg_id, created_at, edited_at, edit_version
        FROM messages
        WHERE thread_id = ? AND seq > ?
        ORDER BY seq ASC
      `
    ).all(threadId, afterSeq) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToMessageRecord(row));
  }

  waitForMessages(input: { threadId: string; afterSeq: number; agentId?: string; timeoutMs?: number }): {
    messages: MessageRecord[];
    current_seq: number;
    reply_token: string;
    reply_window: number;
    fast_return: boolean;
    fast_return_reason?: string;
  } {
    const thread = this.getThread(input.threadId);
    if (!thread) {
      throw new Error("Thread not found");
    }

    const latestSeq = this.getLatestSeq(input.threadId);
    // Debug: log seq state to help parity test investigation
    try {
      const logLine = `[memoryStore.postMessage] thread=${input.threadId} latestSeq=${latestSeq} globalSequence=${this.sequence}\n`;
      console.log(logLine.trim());
      try { require('node:fs').appendFileSync('C:\\Users\\hankw\\Documents\\AgentChatBus\\tmp_mcp_seq.log', logLine, { encoding: 'utf8' }); } catch (e) {}
    } catch (e) {}
    let fastReturn = false;
    let fastReturnReason: string | undefined;

    // Fast-return Scenario 1: Agent is behind (recovery)
    if (input.afterSeq < latestSeq) {
      fastReturn = true;
      fastReturnReason = "BEHIND";
    }

    // Fast-return Scenario 2: Explicit refresh request
    if (!fastReturn && input.agentId) {
      const refresh = this.getRefreshRequest(input.threadId, input.agentId);
      if (refresh) {
        fastReturn = true;
        fastReturnReason = refresh.reason;
        this.clearRefreshRequest(input.threadId, input.agentId);
      }
    }

    this.pruneExpiredWaitStates(input.threadId);
    if (!fastReturn && input.agentId) {
      this.enterWaitState(input.threadId, input.agentId, input.timeoutMs || 300_000);
      // Update agent activity to msg_wait
      const agent = this.getAgent(input.agentId);
      if (agent) {
        agent.last_activity = 'msg_wait';
        agent.last_activity_time = new Date().toISOString();
        this.upsertAgent(agent);
      }
    }

    const messages = this.getMessages(input.threadId, input.afterSeq);
    const sync = this.issueSyncContext(input.threadId, input.agentId, "msg_wait");
    
    return {
      messages: this.projectMessagesForAgent(messages),
      current_seq: sync.current_seq,
      reply_token: sync.reply_token,
      reply_window: sync.reply_window,
      fast_return: fastReturn,
      fast_return_reason: fastReturnReason
    };
  }

  private projectMessagesForAgent(messages: MessageRecord[]): MessageRecord[] {
    return messages.map(m => this.projectMessageForAgent(m));
  }

  private projectMessageForAgent(msg: MessageRecord): MessageRecord {
    const meta = msg.metadata;
    if (!meta) return msg;

    const visibility = String(meta.visibility || "").toLowerCase();
    const audience = String(meta.audience || "").toLowerCase();
    const isHumanOnly = visibility === "human_only" || audience === "human";

    if (!isHumanOnly) return msg;

    const allowedKeys = ["visibility", "audience", "ui_type", "handoff_target", "target_admin_id", "source_message_id", "decision_type"];
    const projectedMeta: Record<string, any> = {};
    for (const key of allowedKeys) {
      if (key in meta) projectedMeta[key] = meta[key];
    }
    projectedMeta.visibility = projectedMeta.visibility || "human_only";
    projectedMeta.content_hidden = true;
    projectedMeta.content_hidden_reason = "human_only";

    return {
      ...msg,
      content: "[human-only content hidden]",
      metadata: projectedMeta
    };
  }

  postMessage(input: {
    threadId: string;
    author: string;
    content: string;
    role?: string;
    metadata?: Record<string, unknown> | null;
    priority?: string;
    replyToMsgId?: string;
    expectedLastSeq?: number;
    replyToken?: string;
  }): MessageRecord {
    const thread = this.getThread(input.threadId);
    if (!thread) {
      throw new BusError("THREAD_NOT_FOUND");
    }

    const latestSeq = this.getLatestSeq(input.threadId);
    const agent = this.getAgentById(input.author);

    // Strict Sync Logic (UP-14/15/16)
    if (input.expectedLastSeq !== undefined || input.replyToken !== undefined) {
      if (input.expectedLastSeq === undefined || input.replyToken === undefined) {
        throw new MissingSyncFieldsError(input.expectedLastSeq === undefined ? ["expected_last_seq"] : ["reply_token"]);
      }

      const token = this.syncTokens.get(input.replyToken);
      if (!token || token.threadId !== input.threadId) {
        if (agent) this.setRefreshRequest(thread.id, agent.id, "TOKEN_INVALID");
        throw new ReplyTokenInvalidError();
      }

      if (token.status === "consumed") {
        if (agent) this.setRefreshRequest(thread.id, agent.id, "TOKEN_REPLAY");
        throw new ReplyTokenReplayError(token.consumedAt ? new Date(token.consumedAt).toISOString() : undefined);
      }

      if (token.expiresAt < Date.now()) {
        if (agent) this.setRefreshRequest(thread.id, agent.id, "TOKEN_EXPIRED");
        throw new ReplyTokenExpiredError(new Date(token.expiresAt).toISOString());
      }

      // Check seq tolerance (Python logic: new_messages_count > SEQ_TOLERANCE)
      const newMessagesCount = latestSeq - input.expectedLastSeq;
      if (input.expectedLastSeq !== undefined && newMessagesCount > MemoryStore.SEQ_TOLERANCE) {
        if (agent) {
          this.invalidateReplyTokensForAgent(thread.id, agent.id);
          this.setRefreshRequest(thread.id, agent.id, "SEQ_MISMATCH");
        }
        const newMsgs = this.getMessages(thread.id, input.expectedLastSeq);
        throw new SeqMismatchError(input.expectedLastSeq, latestSeq, this.projectMessagesForAgent(newMsgs));
      }

      this.consumeReplyToken(token.token);
    }

    this.sequence += 1;
    const message: MessageRecord = {
      id: randomUUID(),
      thread_id: input.threadId,
      seq: this.sequence,
      priority: input.priority || "normal",
      author: input.author,
      author_id: input.author,
      author_name: input.author,
      author_emoji: "🤖",
      role: input.role || "user",
      content: input.content,
      metadata: input.metadata || null,
      reactions: [],
      edited_at: null,
      edit_version: 1,
      reply_to_msg_id: input.replyToMsgId,
      created_at: new Date().toISOString()
    };

    const messages = this.threadMessages.get(input.threadId) || [];
    messages.push(message);
    this.threadMessages.set(input.threadId, messages);
    this.threadParticipants.get(input.threadId)?.add(input.author);
    this.clearWaitStates(input.threadId);
    
    // 移植自：Python test_agent_registry.py L69-70
    // 更新 agent activity 为 'msg_post'
    if (agent) {
      agent.last_activity = 'msg_post';
      agent.last_activity_time = new Date().toISOString();
      this.upsertAgent(agent);
    }
    
    this.appendLog(`message posted: ${message.id} seq=${message.seq}`);
    eventBus.emit({ type: "msg.new", payload: message });
    this.insertMessage(message);
    this.persistState();
    return message;
  }

  getMessage(messageId: string): MessageRecord | undefined {
    const row = this.persistenceDb.prepare(
      `
        SELECT id, thread_id, seq, priority, author, author_id, author_name, author_emoji,
               role, content, metadata, reply_to_msg_id, created_at, edited_at, edit_version
        FROM messages WHERE id = ?
      `
    ).get(messageId) as Record<string, unknown> | undefined;
    return row ? this.rowToMessageRecord(row) : undefined;
  }

  editMessage(messageId: string, newContent: string, editedBy = "system"): MessageRecord | { no_change: true } | undefined {
    const message = this.getMessage(messageId);
    if (!message) {
      return undefined;
    }
    if (message.content === newContent) {
      return { no_change: true };
    }
    const edits = this.messageEditHistory.get(messageId) || [];
    edits.push({
      version: message.edit_version || 1,
      old_content: message.content,
      edited_by: editedBy,
      created_at: new Date().toISOString()
    });
    this.messageEditHistory.set(messageId, edits);
    message.content = newContent;
    message.edited_at = new Date().toISOString();
    message.edit_version = (message.edit_version || 1) + 1;
    eventBus.emit({ type: "msg.updated", payload: message });
    this.insertMessage(message);
    this.insertMessageEdit(messageId, edits.at(-1));
    this.persistState();
    return message;
  }

  getMessageHistory(messageId: string) {
    const rows = this.persistenceDb.prepare(
      `
        SELECT version, old_content, edited_by, created_at
        FROM message_edits
        WHERE message_id = ?
        ORDER BY version ASC
      `
    ).all(messageId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      version: Number(row.version),
      old_content: String(row.old_content),
      edited_by: String(row.edited_by),
      created_at: String(row.created_at)
    }));
  }

  getReactions(messageId: string) {
    const rows = this.persistenceDb.prepare(
      `
        SELECT agent_id, reaction
        FROM reactions
        WHERE message_id = ?
        ORDER BY reaction ASC, agent_id ASC
      `
    ).all(messageId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      agent_id: String(row.agent_id),
      reaction: String(row.reaction)
    }));
  }

  addReaction(messageId: string, agentId: string, reaction: string): MessageRecord | undefined {
    const message = this.getMessage(messageId);
    if (!message) {
      return undefined;
    }
    const reactions = message.reactions || [];
    if (!reactions.find((item) => item.agent_id === agentId && item.reaction === reaction)) {
      reactions.push({ agent_id: agentId, reaction });
    }
    message.reactions = reactions;
    eventBus.emit({ type: "msg.updated", payload: message });
    this.replaceMessageReactions(messageId, message.reactions || []);
    this.persistState();
    return message;
  }

  removeReaction(messageId: string, agentId: string, reaction: string): { removed: boolean; message?: MessageRecord } | undefined {
    const message = this.getMessage(messageId);
    if (!message) {
      return undefined;
    }
    const before = (message.reactions || []).length;
    message.reactions = (message.reactions || []).filter((item) => !(item.agent_id === agentId && item.reaction === reaction));
    const removed = (message.reactions || []).length !== before;
    if (removed) {
      eventBus.emit({ type: "msg.updated", payload: message });
      this.replaceMessageReactions(messageId, message.reactions || []);
      this.persistState();
    }
    return { removed, message };
  }

  issueSyncContext(threadId: string, agentId?: string, source?: string): SyncContext {
    const currentSeq = this.getLatestSeq(threadId);
    const token = randomUUID();
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 300_000; // 5 minutes

    const record: ReplyTokenRecord = {
      threadId,
      agentId,
      source,
      token,
      issuedAt,
      expiresAt,
      status: "issued"
    };

    this.syncTokens.set(token, record);
    this.upsertReplyToken(record);
    this.persistState();

    return {
      current_seq: currentSeq,
      reply_token: token,
      reply_window: 300
    };
  }

  registerAgent(input: { ide: string; model: string; description?: string; capabilities?: string[]; display_name?: string; skills?: unknown[] }): AgentRecord {
    const agentId = randomUUID();
    const agent: AgentRecord = {
      id: agentId,
      name: `${input.ide} (${input.model})`,
      display_name: input.display_name,
      // 移植自：Python test_agent_registry.py L39 - alias_source 设置为 'user'
      alias_source: input.display_name ? 'user' : undefined,
      ide: input.ide,
      model: input.model,
      description: input.description,
      is_online: true,
      last_heartbeat: new Date().toISOString(),
      last_activity: "registered",
      last_activity_time: new Date().toISOString(),
      capabilities: input.capabilities || [],
      // 移植自：Python test_agent_capabilities.py L90
      // 不带 skills 注册时应该是 undefined，不是空数组
      skills: input.skills ?? undefined,
      token: randomUUID(),
      // 移植自：Python src/main.py::_agent_emoji (L132-140)
      // 基于 agent_id 生成确定性的 emoji
      emoji: generateAgentEmoji(agentId)
    };
    this.agents.set(agent.id, agent);
    this.appendLog(`agent registered: ${agent.id}`);
    eventBus.emit({ type: "agent.updated", payload: agent });
    this.upsertAgent(agent);
    this.persistState();
    return agent;
  }

  listAgents(): AgentRecord[] {
    const rows = this.persistenceDb.prepare(
      `
        SELECT id, name, display_name, alias_source, ide, model, description, is_online, last_heartbeat,
               last_activity, last_activity_time, capabilities, skills, token, emoji
        FROM agents
      `
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToAgentRecord(row));
  }

  getAgent(agentId: string): AgentRecord | undefined {
    const row = this.persistenceDb.prepare(
      `
        SELECT id, name, display_name, alias_source, ide, model, description, is_online, last_heartbeat,
               last_activity, last_activity_time, capabilities, skills, token, emoji
        FROM agents WHERE id = ?
      `
    ).get(agentId) as Record<string, unknown> | undefined;
    return row ? this.rowToAgentRecord(row) : undefined;
  }

  getAgentById(agentId: string): AgentRecord | undefined {
    return this.getAgent(agentId);
  }

  updateAgent(agentId: string, token: string, input: { description?: string; display_name?: string; capabilities?: string[]; skills?: unknown[] }): AgentRecord | undefined {
    const agent = this.getAgent(agentId);
    if (!agent || agent.token !== token) {
      return undefined;
    }
    if (input.description !== undefined) {
      agent.description = input.description;
    }
    if (input.display_name !== undefined) {
      agent.display_name = input.display_name;
    }
    if (input.capabilities !== undefined) {
      agent.capabilities = input.capabilities;
    }
    if (input.skills !== undefined) {
      agent.skills = input.skills;
    }
    agent.last_activity = "updated";
    agent.last_activity_time = new Date().toISOString();
    eventBus.emit({ type: "agent.updated", payload: agent });
    this.upsertAgent(agent);
    this.persistState();
    return agent;
  }

  resumeAgent(agentId: string, token: string): AgentRecord | undefined {
    const agent = this.getAgent(agentId);
    if (!agent || agent.token !== token) {
      // 移植自：Python test_agent_registry.py L83-84
      // 应该抛出 ValueError 而不是返回 undefined
      throw new Error('Invalid agent_id or token');
    }
    agent.is_online = true;
    agent.last_heartbeat = new Date().toISOString();
    // 移植自：Python test_agent_registry.py L46 - 必须是 'resume' 而不是 'resumed'
    agent.last_activity = "resume";
    agent.last_activity_time = agent.last_heartbeat;
    eventBus.emit({ type: "agent.updated", payload: agent });
    this.upsertAgent(agent);
    this.persistState();
    return agent;
  }

  heartbeatAgent(agentId: string, token: string): boolean {
    const agent = this.getAgent(agentId);
    if (!agent || agent.token !== token) {
      return false;
    }
    agent.is_online = true;
    agent.last_heartbeat = new Date().toISOString();
    agent.last_activity = "heartbeat";
    agent.last_activity_time = agent.last_heartbeat;
    eventBus.emit({ type: "agent.updated", payload: agent });
    this.upsertAgent(agent);
    this.persistState();
    return true;
  }

  /**
   * 移植自：Python crud.agent_msg_wait
   * 对应测试：test_agent_registry.py L61-62
   */
  agentMsgWait(agentId: string, token: string): boolean {
    const agent = this.getAgent(agentId);
    if (!agent || agent.token !== token) {
      throw new Error('Invalid agent_id or token');
    }
    
    // 更新 agent activity 为 'msg_wait'
    agent.last_activity = 'msg_wait';
    agent.last_activity_time = new Date().toISOString();
    this.upsertAgent(agent);
    this.persistState();
    
    return true;
  }

  /**
   * 移植自：Python crud._set_agent_activity
   * 对应测试：test_agent_registry.py L102
   */
  updateAgentActivity(agentId: string, activity: string, touchHeartbeat: boolean = false): void {
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error('Agent not found');
    }
    
    agent.last_activity = activity;
    agent.last_activity_time = new Date().toISOString();
    
    if (touchHeartbeat) {
      agent.last_heartbeat = new Date().toISOString();
    }
    
    this.upsertAgent(agent);
    this.persistState();
  }

  unregisterAgent(agentId: string, token: string): boolean {
    const agent = this.getAgent(agentId);
    if (!agent || agent.token !== token) {
      return false;
    }
    agent.is_online = false;
    this.agents.delete(agentId);
    this.appendLog(`agent unregistered: ${agentId}`);
    eventBus.emit({ type: "agent.updated", payload: { id: agentId, is_online: false } });
    this.persistenceDb.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    this.persistenceDb.prepare("DELETE FROM thread_wait_states WHERE agent_id = ?").run(agentId);
    this.persistState();
    return true;
  }

  verifyAgentToken(agentId: string, token: string): boolean {
    const agent = this.getAgent(agentId);
    return agent !== undefined && agent.token === token;
  }

  getThreadAgents(threadId: string): AgentRecord[] {
    const rows = this.persistenceDb.prepare(
      `
        SELECT DISTINCT a.id, a.name, a.display_name, a.ide, a.model, a.description,
               a.is_online, a.last_heartbeat, a.last_activity, a.last_activity_time,
               a.capabilities, a.skills, a.token, a.emoji
        FROM messages m
        JOIN agents a ON a.id = m.author_id
        WHERE m.thread_id = ?
      `
    ).all(threadId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToAgentRecord(row));
  }

  getThreadWaitingAgents(threadId: string): Array<{ id: string; display_name?: string; emoji?: string }> {
    this.pruneExpiredWaitStates(threadId);
    const rows = this.persistenceDb.prepare(
      `
        SELECT a.id, a.display_name, a.name
        FROM thread_wait_states w
        JOIN agents a ON a.id = w.agent_id
        WHERE w.thread_id = ? AND a.is_online = 1
      `
    ).all(threadId) as Array<Record<string, unknown>>;
    return rows
      .map((agent) => ({
        id: String(agent.id),
        display_name: agent.display_name ? String(agent.display_name) : String(agent.name),
        emoji: "🤖"
      }));
  }

  getSettings() {
    return {
      preferred_language: "English",
      content_filter_enabled: true,
      heartbeat_timeout_seconds: 30,
      SHOW_AD: false
    };
  }

  getTemplates() {
    // Built-in templates (UP-18)
    const builtinTemplates = [
      {
        id: "default",
        name: "Default Discussion",
        description: "Standard discussion thread with auto-admin enabled",
        is_builtin: true,
        system_prompt: "You are a helpful AI assistant collaborating with other agents and humans. Follow the thread's coordination rules.",
        default_metadata: {},
        created_at: new Date().toISOString()
      },
      {
        id: "implement",
        name: "Implementation Task",
        description: "Focused implementation thread with extended timeout",
        is_builtin: true,
        system_prompt: "You are an implementation specialist. Focus on producing working code and tests.",
        default_metadata: { task_type: "implementation" },
        created_at: new Date().toISOString()
      },
      {
        id: "review",
        name: "Code Review",
        description: "Code review thread with strict validation",
        is_builtin: true,
        system_prompt: "You are a code reviewer. Critically analyze the code for bugs, security issues, and best practices.",
        default_metadata: { task_type: "review" },
        created_at: new Date().toISOString()
      }
    ];

    // Load custom templates from database
    try {
      const rows = this.persistenceDb.prepare(
        "SELECT id, name, description, system_prompt, default_metadata, is_builtin, created_at FROM templates ORDER BY created_at ASC"
      ).all() as Array<Record<string, unknown>>;
      
      const customTemplates = rows.map(row => ({
        id: String(row.id),
        name: String(row.name),
        description: String(row.description),
        system_prompt: row.system_prompt ? String(row.system_prompt) : undefined,
        default_metadata: row.default_metadata ? JSON.parse(String(row.default_metadata)) as Record<string, unknown> : undefined,
        is_builtin: Boolean(row.is_builtin),
        created_at: String(row.created_at)
      }));

      return [...builtinTemplates, ...customTemplates];
    } catch {
      return builtinTemplates;
    }
  }

  getTemplate(templateId: string): ReturnType<typeof this.getTemplates>[number] | undefined {
    const templates = this.getTemplates();
    return templates.find(t => t.id === templateId);
  }

  getThreadSettings(threadId: string) {
    const row = this.persistenceDb.prepare(
      `
        SELECT thread_id, auto_administrator_enabled, timeout_seconds, switch_timeout_seconds
        FROM thread_settings WHERE thread_id = ?
      `
    ).get(threadId) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return {
      auto_administrator_enabled: Boolean(row.auto_administrator_enabled),
      timeout_seconds: Number(row.timeout_seconds),
      switch_timeout_seconds: Number(row.switch_timeout_seconds)
    };
  }

  updateThreadSettings(threadId: string, input: { auto_administrator_enabled?: boolean; timeout_seconds?: number; switch_timeout_seconds?: number }) {
    const existing = this.getThreadSettings(threadId);
    if (!existing) {
      return undefined;
    }
    if (input.auto_administrator_enabled !== undefined) {
      existing.auto_administrator_enabled = input.auto_administrator_enabled;
    }
    if (input.timeout_seconds !== undefined) {
      existing.timeout_seconds = input.timeout_seconds;
    }
    if (input.switch_timeout_seconds !== undefined) {
      existing.switch_timeout_seconds = input.switch_timeout_seconds;
    }
    this.threadSettings.set(threadId, existing);
    this.upsertThreadSettings(threadId);
    this.persistState();
    return existing;
  }

  searchMessages(query: string): MessageRecord[] {
    const normalized = query.toLowerCase();
    const rows = this.persistenceDb.prepare(
      `
        SELECT id, thread_id, seq, priority, author, author_id, author_name, author_emoji,
               role, content, metadata, reply_to_msg_id, created_at, edited_at, edit_version
        FROM messages
        WHERE LOWER(content) LIKE ?
        ORDER BY seq ASC
      `
    ).all(`%${normalized}%`) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToMessageRecord(row));
  }

  createTemplate(input: { id: string; name: string; description?: string; system_prompt?: string; default_metadata?: Record<string, unknown> }): boolean {
    try {
      // Check if builtin template with same id exists
      const builtinTemplates = this.getTemplates().filter(t => t.is_builtin);
      if (builtinTemplates.some(t => t.id === input.id)) {
        throw new Error(`Built-in template '${input.id}' already exists`);
      }

      this.persistenceDb.prepare(
        `
          INSERT INTO templates (id, name, description, system_prompt, default_metadata, is_builtin, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            system_prompt = excluded.system_prompt,
            default_metadata = excluded.default_metadata
        `
      ).run(
        input.id,
        input.name,
        input.description || null,
        input.system_prompt || null,
        input.default_metadata ? JSON.stringify(input.default_metadata) : null,
        new Date().toISOString()
      );
      return true;
    } catch (error) {
      console.error("Failed to create template:", error);
      return false;
    }
  }

  getLogs(after: number, limit: number): { entries: Array<{ id: number; line: string }>; next_cursor: number } {
    const entries = this.logEntries.filter((entry) => entry.id > after).slice(0, limit);
    return {
      entries,
      next_cursor: entries.at(-1)?.id || after
    };
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      pid: process.pid,
      startupMode: "ts-sidecar",
      version: "0.0.1",
      transport: "http+sse"
    };
  }

  registerIde(body: { instance_id: string; ide_label: string }): IdeSessionState {
    const now = new Date().toISOString();
    const existing = this.ideSessions.get(body.instance_id);
    const sessionToken = existing?.sessionToken || randomUUID();
    this.ideSessions.set(body.instance_id, {
      instanceId: body.instance_id,
      ideLabel: body.ide_label,
      sessionToken,
      registeredAt: existing?.registeredAt || now,
      lastSeen: now
    });
    if (!this.ideOwnerInstanceId) {
      this.ideOwnerInstanceId = body.instance_id;
    }
    this.persistState();
    return this.snapshotIde(body.instance_id, sessionToken);
  }

  getIdeStatus(instanceId?: string, sessionToken?: string): IdeSessionState {
    if (!instanceId) {
      return {
        instance_id: null,
        session_token: sessionToken || null,
        owner_instance_id: this.ideOwnerInstanceId,
        owner_ide_label: this.ideOwnerInstanceId ? this.ideSessions.get(this.ideOwnerInstanceId)?.ideLabel || null : null,
        registered_sessions_count: this.ideSessions.size,
        can_shutdown: false,
        is_owner: false,
        registered: false
      };
    }

    const session = this.ideSessions.get(instanceId);
    if (!session) {
      return {
        instance_id: instanceId,
        session_token: sessionToken || null,
        owner_instance_id: this.ideOwnerInstanceId,
        owner_ide_label: this.ideOwnerInstanceId ? this.ideSessions.get(this.ideOwnerInstanceId)?.ideLabel || null : null,
        registered_sessions_count: this.ideSessions.size,
        can_shutdown: false,
        is_owner: false,
        registered: false
      };
    }

    return this.snapshotIde(instanceId, session.sessionToken);
  }

  kickAgent(agentId: string): { ok: boolean; agent_id: string; sessions_disconnected_count: number; threads_interrupted: string[] } {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { ok: false, agent_id: agentId, sessions_disconnected_count: 0, threads_interrupted: [] };
    }
    const threadsInterrupted: string[] = [];
    for (const [threadId, waits] of this.threadWaitStates.entries()) {
      if (waits.delete(agentId)) {
        threadsInterrupted.push(threadId);
      }
    }
    agent.is_online = false;
    agent.last_activity = "kicked";
    agent.last_activity_time = new Date().toISOString();
    eventBus.emit({ type: "agent.updated", payload: agent });
    this.persistState();
    return { ok: true, agent_id: agentId, sessions_disconnected_count: 0, threads_interrupted: threadsInterrupted };
  }

  ideHeartbeat(body: { instance_id: string; session_token: string }): IdeSessionState {
    const session = this.ideSessions.get(body.instance_id);
    if (!session || session.sessionToken !== body.session_token) {
      throw new Error("Invalid IDE session");
    }
    session.lastSeen = new Date().toISOString();
    this.persistState();
    return this.snapshotIde(body.instance_id, session.sessionToken);
  }

  ideUnregister(body: { instance_id: string; session_token: string }): IdeSessionState {
    const session = this.ideSessions.get(body.instance_id);
    if (!session || session.sessionToken !== body.session_token) {
      throw new Error("Invalid IDE session");
    }
    this.ideSessions.delete(body.instance_id);
    if (this.ideOwnerInstanceId === body.instance_id) {
      this.ideOwnerInstanceId = this.ideSessions.keys().next().value || null;
    }
    this.persistState();
    return {
      instance_id: body.instance_id,
      registered: false,
      is_owner: false,
      can_shutdown: false,
      owner_instance_id: this.ideOwnerInstanceId,
      owner_ide_label: this.ideOwnerInstanceId ? this.ideSessions.get(this.ideOwnerInstanceId)?.ideLabel || null : null,
      registered_sessions_count: this.ideSessions.size,
      shutdown_requested: this.ideSessions.size === 0,
      transferred_to: this.ideOwnerInstanceId,
      was_owner: false
    };
  }

  private snapshotIde(instanceId: string, sessionToken: string): IdeSessionState {
    return {
      instance_id: instanceId,
      session_token: sessionToken,
      registered: true,
      ownership_assignable: true,
      owner_instance_id: this.ideOwnerInstanceId,
      owner_ide_label: this.ideOwnerInstanceId ? this.ideSessions.get(this.ideOwnerInstanceId)?.ideLabel || null : null,
      is_owner: this.ideOwnerInstanceId === instanceId,
      can_shutdown: this.ideOwnerInstanceId === instanceId,
      registered_sessions_count: this.ideSessions.size,
      shutdown_requested: false,
      transferred_to: null,
      was_owner: false
    };
  }

  private consumeReplyToken(token: string): void {
    const found = this.syncTokens.get(token);
    if (!found) return;

    found.status = "consumed";
    found.consumedAt = Date.now();
    this.upsertReplyToken(found);
    this.persistState();
  }

  private enterWaitState(threadId: string, agentId: string, timeoutMs: number): void {
    const waits = this.threadWaitStates.get(threadId) || new Map<string, WaitStateRecord>();
    waits.set(agentId, {
      agentId,
      enteredAt: new Date().toISOString(),
      timeoutMs
    });
    this.threadWaitStates.set(threadId, waits);
    this.replaceThreadWaitStates(threadId);
    this.persistState();
  }

  private clearWaitStates(threadId: string): void {
    this.threadWaitStates.set(threadId, new Map());
    this.replaceThreadWaitStates(threadId);
    this.persistState();
  }

  exitWaitState(threadId: string, agentId: string): void {
    const waits = this.threadWaitStates.get(threadId);
    if (waits) {
      waits.delete(agentId);
      this.replaceThreadWaitStates(threadId);
      this.persistState();
    }
  }

  private pruneExpiredWaitStates(threadId: string): void {
    const waits = this.threadWaitStates.get(threadId);
    if (!waits || waits.size === 0) {
      return;
    }
    const now = Date.now();
    let changed = false;
    for (const [agentId, wait] of waits.entries()) {
      const entered = Date.parse(wait.enteredAt);
      if (Number.isFinite(entered) && entered + wait.timeoutMs <= now) {
        waits.delete(agentId);
        changed = true;
      }
    }
    if (changed) {
      this.replaceThreadWaitStates(threadId);
      this.persistState();
    }
  }

  private rowToThreadRecord(row: Record<string, unknown>): ThreadRecord {
    return {
      id: String(row.id),
      topic: String(row.topic),
      status: row.status as ThreadStatus,
      created_at: String(row.created_at),
      system_prompt: row.system_prompt ? String(row.system_prompt) : undefined,
      template_id: row.template_id ? String(row.template_id) : undefined
    };
  }

  private getLatestSeq(threadId: string): number {
    const row = this.persistenceDb.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS current_seq FROM messages WHERE thread_id = ?"
    ).get(threadId) as { current_seq?: number } | undefined;
    return Number(row?.current_seq || 0);
  }

  private getThreadByTopic(topic: string): ThreadRecord | undefined {
    const row = this.persistenceDb.prepare(
      "SELECT id, topic, status, created_at, system_prompt, template_id FROM threads WHERE topic = ?"
    ).get(topic) as Record<string, unknown> | undefined;
    return row ? this.rowToThreadRecord(row) : undefined;
  }

  private rowToMessageRecord(row: Record<string, unknown>): MessageRecord {
    return {
      id: String(row.id),
      thread_id: String(row.thread_id),
      seq: Number(row.seq),
      priority: String(row.priority || "normal"),
      author: String(row.author),
      author_id: row.author_id ? String(row.author_id) : undefined,
      author_name: row.author_name ? String(row.author_name) : undefined,
      author_emoji: row.author_emoji ? String(row.author_emoji) : undefined,
      role: String(row.role),
      content: String(row.content),
      metadata: row.metadata ? JSON.parse(String(row.metadata)) as Record<string, unknown> : null,
      reply_to_msg_id: row.reply_to_msg_id ? String(row.reply_to_msg_id) : undefined,
      created_at: String(row.created_at),
      edited_at: row.edited_at ? String(row.edited_at) : null,
      edit_version: row.edit_version ? Number(row.edit_version) : undefined
    };
  }

  private rowToAgentRecord(row: Record<string, unknown>): AgentRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      display_name: row.display_name ? String(row.display_name) : undefined,
      // 移植自：Python test_agent_registry.py L39
      alias_source: row.alias_source ? String(row.alias_source) : undefined,
      ide: row.ide ? String(row.ide) : undefined,
      model: row.model ? String(row.model) : undefined,
      description: row.description ? String(row.description) : undefined,
      is_online: Boolean(row.is_online),
      last_heartbeat: String(row.last_heartbeat),
      last_activity: row.last_activity ? String(row.last_activity) : undefined,
      last_activity_time: row.last_activity_time ? String(row.last_activity_time) : undefined,
      // 移植自：Python test_agent_capabilities.py L90
      // capabilities 默认为空数组，skills 默认为 undefined
      capabilities: row.capabilities ? JSON.parse(String(row.capabilities)) as string[] : [],
      skills: row.skills && String(row.skills).trim() !== '' && String(row.skills) !== 'null' 
        ? JSON.parse(String(row.skills)) as unknown[] 
        : undefined,
      token: String(row.token),
      emoji: row.emoji ? String(row.emoji) : undefined
    };
  }

  private loadState(): void {
    try {
      const row = this.persistenceDb
        .prepare("SELECT payload FROM state_snapshots WHERE id = 1")
        .get() as { payload?: string } | undefined;
      if (row?.payload) {
        const state = JSON.parse(row.payload) as PersistedState;
        this.sequence = state.sequence || 0;
        for (const thread of state.threads || []) {
          this.threads.set(thread.id, thread);
        }
        for (const [threadId, messages] of state.threadMessages || []) {
          this.threadMessages.set(threadId, messages);
        }
        for (const [threadId, participants] of state.threadParticipants || []) {
          this.threadParticipants.set(threadId, new Set(participants));
        }
        for (const [threadId, waits] of state.threadWaitStates || []) {
          this.threadWaitStates.set(threadId, new Map(waits));
        }
        for (const agent of state.agents || []) {
          this.agents.set(agent.id, agent);
        }
        for (const token of state.syncTokens || []) {
          this.syncTokens.set(token.token, token);
        }
        this.logEntries.push(...(state.logEntries || []));
        for (const session of state.ideSessions || []) {
          this.ideSessions.set(session.instanceId, session);
        }
        this.ideOwnerInstanceId = state.ideOwnerInstanceId || null;
        this.logCursor = state.logCursor || 0;
        for (const [threadId, settings] of state.threadSettings || []) {
          this.threadSettings.set(threadId, settings);
        }
        for (const [messageId, history] of state.messageEditHistory || []) {
          this.messageEditHistory.set(messageId, history);
        }
      }
      this.hydrateFromRelationalTables();
    } catch {
      // Ignore invalid persisted state for the initial prototype.
      this.hydrateFromRelationalTables();
    }
  }

  private persistState(): void {
    try {
      const state: PersistedState = {
        sequence: this.sequence,
        threads: [...this.threads.values()],
        threadMessages: [...this.threadMessages.entries()],
        threadParticipants: [...this.threadParticipants.entries()].map(([threadId, participants]) => [threadId, [...participants]]),
        threadWaitStates: [...this.threadWaitStates.entries()].map(([threadId, waits]) => [threadId, [...waits.entries()]]),
        agents: [...this.agents.values()],
        syncTokens: [...this.syncTokens.values()],
        logEntries: this.logEntries,
        ideSessions: [...this.ideSessions.values()],
        ideOwnerInstanceId: this.ideOwnerInstanceId,
        logCursor: this.logCursor,
        threadSettings: [...this.threadSettings.entries()],
        messageEditHistory: [...this.messageEditHistory.entries()]
      };
      this.persistenceDb.prepare(
        `
          INSERT INTO state_snapshots (id, payload, updated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            payload = excluded.payload,
            updated_at = excluded.updated_at
        `
      ).run(JSON.stringify(state), new Date().toISOString());
    } catch {
      // Ignore persistence failures for the initial prototype.
    }
  }

  private hydrateFromRelationalTables(): void {
    this.threads.clear();
    this.threadMessages.clear();
    this.agents.clear();
    this.syncTokens.clear();
    this.threadSettings.clear();
    this.threadWaitStates.clear();
    this.messageEditHistory.clear();

    const threads = this.persistenceDb.prepare(
      "SELECT id, topic, status, created_at, system_prompt, template_id FROM threads"
    ).all() as Array<Record<string, unknown>>;
    for (const row of threads) {
      const thread = this.rowToThreadRecord(row);
      this.threads.set(thread.id, thread);
    }

    const messages = this.persistenceDb.prepare(
      `
        SELECT id, thread_id, seq, priority, author, author_id, author_name, author_emoji,
               role, content, metadata, reply_to_msg_id, created_at, edited_at, edit_version
        FROM messages
        ORDER BY seq ASC
      `
    ).all() as Array<Record<string, unknown>>;
    for (const row of messages) {
      const message = this.rowToMessageRecord(row);
      const group = this.threadMessages.get(message.thread_id) || [];
      group.push(message);
      this.threadMessages.set(message.thread_id, group);
    }

    const agents = this.persistenceDb.prepare(
      `
        SELECT id, name, display_name, ide, model, description, is_online, last_heartbeat,
               last_activity, last_activity_time, capabilities, skills, token, emoji
        FROM agents
      `
    ).all() as Array<Record<string, unknown>>;
    for (const row of agents) {
      const agent = this.rowToAgentRecord(row);
      this.agents.set(agent.id, agent);
    }

    const tokens = this.persistenceDb.prepare(
      "SELECT token, thread_id, agent_id, source, issued_at, expires_at, consumed_at, status FROM reply_tokens"
    ).all() as Array<Record<string, unknown>>;
    for (const row of tokens) {
      this.syncTokens.set(String(row.token), {
        token: String(row.token),
        threadId: String(row.thread_id),
        agentId: row.agent_id ? String(row.agent_id) : undefined,
        source: row.source ? String(row.source) : undefined,
        issuedAt: Number(row.issued_at),
        expiresAt: Number(row.expires_at),
        consumedAt: row.consumed_at ? Number(row.consumed_at) : undefined,
        status: String(row.status) as "issued" | "consumed"
      });
    }

    const settings = this.persistenceDb.prepare(
      "SELECT thread_id, auto_administrator_enabled, timeout_seconds, switch_timeout_seconds FROM thread_settings"
    ).all() as Array<Record<string, unknown>>;
    for (const row of settings) {
      this.threadSettings.set(String(row.thread_id), {
        auto_administrator_enabled: Boolean(row.auto_administrator_enabled),
        timeout_seconds: Number(row.timeout_seconds),
        switch_timeout_seconds: Number(row.switch_timeout_seconds)
      });
    }

    const waits = this.persistenceDb.prepare(
      "SELECT thread_id, agent_id, entered_at, timeout_ms FROM thread_wait_states"
    ).all() as Array<Record<string, unknown>>;
    for (const row of waits) {
      const threadId = String(row.thread_id);
      const threadWaits = this.threadWaitStates.get(threadId) || new Map<string, WaitStateRecord>();
      threadWaits.set(String(row.agent_id), {
        agentId: String(row.agent_id),
        enteredAt: String(row.entered_at),
        timeoutMs: Number(row.timeout_ms)
      });
      this.threadWaitStates.set(threadId, threadWaits);
    }

    const edits = this.persistenceDb.prepare(
      "SELECT message_id, version, old_content, edited_by, created_at FROM message_edits ORDER BY version ASC"
    ).all() as Array<Record<string, unknown>>;
    for (const row of edits) {
      const messageId = String(row.message_id);
      const history = this.messageEditHistory.get(messageId) || [];
      history.push({
        version: Number(row.version),
        old_content: String(row.old_content),
        edited_by: String(row.edited_by),
        created_at: String(row.created_at)
      });
      this.messageEditHistory.set(messageId, history);
    }

    this.sequence = Math.max(this.sequence, ...messages.map((row) => Number(row.seq || 0)), 0);
  }

  private initializeRelationalTables(): void {
    this.persistenceDb.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        system_prompt TEXT,
        template_id TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        priority TEXT NOT NULL,
        author TEXT NOT NULL,
        author_id TEXT,
        author_name TEXT,
        author_emoji TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        reply_to_msg_id TEXT,
        created_at TEXT NOT NULL,
        edited_at TEXT,
        edit_version INTEGER
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT,
        alias_source TEXT,
        ide TEXT,
        model TEXT,
        description TEXT,
        is_online INTEGER NOT NULL,
        last_heartbeat TEXT NOT NULL,
        last_activity TEXT,
        last_activity_time TEXT,
        capabilities TEXT,
        skills TEXT,
        token TEXT NOT NULL,
        emoji TEXT
      );
      CREATE TABLE IF NOT EXISTS reply_tokens (
        token TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        agent_id TEXT,
        source TEXT,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS msg_wait_refresh_requests (
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS thread_settings (
        thread_id TEXT PRIMARY KEY,
        auto_administrator_enabled INTEGER NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        switch_timeout_seconds INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_wait_states (
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        entered_at TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        PRIMARY KEY (thread_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS message_edits (
        message_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        old_content TEXT NOT NULL,
        edited_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reactions (
        message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        reaction TEXT NOT NULL,
        PRIMARY KEY (message_id, agent_id, reaction)
      );
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        system_prompt TEXT,
        default_metadata TEXT,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);

    // Proactive Migration: Handle existing databases lacking new columns
    try {
      const columns = this.persistenceDb.prepare("PRAGMA table_info(reply_tokens)").all() as Array<{ name: string }>;
      const names = columns.map(c => c.name);
      if (names.length > 0) {
        if (!names.includes("agent_id")) {
          this.persistenceDb.exec("ALTER TABLE reply_tokens ADD COLUMN agent_id TEXT");
        }
        if (!names.includes("source")) {
          this.persistenceDb.exec("ALTER TABLE reply_tokens ADD COLUMN source TEXT");
        }
      }
      
      const agentCols = this.persistenceDb.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
      const agentColNames = agentCols.map(c => c.name);
      if (agentColNames.length > 0 && !agentColNames.includes("emoji")) {
          this.persistenceDb.exec("ALTER TABLE agents ADD COLUMN emoji TEXT");
      }
    } catch {
      // Table might not exist yet; initializeRelationalTables already handled CREATE
    }
  }

  private upsertThread(thread: ThreadRecord): void {
    this.persistenceDb.prepare(
      `
        INSERT INTO threads (id, topic, status, created_at, system_prompt, template_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          topic = excluded.topic,
          status = excluded.status,
          created_at = excluded.created_at,
          system_prompt = excluded.system_prompt,
          template_id = excluded.template_id
      `
    ).run(thread.id, thread.topic, thread.status, thread.created_at, thread.system_prompt || null, thread.template_id || null);
  }

  private insertMessage(message: MessageRecord): void {
    this.persistenceDb.prepare(
      `
        INSERT OR REPLACE INTO messages (
          id, thread_id, seq, priority, author, author_id, author_name, author_emoji,
          role, content, metadata, reply_to_msg_id, created_at, edited_at, edit_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      message.id,
      message.thread_id,
      message.seq,
      message.priority,
      message.author,
      message.author_id || null,
      message.author_name || null,
      message.author_emoji || null,
      message.role,
      message.content,
      message.metadata ? JSON.stringify(message.metadata) : null,
      message.reply_to_msg_id || null,
      message.created_at,
      message.edited_at || null,
      message.edit_version || null
    );
  }

  private upsertAgent(agent: AgentRecord): void {
    this.persistenceDb.prepare(
      `
        INSERT INTO agents (
          id, name, display_name, ide, model, description, is_online, last_heartbeat,
          last_activity, last_activity_time, capabilities, skills, token, emoji
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          display_name = excluded.display_name,
          ide = excluded.ide,
          model = excluded.model,
          description = excluded.description,
          is_online = excluded.is_online,
          last_heartbeat = excluded.last_heartbeat,
          last_activity = excluded.last_activity,
          last_activity_time = excluded.last_activity_time,
          capabilities = excluded.capabilities,
          skills = excluded.skills,
          token = excluded.token,
          emoji = excluded.emoji
      `
    ).run(
      agent.id,
      agent.name,
      agent.display_name || null,
      agent.ide || null,
      agent.model || null,
      agent.description || null,
      agent.is_online ? 1 : 0,
      agent.last_heartbeat,
      agent.last_activity || null,
      agent.last_activity_time || null,
      JSON.stringify(agent.capabilities || []),
      // 移植自：Python test_agent_capabilities.py L90
      // skills 为 undefined 时存储 null，不是 '[]'
      agent.skills ? JSON.stringify(agent.skills) : null,
      agent.token,
      agent.emoji || null
    );
  }

  private upsertReplyToken(token: ReplyTokenRecord): void {
    this.persistenceDb.prepare(
      `
        INSERT INTO reply_tokens (token, thread_id, agent_id, source, issued_at, expires_at, consumed_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET
          thread_id = excluded.thread_id,
          agent_id = excluded.agent_id,
          source = excluded.source,
          issued_at = excluded.issued_at,
          expires_at = excluded.expires_at,
          consumed_at = excluded.consumed_at,
          status = excluded.status
      `
    ).run(token.token, token.threadId, token.agentId || null, token.source || null, token.issuedAt, token.expiresAt, token.consumedAt || null, token.status);
  }

  private upsertThreadSettings(threadId: string): void {
    const settings = this.threadSettings.get(threadId);
    if (!settings) {
      return;
    }
    this.persistenceDb.prepare(
      `
        INSERT INTO thread_settings (thread_id, auto_administrator_enabled, timeout_seconds, switch_timeout_seconds)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          auto_administrator_enabled = excluded.auto_administrator_enabled,
          timeout_seconds = excluded.timeout_seconds,
          switch_timeout_seconds = excluded.switch_timeout_seconds
      `
    ).run(threadId, settings.auto_administrator_enabled ? 1 : 0, settings.timeout_seconds, settings.switch_timeout_seconds);
  }

  private replaceThreadWaitStates(threadId: string): void {
    this.persistenceDb.prepare("DELETE FROM thread_wait_states WHERE thread_id = ?").run(threadId);
    const waits = this.threadWaitStates.get(threadId);
    if (!waits) {
      return;
    }
    const insert = this.persistenceDb.prepare(
      "INSERT INTO thread_wait_states (thread_id, agent_id, entered_at, timeout_ms) VALUES (?, ?, ?, ?)"
    );
    for (const wait of waits.values()) {
      insert.run(threadId, wait.agentId, wait.enteredAt, wait.timeoutMs);
    }
  }

  private insertMessageEdit(
    messageId: string,
    edit: { version: number; old_content: string; edited_by: string; created_at: string } | undefined
  ): void {
    if (!edit) {
      return;
    }
    this.persistenceDb.prepare(
      "INSERT INTO message_edits (message_id, version, old_content, edited_by, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(messageId, edit.version, edit.old_content, edit.edited_by, edit.created_at);
  }

  private replaceMessageReactions(messageId: string, reactions: Array<{ agent_id: string; reaction: string }>): void {
    this.persistenceDb.prepare("DELETE FROM reactions WHERE message_id = ?").run(messageId);
    const insert = this.persistenceDb.prepare(
      "INSERT INTO reactions (message_id, agent_id, reaction) VALUES (?, ?, ?)"
    );
    for (const reaction of reactions) {
      insert.run(messageId, reaction.agent_id, reaction.reaction);
    }
  }

  getReaction(messageId: string, agentId: string, reaction: string): boolean {
    const row = this.persistenceDb.prepare(
      "SELECT 1 FROM reactions WHERE message_id = ? AND agent_id = ? AND reaction = ?"
    ).get(messageId, agentId, reaction) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  private setRefreshRequest(threadId: string, agentId: string, reason: string): void {
    this.persistenceDb.prepare(
      "INSERT OR REPLACE INTO msg_wait_refresh_requests (thread_id, agent_id, reason, created_at) VALUES (?, ?, ?, ?)"
    ).run(threadId, agentId, reason, new Date().toISOString());
  }

  private getRefreshRequest(threadId: string, agentId: string): RefreshRequestRecord | undefined {
    const row = this.persistenceDb.prepare(
      "SELECT thread_id, agent_id, reason, created_at FROM msg_wait_refresh_requests WHERE thread_id = ? AND agent_id = ?"
    ).get(threadId, agentId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      threadId: String(row.thread_id),
      agentId: String(row.agent_id),
      reason: String(row.reason),
      createdAt: String(row.created_at)
    };
  }

  private clearRefreshRequest(threadId: string, agentId: string): void {
    this.persistenceDb.prepare(
      "DELETE FROM msg_wait_refresh_requests WHERE thread_id = ? AND agent_id = ?"
    ).run(threadId, agentId);
  }

  invalidateReplyTokensForAgentSource(threadId: string, agentId: string, source: string): void {
    const tokens = [...this.syncTokens.values()].filter(
      t => t.threadId === threadId && t.agentId === agentId && t.source === source && t.status === "issued"
    );
    for (const t of tokens) {
      t.status = "consumed";
      t.consumedAt = Date.now();
      this.upsertReplyToken(t);
    }
    this.persistState();
  }

  private invalidateReplyTokensForAgent(threadId: string, agentId: string): void {
    const tokens = [...this.syncTokens.values()].filter(
      t => t.threadId === threadId && t.agentId === agentId && t.status === "issued"
    );
    for (const t of tokens) {
      t.status = "consumed";
      t.consumedAt = Date.now();
      this.upsertReplyToken(t);
    }
    this.persistState();
  }

  invalidateReplyTokensForAgentExcept(threadId: string, agentId: string, keepToken: string): void {
    const tokens = [...this.syncTokens.values()].filter(
      t => t.threadId === threadId && t.agentId === agentId && t.status === "issued" && t.token !== keepToken
    );
    for (const t of tokens) {
      t.status = "consumed";
      t.consumedAt = Date.now();
      this.upsertReplyToken(t);
    }
    this.persistState();
  }

  getLatestIssuedToken(threadId: string, agentId: string): ReplyTokenRecord | undefined {
    const tokens = [...this.syncTokens.values()]
      .filter(t => t.threadId === threadId && t.agentId === agentId && t.status === "issued")
      .sort((a, b) => b.issuedAt - a.issuedAt);
    return tokens.length > 0 ? tokens[0] : undefined;
  }

  private appendLog(line: string): void {
    this.logCursor += 1;
    this.logEntries.push({ id: this.logCursor, line });
  }

  // Close underlying persistence DB if supported by the runtime.
  // Tests on Windows require explicit DB close before unlinking files.
  close(): void {
    try {
      const dbAny = this.persistenceDb as any;
      if (dbAny && typeof dbAny.close === 'function') {
        try {
          dbAny.close();
        } catch (e) {
          // ignore close errors
        }
      }
    } catch (e) {
      // swallow
    }
  }
}

export const memoryStore = new MemoryStore();
// Register the default global instance so other modules can resolve the active store.
try { registerStore(memoryStore); } catch (e) { }