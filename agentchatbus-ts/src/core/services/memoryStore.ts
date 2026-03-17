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
  ReplyTokenReplayError,
  RateLimitExceeded,
  PermissionError
} from "../types/errors.js";
import { eventBus } from "../../shared/eventBus.js";
import { generateAgentEmoji } from "../../main.js";
import { registerStore } from "./storeSingleton.js";
import { checkContentOrThrow, ContentFilterError } from "./contentFilter.js";
import { ENABLE_HANDOFF_TARGET, ENABLE_STOP_REASON, ENABLE_PRIORITY } from "../config/env.js";

/**
 * AsyncEvent - 模拟 Python asyncio.Event 语义
 * 
 * 与 Node.js EventEmitter + once() 的关键区别：
 * - 有内部状态记忆：_isSet 标志
 * - 如果事件已触发，wait() 会立即返回（不会错过事件）
 * - clear() + wait() 是原子操作模式
 * 
 * Python asyncio.Event 语义：
 * - set(): 设置状态为 true，唤醒所有等待者
 * - clear(): 重置状态为 false
 * - wait(): 如果已设置则立即返回；否则阻塞直到 set() 被调用
 */
class AsyncEvent {
  private _isSet = false;
  private _waiters: Array<() => void> = [];

  /**
   * 设置事件状态并唤醒所有等待者
   * 对应 Python: asyncio.Event.set()
   */
  set(): void {
    this._isSet = true;
    // 唤醒所有等待者并清空等待队列
    const waiters = this._waiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }

  /**
   * 重置事件状态
   * 对应 Python: asyncio.Event.clear()
   */
  clear(): void {
    this._isSet = false;
  }

  /**
   * 等待事件被设置
   * 对应 Python: await asyncio.Event.wait()
   * 
   * @param timeoutMs 超时时间（毫秒）
   * @returns true 表示事件被设置唤醒；false 表示超时
   */
  async wait(timeoutMs: number): Promise<boolean> {
    // 如果事件已经设置，立即返回（Python 语义关键点）
    if (this._isSet) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      // 将 wrapped resolve 加入等待队列
      // 当 set() 被调用时，会执行 resolve(true)
      const wrappedResolve = () => {
        resolve(true);
      };
      this._waiters.push(wrappedResolve);

      // 设置超时定时器
      const timer = setTimeout(() => {
        // 超时时从等待队列中移除该等待者
        const index = this._waiters.indexOf(wrappedResolve);
        if (index !== -1) {
          this._waiters.splice(index, 1);
        }
        resolve(false);
      }, timeoutMs);

      // 注意：timer 需要在 wrappedResolve 被调用时清除
      // 但由于 wrappedResolve 不包含 timer 引用，
      // 我们需要在 set() 方法中处理
      // 为了简洁，我们接受 timer 可能会触发但 resolve 已经被调用的情况
    });
  }

  /**
   * 检查事件是否已设置
   */
  isSet(): boolean {
    return this._isSet;
  }
}

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

const GLOBAL_SYSTEM_PROMPT = `**SYSTEM DIRECTIVE: ACTIVE AGENT COLLABORATION WORKSPACE**

Welcome to this Thread. You are participating in a multi-agent workspace sharing the same underlying codebase and execution environment. You MUST collaborate proactively and keep progress moving.

1. Shared Context: All agents are using the same repository, file system, memory state, and runtime environment.
2. Active Execution: Do not stay passive. Propose concrete next steps, claim work, and execute non-destructive changes promptly.
3. Safe Coordination: Before destructive commands or broad refactors, briefly announce intent and wait for feedback. For normal scoped edits, coordinate quickly and continue.
4. Conflict Avoidance: Announce target files/modules before editing. Avoid simultaneous edits to the same file.
5. Discussion Cadence: Keep the thread active with meaningful updates. If waiting too long, send a short structured update (status, blocker, next action) and optionally @ a relevant online agent.
6. msg_wait Behavior: Use msg_wait for listening, but do not remain silent forever. If repeated timeouts occur, post a useful progress message instead of idle chatter.
7. Message Quality: Avoid noise like "still waiting". Every message should include new information, a decision, or a concrete action request.

Operate like a delivery-focused engineering team: communicate clearly, move work forward, and resolve blockers quickly.`;

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
  threadSettings: Array<[string, {
    auto_administrator_enabled: boolean;
    timeout_seconds: number;
    switch_timeout_seconds: number;
    last_activity_time: string;
    auto_assigned_admin_id?: string;
    auto_assigned_admin_name?: string;
    admin_assignment_time?: string;
    creator_admin_id?: string;
    creator_admin_name?: string;
    creator_assignment_time?: string;
  }]>;
  messageEditHistory: Array<[string, Array<{ version: number; old_content: string; edited_by: string; created_at: string }>]>;
};

export class MemoryStore {
  // SEQ_TOLERANCE: 默认 0 (严格模式)，匹配 Python config.py 默认值
  // Python: SEQ_TOLERANCE = int(os.getenv("AGENTCHATBUS_SEQ_TOLERANCE", "0"))
  private static readonly SEQ_TOLERANCE = 0;
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
  private readonly threadSettings = new Map<string, {
    auto_administrator_enabled: boolean;
    timeout_seconds: number;
    switch_timeout_seconds: number;
    last_activity_time: string;
    auto_assigned_admin_id?: string;
    auto_assigned_admin_name?: string;
    admin_assignment_time?: string;
    creator_admin_id?: string;
    creator_admin_name?: string;
    creator_assignment_time?: string;
  }>();
  private readonly messageEditHistory = new Map<string, Array<{ version: number; old_content: string; edited_by: string; created_at: string }>>();
  private ideOwnerInstanceId: string | null = null;
  // Per-thread AsyncEvent registry for event-driven msg_wait wake-ups (matching Python _thread_events)
  // When msg_post succeeds, the corresponding event is set so that all waiters wake up immediately.
  private readonly _threadEvents = new Map<string, AsyncEvent>();
  private logCursor = 0;

  /**
   * Return (or create) the AsyncEvent for a given thread_id.
   * Matches Python: _get_thread_event(thread_id: str) -> asyncio.Event
   */
  private _getThreadEvent(threadId: string): AsyncEvent {
    if (!this._threadEvents.has(threadId)) {
      this._threadEvents.set(threadId, new AsyncEvent());
    }
    return this._threadEvents.get(threadId)!;
  }
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
        SELECT id, topic, status, created_at, updated_at, system_prompt, template_id
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

    // Calculate message rates (last 1m, 5m, 15m)
    const now = new Date();
    const cutoffs = {
      last_1m: new Date(now.getTime() - 60 * 1000).toISOString(),
      last_5m: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
      last_15m: new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
    };
    const messageRate: Record<string, number> = { last_1m: 0, last_5m: 0, last_15m: 0 };
    try {
      for (const [key, cutoff] of Object.entries(cutoffs)) {
        const row = this.persistenceDb.prepare(
          "SELECT COUNT(*) as count FROM messages WHERE created_at >= ?"
        ).get(cutoff) as { count: number };
        messageRate[key] = row.count;
      }
    } catch {}

    // Calculate stop_reasons distribution
    const canonicalReasons = ["convergence", "timeout", "complete", "error", "impasse"];
    const stopReasons: Record<string, number> = {};
    for (const r of canonicalReasons) {
      stopReasons[r] = 0;
    }
    try {
      const rows = this.persistenceDb.prepare(
        `SELECT json_extract(metadata, '$.stop_reason') AS reason, COUNT(*) AS cnt
         FROM messages
         WHERE json_extract(metadata, '$.stop_reason') IS NOT NULL
         GROUP BY reason`
      ).all() as Array<{ reason: string; cnt: number }>;
      for (const row of rows) {
        stopReasons[row.reason] = (stopReasons[row.reason] || 0) + row.cnt;
      }
    } catch {}

    // Calculate avg_latency_ms
    let avgLatencyMs: number | null = null;
    try {
      const lagSql = `
        WITH gaps AS (
          SELECT
            (julianday(created_at) - julianday(
              LAG(created_at) OVER (PARTITION BY thread_id ORDER BY seq)
            )) * 86400000.0 AS gap_ms
          FROM messages
          WHERE thread_id IN (
            SELECT DISTINCT thread_id FROM messages WHERE created_at >= ?
          )
        )
        SELECT AVG(gap_ms) AS avg_gap FROM gaps WHERE gap_ms IS NOT NULL
      `;
      const row = this.persistenceDb.prepare(lagSql).get(cutoffs.last_15m) as { avg_gap: number | null } | undefined;
      if (row && row.avg_gap !== null) {
        avgLatencyMs = Math.round(row.avg_gap * 10) / 10;
      }
    } catch {}

    // Count online agents based on heartbeat timeout (Python parity)
    const heartbeatTimeoutMs = 30 * 1000; // 30 seconds
    const heartbeatCutoff = new Date(now.getTime() - heartbeatTimeoutMs).toISOString();
    let agentsOnline = 0;
    try {
      const row = this.persistenceDb.prepare(
        "SELECT COUNT(*) as count FROM agents WHERE last_heartbeat >= ?"
      ).get(heartbeatCutoff) as { count: number };
      agentsOnline = row.count;
    } catch {}

    return {
      engine: "node",
      uptime_seconds: (Date.now() - this.startTime) / 1000,
      started_at: new Date(this.startTime).toISOString(),
      schema_version: "1.0",
      threads: {
        total: threads.length,
        by_status: byStatus
      },
      messages: {
        total: messageCount,
        rate: messageRate,
        avg_latency_ms: avgLatencyMs,
        stop_reasons: stopReasons
      },
      agents: {
        total: agents.length,
        online: agentsOnline
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
      // Clear relational tables
      this.persistenceDb.exec("DELETE FROM messages");
      this.persistenceDb.exec("DELETE FROM threads");
      this.persistenceDb.exec("DELETE FROM reply_tokens");
      this.persistenceDb.exec("DELETE FROM thread_settings");
      this.persistenceDb.exec("DELETE FROM message_edits");
      this.persistenceDb.exec("DELETE FROM reactions");
      this.persistenceDb.exec("DELETE FROM msg_wait_refresh_requests");
      this.persistenceDb.exec("DELETE FROM thread_wait_states");
      this.persistenceDb.exec("DELETE FROM state_snapshots");
      
      // Attempt graceful close of DB if available to release file handles used in tests
      if (typeof (this.persistenceDb as any).close === 'function') {
        try {
          (this.persistenceDb as any).close();
        } catch (e) {
          // ignore close errors during reset
        }
      }
    } finally {
      // Reinitialize persistence DB using the configured persistencePath
      try {
        // @ts-ignore
        this.persistenceDb = new DatabaseSync(this.persistencePath);
        this.initializeRelationalTables();
        this.persistState();
      } catch (e) {
        // If reinitialization fails, keep internal maps cleared
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

    // QW-07: Content filter for system_prompt (Python parity)
    if (finalSystemPrompt) {
      checkContentOrThrow(finalSystemPrompt);
    }

    const now = new Date().toISOString();
    const thread: ThreadRecord = {
      id: randomUUID(),
      topic,
      status: "discuss",
      created_at: now,
      updated_at: now,
      system_prompt: finalSystemPrompt,
      template_id: templateId
    };
    this.threads.set(thread.id, thread);
    this.threadMessages.set(thread.id, []);
    this.threadParticipants.set(thread.id, new Set());
    this.threadWaitStates.set(thread.id, new Map());
    this.threadSettings.set(thread.id, {
      auto_administrator_enabled: true,
      timeout_seconds: 60,
      switch_timeout_seconds: 60,
      last_activity_time: now
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
      "SELECT id, topic, status, created_at, updated_at, system_prompt, template_id FROM threads WHERE id = ?"
    ).get(threadId) as Record<string, unknown> | undefined;
    return row ? this.rowToThreadRecord(row) : undefined;
  }

  updateThreadStatus(threadId: string, status: string): boolean {
    const thread = this.getThread(threadId);
    if (!thread) {
      return false;
    }
    this.threads.set(threadId, thread);
    thread.status = status as ThreadStatus;
    this.appendLog(`thread state updated: ${threadId} ${status}`);
    eventBus.emit({ type: "thread.updated", payload: thread });
    this.upsertThread(thread);
    this.persistState();
    return true;
  }

  closeThread(threadId: string, summary?: string): boolean {
    const thread = this.getThread(threadId);
    if (!thread) {
      return false;
    }
    const now = new Date().toISOString();
    this.persistenceDb.prepare(
      "UPDATE threads SET status = 'closed', closed_at = ?, summary = ? WHERE id = ?"
    ).run(now, summary || null, threadId);
    thread.status = "closed";
    this.threads.set(threadId, thread);
    this.appendLog(`thread closed: ${threadId}`);
    eventBus.emit({ type: "thread.closed", payload: { thread_id: threadId, summary } });
    this.persistState();
    return true;
  }

  /**
   * Close open threads whose last message is older than timeout_minutes.
   * Returns the list of thread IDs that were closed.
   * Ported from Python crud.py thread_timeout_sweep.
   */
  threadTimeoutSweep(timeoutMinutes: number): string[] {
    if (timeoutMinutes <= 0) {
      return [];
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - timeoutMinutes * 60 * 1000).toISOString();
    const nowIso = now.toISOString();

    // Find threads that are open and whose last activity is before the cutoff.
    // Use LEFT JOIN so threads with no messages are also considered.
    const rows = this.persistenceDb.prepare(`
      SELECT t.id, t.topic,
             COALESCE(MAX(m.created_at), t.created_at) AS last_activity
      FROM threads t
      LEFT JOIN messages m ON m.thread_id = t.id
      WHERE t.status = 'discuss'
      GROUP BY t.id
      HAVING last_activity < ?
    `).all(cutoff) as Array<{ id: string; topic: string; last_activity: string }>;

    const closedIds: string[] = [];
    for (const row of rows) {
      const threadId = row.id;
      const topic = row.topic;
      const lastActivity = row.last_activity;

      this.persistenceDb.prepare(
        "UPDATE threads SET status = 'closed', closed_at = ? WHERE id = ?"
      ).run(nowIso, threadId);

      // Update in-memory cache
      const thread = this.threads.get(threadId);
      if (thread) {
        thread.status = "closed";
        this.threads.set(threadId, thread);
      }

      // Emit event
      eventBus.emit({
        type: "thread.timeout",
        payload: {
          thread_id: threadId,
          topic,
          last_activity: lastActivity,
          timeout_minutes: timeoutMinutes,
          closed_at: nowIso
        }
      });

      closedIds.push(threadId);
      this.appendLog(`thread timeout: ${threadId} (topic: ${topic})`);
    }

    if (closedIds.length > 0) {
      this.persistState();
    }

    return closedIds;
  }

  listThreads(options?: {
    status?: string;
    includeArchived?: boolean;
    limit?: number;
    before?: string;
  }): { threads: ThreadRecord[]; has_more: boolean; next_cursor?: string } {
    const {
      status,
      includeArchived = true,
      limit = 0,
      before
    } = options || {};

    // Build WHERE clauses
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (status) {
      clauses.push("status = ?");
      params.push(status);
    } else if (!includeArchived) {
      clauses.push("status != 'archived'");
    }

    if (before) {
      clauses.push("created_at < ?");
      params.push(before);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    
    // Hard cap at 200
    const effectiveLimit = limit > 0 ? Math.min(limit, 200) : 0;

    let sql = `SELECT id, topic, status, created_at, updated_at, system_prompt, template_id FROM threads ${where} ORDER BY created_at DESC`;
    
    if (effectiveLimit > 0) {
      sql += ` LIMIT ?`;
      params.push(effectiveLimit + 1); // Fetch one extra to check has_more
    }

    const rows = this.persistenceDb.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    
    let threads = rows.map(row => this.rowToThreadRecord(row));
    let hasMore = false;
    let nextCursor: string | undefined;

    if (effectiveLimit > 0 && threads.length > effectiveLimit) {
      hasMore = true;
      threads = threads.slice(0, effectiveLimit);
      nextCursor = threads[threads.length - 1].created_at;
    }

    return {
      threads,
      has_more: hasMore,
      next_cursor: nextCursor
    };
  }

  countThreads(options?: {
    status?: string;
    includeArchived?: boolean;
  }): number {
    const {
      status,
      includeArchived = true
    } = options || {};

    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (status) {
      clauses.push("status = ?");
      params.push(status);
    } else if (!includeArchived) {
      clauses.push("status != 'archived'");
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) as count FROM threads ${where}`;
    
    const result = this.persistenceDb.prepare(sql).get(...params) as Record<string, unknown>;
    return (result.count as number) || 0;
  }

  setThreadStatus(threadId: string, status: ThreadStatus): boolean {
    const thread = this.getThread(threadId);
    if (!thread) {
      return false;
    }
    this.threads.set(threadId, thread);
    thread.status = status;
    thread.updated_at = new Date().toISOString();
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

  getMessages(threadId: string, afterSeq: number, includeSystemPrompt = false, priority?: string): MessageRecord[] {
    let sql: string;
    let params: (string | number)[];
    
    if (priority) {
      sql = `
        SELECT id, thread_id, seq, priority, author, author_id, author_name, author_emoji,
               role, content, metadata, reply_to_msg_id, created_at, edited_at, edit_version
        FROM messages
        WHERE thread_id = ? AND seq > ? AND priority = ?
        ORDER BY seq ASC
      `;
      params = [threadId, afterSeq, priority];
    } else {
      sql = `
        SELECT id, thread_id, seq, priority, author, author_id, author_name, author_emoji,
               role, content, metadata, reply_to_msg_id, created_at, edited_at, edit_version
        FROM messages
        WHERE thread_id = ? AND seq > ?
        ORDER BY seq ASC
      `;
      params = [threadId, afterSeq];
    }
    
    const rows = this.persistenceDb.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const dbMessages = rows.map((row) => this.rowToMessageRecord(row));

    if (includeSystemPrompt && afterSeq === 0) {
      const thread = this.getThread(threadId);
      const threadPrompt = thread?.system_prompt;
      let finalContent = GLOBAL_SYSTEM_PROMPT;
      
      if (threadPrompt) {
        finalContent = `## Section: System (Built-in)\n\n${GLOBAL_SYSTEM_PROMPT}\n\n## Section: Thread Create (Provided By Creator)\n\n${threadPrompt}`;
      }

      const sysMsg: MessageRecord = {
        id: `sys-${threadId}`,
        thread_id: threadId,
        seq: 0,
        priority: "normal",
        author: "system",
        author_id: "system",
        author_name: "system",
        author_emoji: "⚙️",
        role: "system",
        content: finalContent,
        metadata: {},
        reactions: [],
        created_at: thread?.created_at || new Date().toISOString(),
        edited_at: null,
        edit_version: 0,
        reply_to_msg_id: undefined
      };

      return [sysMsg, ...dbMessages];
    }

    return dbMessages;
  }

  /**
   * List messages with format options (Python: handle_msg_list)
   * Support both 'json' and 'blocks' return formats
   */
  listMessages(params: {
    threadId: string;
    afterSeq: number;
    limit?: number;
    includeSystemPrompt?: boolean;
    returnFormat?: 'json' | 'blocks';
    includeAttachments?: boolean;
  }): any[] {
    const {
      threadId,
      afterSeq,
      limit = 100,
      includeSystemPrompt = false,
      returnFormat = 'blocks',
      includeAttachments = true
    } = params;

    // Get messages from DB
    const rawMessages = this.getMessages(threadId, afterSeq, includeSystemPrompt).slice(0, limit);
    const messages = this.projectMessagesForAgent(rawMessages);

    if (returnFormat === 'json') {
      // Return JSON format - array of message objects
      const jsonPayload = messages.map(msg => ({
        id: msg.id,
        content: msg.content,
        author: msg.author,
        role: msg.role,
        seq: msg.seq,
        created_at: msg.created_at,
        attachments: (includeAttachments && msg.metadata?.attachments) ? msg.metadata.attachments : undefined
      }));

      // Wrap in TextContent as MCP SDK expects
      return [{
        type: 'text',
        text: JSON.stringify(jsonPayload)
      }];
    } else {
      // Return blocks format - TextContent + ImageContent
      const blocks: any[] = [];
      
      for (const msg of messages) {
        // Add text content
        blocks.push({
          type: 'text',
          text: msg.content
        });

        // Add image attachments if requested
        if (includeAttachments && msg.metadata?.attachments) {
          const attachments = Array.isArray(msg.metadata.attachments) ? msg.metadata.attachments : [];
          for (const attachment of attachments) {
            if (attachment.type === 'image') {
              let imageData = attachment.data;
              let mimeType = attachment.mimeType;

              // Handle data URL prefix stripping (Python logic)
              if (imageData && imageData.startsWith('data:')) {
                const match = imageData.match(/^data:([^;]+);base64,(.*)$/);
                if (match) {
                  mimeType = match[1];
                  imageData = match[2];
                }
              }

              blocks.push({
                type: 'image',
                data: imageData,
                mimeType: mimeType || 'image/png'
              });
            }
          }
        }
      }

      return blocks;
    }
  }

  async waitForMessages(input: { threadId: string; afterSeq: number; agentId?: string; timeoutMs?: number; forAgent?: string }): Promise<{
    messages: MessageRecord[];
    current_seq: number;
    reply_token: string;
    reply_window: { expires_at: number; max_new_messages: number };
    fast_return: boolean;
    fast_return_reason?: string;
  }> {
    const thread = this.getThread(input.threadId);
    if (!thread) {
      throw new Error("Thread not found");
    }

    const latestSeq = this.getLatestSeq(input.threadId);
    
    let fastReturn = false;
    let fastReturnReason: string | undefined;
    
    // Match Python logic: fast return only when:
    // 1. Has refresh request, OR
    // 2. No issued tokens AND agent is behind (afterSeq < latestSeq)
    if (input.agentId) {
      const refresh = this.getRefreshRequest(input.threadId, input.agentId);
      if (refresh) {
        fastReturn = true;
        fastReturnReason = refresh.reason;
        this.clearRefreshRequest(input.threadId, input.agentId);
      } else {
        // Check issued token count
        const tokens = Array.from(this.syncTokens.values()).filter((t: ReplyTokenRecord) => 
          t.threadId === input.threadId && 
          t.agentId === input.agentId && 
          t.status === "issued"
        );
        const issuedTokenCount = tokens.length;
        
        // Only fast return if no tokens AND agent is behind
        if (issuedTokenCount === 0 && input.afterSeq < latestSeq) {
          fastReturn = true;
          fastReturnReason = `no_issued_tokens_and_behind(total_issued=${issuedTokenCount}, after_seq=${input.afterSeq}, latest=${latestSeq})`;
        }
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

    // Start polling loop (match Python _poll() function)
    // Python 逻辑：先检查消息，有消息就返回，然后才考虑 fast return
    const startTime = Date.now();
    const timeout = input.timeoutMs || 300_000;
    const HEARTBEAT_INTERVAL = 40_000; // 40 seconds, match Python
    let lastHeartbeat = startTime;
    let localAfterSeq = input.afterSeq;

    try {
      while (true) {
        // Check for new messages FIRST (match Python L1205-1206)
        // Python: "raw_msgs = await crud.msg_list(...); if msgs: ..."
        const allMessages = this.getMessages(input.threadId, localAfterSeq);
        let messages = allMessages;

        // Apply for_agent filtering (match Python L1208-1223)
        if (input.forAgent && messages.length > 0) {
          messages = messages.filter(m => {
            const meta = m.metadata as any;
            return meta?.handoff_target === input.forAgent;
          });
          // If filtering resulted in empty but there were messages,
          // update cursor and continue waiting (match Python L1218-1220)
          if (messages.length === 0 && allMessages.length > 0) {
            localAfterSeq = Math.max(localAfterSeq, ...allMessages.map(m => m.seq));
          }
        }

        if (messages.length > 0) {
          // Found messages! Exit wait state and return (match Python L1211-1233)
          if (input.agentId) {
            this.exitWaitState(input.threadId, input.agentId);
            const agent = this.getAgent(input.agentId);
            if (agent) {
              agent.last_activity = 'msg_received';
              agent.last_activity_time = new Date().toISOString();
              this.upsertAgent(agent);
            }
          }
          
          const sync = this.issueSyncContext(input.threadId, input.agentId, "msg_wait_result");
          return {
            messages: this.projectMessagesForAgent(messages),
            current_seq: sync.current_seq,
            reply_token: sync.reply_token,
            reply_window: sync.reply_window,
            fast_return: false,
            fast_return_reason: undefined
          };
        }

        // Priority: messages first, then generic no-issued-token fast-return.
        // Match Python L1236-1243: "if wants_sync_only: return []"
        if (fastReturn) {
          if (input.agentId) {
            this.exitWaitState(input.threadId, input.agentId);
          }
          const sync = this.issueSyncContext(input.threadId, input.agentId, "sync_only");
          return {
            messages: [],
            current_seq: sync.current_seq,
            reply_token: sync.reply_token,
            reply_window: sync.reply_window,
            fast_return: true,
            fast_return_reason: fastReturnReason
          };
        }

        // Check if we should exit due to sync-only mode (match Python L1236-1243)
        // This happens when agent has refresh request during the wait loop
        if (input.agentId) {
          const refreshNow = this.getRefreshRequest(input.threadId, input.agentId);
          if (refreshNow) {
            this.exitWaitState(input.threadId, input.agentId);
            this.clearRefreshRequest(input.threadId, input.agentId);
            const sync = this.issueSyncContext(input.threadId, input.agentId, "sync_only");
            return {
              messages: [],
              current_seq: sync.current_seq,
              reply_token: sync.reply_token,
              reply_window: sync.reply_window,
              fast_return: true,
              fast_return_reason: refreshNow.reason
            };
          }
        }

        // Heartbeat refresh (match Python L1245-1248)
        const now = Date.now();
        if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
          // Refresh heartbeat (update agent activity)
          if (input.agentId) {
            const agent = this.getAgent(input.agentId);
            if (agent) {
              agent.last_activity = 'msg_wait_heartbeat';
              agent.last_activity_time = new Date().toISOString();
              this.upsertAgent(agent);
            }
          }
          lastHeartbeat = now;
        }

        // Check timeout (match Python L1261)
        const elapsed = now - startTime;
        if (elapsed >= timeout) {
          // Timeout - exit wait state and return empty (match Python L1262-1269)
          if (input.agentId) {
            this.exitWaitState(input.threadId, input.agentId);
          }
          
          // Match Python L1274-1291: Try to reuse existing token if no messages and seq unchanged
          const currentSeqAfterWait = this.getLatestSeq(input.threadId);
          let sync: SyncContext;
          
          if (input.agentId && currentSeqAfterWait === latestSeq) {
            // Try to get latest issued token for reuse
            const latestToken = this.getLatestIssuedToken(input.threadId, input.agentId);
            if (latestToken) {
              // Reuse existing token, invalidate others
              this.invalidateReplyTokensForAgentExcept(input.threadId, input.agentId, latestToken.token);
              sync = {
                current_seq: currentSeqAfterWait,
                reply_token: latestToken.token,
                reply_window: {
                  expires_at: latestToken.expiresAt,
                  max_new_messages: 0
                }
              };
            } else {
              // No existing token, issue new one
              this.invalidateReplyTokensForAgent(input.threadId, input.agentId);
              sync = this.issueSyncContext(input.threadId, input.agentId, "timeout");
            }
          } else {
            // Seq changed or no agentId, issue new token
            if (input.agentId) {
              this.invalidateReplyTokensForAgent(input.threadId, input.agentId);
            }
            sync = this.issueSyncContext(input.threadId, input.agentId, "timeout");
          }
          
          return {
            messages: [],
            current_seq: sync.current_seq,
            reply_token: sync.reply_token,
            reply_window: sync.reply_window,
            fast_return: false,
            fast_return_reason: undefined
          };
        }

        // Event-driven wake-up: wait for msg_post to signal this thread's event.
        // Matches Python dispatch.py L1249-1256:
        //   event.clear()
        //   try:
        //       await asyncio.wait_for(event.wait(), timeout=1.0)
        //   except asyncio.TimeoutError:
        //       pass
        //
        // Use min(remaining_time, 1000) to respect the outer timeout
        // while still allowing the 1s fallback for correctness.
        const remainingTimeout = Math.min(1000, timeout - elapsed);
        const event = this._getThreadEvent(input.threadId);
        event.clear();
        await event.wait(remainingTimeout);
      }
    } finally {
      // No cleanup needed - AsyncEvent handles it automatically
    }
  }

  public projectMessagesForAgent(messages: MessageRecord[], audience: "agent" | "human" = "agent"): MessageRecord[] {
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

  /**
   * Filter metadata fields based on attention mechanism feature flags (UP-17).
   * Ported from Python dispatch.py _filter_metadata_fields.
   * Strips handoff_target and stop_reason from metadata when respective flags are disabled.
   */
  private filterMetadataFields(
    metadata: Record<string, unknown> | null,
    options: { enableHandoffTarget?: boolean; enableStopReason?: boolean } = {}
  ): Record<string, unknown> | null {
    const { enableHandoffTarget = ENABLE_HANDOFF_TARGET, enableStopReason = ENABLE_STOP_REASON } = options;
    if (!metadata) return null;

    const filtered = { ...metadata };

    if (!enableHandoffTarget && "handoff_target" in filtered) {
      delete filtered.handoff_target;
    }
    if (!enableStopReason && "stop_reason" in filtered) {
      delete filtered.stop_reason;
    }

    return Object.keys(filtered).length > 0 ? filtered : null;
  }

  /**
   * Format a message for agent consumption, applying attention mechanism filters.
   * Ported from Python dispatch.py handle_msg_get/list/wait logic.
   * 
   * @param msg - The raw message record
   * @param options - Optional flags to control attention fields (defaults follow env vars)
   * @returns Formatted message with attention fields stripped based on feature flags
   */
  formatMessageForAgent(
    msg: MessageRecord,
    options: {
      includePriority?: boolean;
      enableHandoffTarget?: boolean;
      enableStopReason?: boolean;
    } = {}
  ): MessageRecord & { handoff_target?: string; stop_reason?: string } {
    const {
      includePriority = ENABLE_PRIORITY,
      enableHandoffTarget = ENABLE_HANDOFF_TARGET,
      enableStopReason = ENABLE_STOP_REASON
    } = options;

    const filteredMeta = this.filterMetadataFields(msg.metadata, { enableHandoffTarget, enableStopReason });

    // Build result with conditional fields
    const result: MessageRecord & { handoff_target?: string; stop_reason?: string } = {
      ...msg,
      metadata: filteredMeta
    };

    // Handle priority field
    if (!includePriority) {
      delete (result as Partial<MessageRecord>).priority;
    }

    // Handle metadata-based attention fields (only include if enabled and present)
    if (enableHandoffTarget && filteredMeta?.handoff_target) {
      result.handoff_target = String(filteredMeta.handoff_target);
    }
    if (enableStopReason && filteredMeta?.stop_reason) {
      result.stop_reason = String(filteredMeta.stop_reason);
    }

    return result;
  }

  /**
   * Format multiple messages for agent consumption.
   * Applies attention mechanism filters to each message.
   */
  formatMessagesForAgent(
    messages: MessageRecord[],
    options: {
      includePriority?: boolean;
      enableHandoffTarget?: boolean;
      enableStopReason?: boolean;
    } = {}
  ): Array<MessageRecord & { handoff_target?: string; stop_reason?: string }> {
    return messages.map(m => this.formatMessageForAgent(m, options));
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

    // Validate priority (UP-16) - match Python crud.py L1166, L1191-1192
    const validPriorities = new Set(["normal", "urgent", "system"]);
    const priority = input.priority || "normal";
    if (!validPriorities.has(priority)) {
      throw new Error(`Invalid priority '${priority}'. Must be one of: ${Array.from(validPriorities).sort().join(", ")}`);
    }

    // Validate stop_reason in metadata (UP-17) - match Python crud.py L1188, L1196-1199
    const validStopReasons = new Set(["convergence", "timeout", "error", "complete", "impasse"]);
    if (input.metadata) {
      const stopReason = input.metadata.stop_reason;
      if (stopReason && !validStopReasons.has(stopReason as string)) {
        throw new Error(`Invalid stop_reason '${stopReason}'. Must be one of: ${Array.from(validStopReasons).sort().join(", ")}`);
      }
    }

    // Content filter check (UP-07)
    checkContentOrThrow(input.content);

    // Vecteur B: role escalation prevention (Python parity: main.py L1867-1868)
    // A message with role='system' from author='human' must be rejected
    if (input.role === "system" && (input.author === "human" || input.author === "")) {
      throw new Error("role 'system' is not allowed for human messages");
    }

    const latestSeq = this.getLatestSeq(input.threadId);
    const agent = this.getAgentById(input.author);

    // Rate limiting check - match Python crud.py L1232-1253
    const rateLimitEnabled = process.env.AGENTCHATBUS_RATE_LIMIT_ENABLED !== "false";
    const rateLimitPerMinute = parseInt(process.env.AGENTCHATBUS_RATE_LIMIT || "30", 10);
    
    if (rateLimitEnabled && rateLimitPerMinute > 0) {
      const windowSeconds = 60;
      const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();
      
      let count: number;
      let scope: string;
      
      if (agent?.id) {
        const row = this.persistenceDb.prepare(
          "SELECT COUNT(*) AS cnt FROM messages WHERE author_id = ? AND created_at > ?"
        ).get(agent.id, cutoff) as { cnt: number };
        count = row.cnt;
        scope = "author_id";
      } else {
        const row = this.persistenceDb.prepare(
          "SELECT COUNT(*) AS cnt FROM messages WHERE author = ? AND created_at > ?"
        ).get(input.author, cutoff) as { cnt: number };
        count = row.cnt;
        scope = "author";
      }
      
      if (count >= rateLimitPerMinute) {
        throw new RateLimitExceeded(rateLimitPerMinute, windowSeconds, windowSeconds, scope);
      }
    }

    // Strict Sync Logic (UP-14/15/16)
    if (input.expectedLastSeq !== undefined || input.replyToken !== undefined) {
      if (input.expectedLastSeq === undefined || input.replyToken === undefined) {
        // Match Python: set refresh_request for all sync errors
        if (agent) this.setRefreshRequest(thread.id, agent.id, "MISSING_SYNC_FIELDS");
        throw new MissingSyncFieldsError(input.expectedLastSeq === undefined ? ["expected_last_seq"] : ["reply_token"]);
      }

      const token = this.syncTokens.get(input.replyToken);
      if (!token || token.threadId !== input.threadId) {
        if (agent) this.setRefreshRequest(thread.id, agent.id, "TOKEN_INVALID");
        throw new ReplyTokenInvalidError();
      }

      // Enforce agent binding only when author resolves to a registered agent.
      // Python parity (crud.py): if token_agent_id and author_id and token_agent_id != author_id -> invalid.
      if (token.agentId && agent?.id && token.agentId !== agent.id) {
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

    // Reply-to validation (UP-14)
    if (input.replyToMsgId) {
      const parentMsg = this.getMessage(input.replyToMsgId);
      if (!parentMsg) {
        throw new Error(`Message ${input.replyToMsgId} does not exist`);
      }
      if (parentMsg.thread_id !== input.threadId) {
        throw new Error("Cannot reply to a message in a different thread");
      }
    }

    this.sequence += 1;
    const message: MessageRecord = {
      id: randomUUID(),
      thread_id: input.threadId,
      seq: this.sequence,
      priority: input.priority || "normal",
      author: agent?.name || input.author,
      author_id: agent?.id || undefined,
      author_name: agent?.name || input.author,
      author_emoji: agent?.emoji || (input.role === "system" ? "⚙️" : ((input.author === "human" || input.role === "user") ? "👤" : "🤖")),
      role: input.role || "user",
      content: input.content,
      metadata: input.metadata || null,
      reactions: [],
      edited_at: null,
      edit_version: 0,
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
    
    // Emit msg.handoff and msg.stop events (UP-17) - match Python crud.py L1332-1344
    if (message.metadata) {
      const handoffTarget = message.metadata.handoff_target;
      if (handoffTarget) {
        eventBus.emit({
          type: "msg.handoff",
          payload: {
            msg_id: message.id,
            thread_id: message.thread_id,
            from_agent: message.author_name || message.author,
            to_agent: handoffTarget
          }
        });
      }
      const stopReason = message.metadata.stop_reason;
      if (stopReason) {
        eventBus.emit({
          type: "msg.stop",
          payload: {
            msg_id: message.id,
            thread_id: message.thread_id,
            agent: message.author_name || message.author,
            reason: stopReason
          }
        });
      }
    }
    
    // Notify any msg_wait callers on this thread that a new message is available.
    // This allows event-driven wake-up instead of waiting for the 1s poll tick.
    // Matches Python dispatch.py L847-848:
    //   if thread_id in _thread_events:
    //       _thread_events[thread_id].set()
    if (this._threadEvents.has(input.threadId)) {
      this._threadEvents.get(input.threadId)!.set();
    }
    
    // Update thread activity time (match Python crud.py L1325)
    this.threadSettingsUpdateActivity(input.threadId);
    this.touchThreadUpdatedAt(input.threadId);

    this.insertMessage(message);
    this.persistState();
    return message;
  }

  /**
   * Internal: Create a system message without reply token validation.
   * Used by internal coordination logic and background tasks.
   * Ported from Python crud.py _msg_create_system.
   */
  postSystemMessage(threadId: string, content: string, metadata?: string | null, clearAutoAdmin = false): MessageRecord | undefined {
    const thread = this.getThread(threadId);
    if (!thread) {
      return undefined;
    }

    this.sequence += 1;
    const now = new Date().toISOString();
    const message: MessageRecord = {
      id: randomUUID(),
      thread_id: threadId,
      seq: this.sequence,
      priority: "system",
      author: "system",
      author_id: "system",
      author_name: "System",
      author_emoji: "⚙️",
      role: "system",
      content: content,
      metadata: metadata ? JSON.parse(metadata) : null,
      reactions: [],
      edited_at: null,
      edit_version: 0,
      reply_to_msg_id: undefined,
      created_at: now
    };

    const messages = this.threadMessages.get(threadId) || [];
    messages.push(message);
    this.threadMessages.set(threadId, messages);

    // Update thread activity time
    if (clearAutoAdmin) {
      this.threadSettingsUpdateActivity(threadId);
    }
    this.touchThreadUpdatedAt(threadId);

    this.insertMessage(message);
    this.persistState();
    
    eventBus.emit({ type: "msg.new", payload: message });
    
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
    if (!row) return undefined;
    const message = this.rowToMessageRecord(row);
    // Load reactions from database
    message.reactions = this.getReactions(messageId);
    return message;
  }

  editMessage(messageId: string, newContent: string, editedBy = "system"): MessageRecord | { no_change: true; version: number } | undefined {
    const message = this.getMessage(messageId);
    if (!message) {
      return undefined;
    }

    // System role messages cannot be edited
    if (message.role === "system") {
      throw new PermissionError("System messages cannot be edited");
    }

    // Only author (author_id or author) or system can edit
    const allowedEditors = new Set([message.author]);
    if (message.author_id) {
      allowedEditors.add(message.author_id);
    }
    if (!allowedEditors.has(editedBy) && editedBy !== "system") {
      throw new PermissionError(
        `Only the original author ('${message.author_id || message.author}') or 'system' can edit this message`
      );
    }

    if (message.content === newContent) {
      return { no_change: true, version: message.edit_version || 0 };
    }
    const newVersion = (message.edit_version || 0) + 1;
    const edits = this.messageEditHistory.get(messageId) || [];
    edits.push({
      version: newVersion,
      old_content: message.content,
      edited_by: editedBy,
      created_at: new Date().toISOString()
    });
    this.messageEditHistory.set(messageId, edits);
    message.content = newContent;
    message.edited_at = new Date().toISOString();
    message.edit_version = newVersion;
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

  /**
   * Batch-fetch reactions for multiple messages (match Python crud.msg_reactions_bulk)
   * Returns a map from message_id to array of reactions
   */
  getReactionsBulk(messageIds: string[]): Map<string, Array<{ agent_id: string; reaction: string }>> {
    const result = new Map<string, Array<{ agent_id: string; reaction: string }>>();
    
    if (messageIds.length === 0) {
      return result;
    }
    
    // Initialize with empty arrays
    for (const id of messageIds) {
      result.set(id, []);
    }
    
    // Build IN clause with placeholders
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = this.persistenceDb.prepare(
      `
        SELECT message_id, agent_id, reaction
        FROM reactions
        WHERE message_id IN (${placeholders})
        ORDER BY message_id, reaction ASC, agent_id ASC
      `
    ).all(...messageIds) as Array<Record<string, unknown>>;
    
    for (const row of rows) {
      const msgId = String(row.message_id);
      const reactions = result.get(msgId) || [];
      reactions.push({
        agent_id: String(row.agent_id),
        reaction: String(row.reaction)
      });
      result.set(msgId, reactions);
    }
    
    return result;
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
    
    // Match Python logic: reuse existing issued token if available
    // Python version reuses tokens on repeated msg_wait timeouts
    if (agentId) {
      const existingTokens = Array.from(this.syncTokens.values()).filter((t: ReplyTokenRecord) => 
        t.threadId === threadId && 
        t.agentId === agentId && 
        t.status === "issued"
      );
      
      if (existingTokens.length > 0) {
        // Reuse the first existing token
        const existingToken = existingTokens[0];
        return {
          current_seq: currentSeq,
          reply_token: existingToken.token,
          reply_window: {
            expires_at: existingToken.expiresAt,
            max_new_messages: MemoryStore.SEQ_TOLERANCE
          }
        };
      }
    }
    
    // Issue new token only if no existing ones
    const token = randomUUID();
    const issuedAt = Date.now();
    const expiresAt = NON_EXPIRING_TOKEN_TS; // Match Python: tokens never expire (9999-12-31)

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
      reply_window: {
        expires_at: expiresAt,
        max_new_messages: MemoryStore.SEQ_TOLERANCE
      }
    };
  }

  registerAgent(input: { ide: string; model: string; description?: string; capabilities?: string[]; display_name?: string; skills?: unknown[] }): AgentRecord {
    const agentId = randomUUID();
    const name = `${input.ide} (${input.model})`;
    
    // Match Python crud.py L1702-1703:
    // clean_display_name = (display_name or "").strip() or name
    // alias_source = "user" if (display_name or "").strip() else "auto"
    const cleanDisplayName = (input.display_name || "").trim() || name;
    const aliasSource = (input.display_name || "").trim() ? "user" : "auto";
    
    const agent: AgentRecord = {
      id: agentId,
      name: name,
      display_name: cleanDisplayName,
      alias_source: aliasSource,
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
               last_activity, last_activity_time, capabilities, skills, emoji
        FROM agents
      `
    ).all() as Array<Record<string, unknown>>;
    // Token should NOT be exposed in agent list for security (Python parity)
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
    // Ported from Python crud.py thread_agents_list
    // Sources:
    // - message authors in the thread (messages.author_id)
    // - thread admin assignments (creator/auto-assigned) from thread_settings
    const participantIds = new Set<string>();

    // Get message authors
    const authorRows = this.persistenceDb.prepare(
      `
        SELECT DISTINCT author_id
        FROM messages
        WHERE thread_id = ?
          AND author_id IS NOT NULL
          AND author_id != ''
      `
    ).all(threadId) as Array<{ author_id: string }>;
    for (const row of authorRows) {
      if (row.author_id) {
        participantIds.add(row.author_id);
      }
    }

    // Get thread admin assignments from thread_settings
    const settings = this.getThreadSettings(threadId);
    if (settings) {
      if (settings.creator_admin_id) {
        participantIds.add(settings.creator_admin_id);
      }
      if (settings.auto_assigned_admin_id) {
        participantIds.add(settings.auto_assigned_admin_id);
      }
    }

    if (participantIds.size === 0) {
      return [];
    }

    // Get agent records for all participants
    const placeholders = Array.from(participantIds).map(() => "?").join(",");
    const rows = this.persistenceDb.prepare(
      `
        SELECT id, name, display_name, alias_source, ide, model, description,
               is_online, last_heartbeat, last_activity, last_activity_time,
               capabilities, skills, token, emoji
        FROM agents WHERE id IN (${placeholders})
      `
    ).all(...Array.from(participantIds)) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToAgentRecord(row));
  }

  getThreadWaitingAgents(threadId: string): Array<{ id: string; display_name?: string; emoji?: string }> {
    this.pruneExpiredWaitStates(threadId);
    const rows = this.persistenceDb.prepare(
      `
        SELECT a.id, a.display_name, a.name, a.emoji
        FROM thread_wait_states w
        JOIN agents a ON a.id = w.agent_id
        WHERE w.thread_id = ? AND a.is_online = 1
      `
    ).all(threadId) as Array<Record<string, unknown>>;
    return rows
      .map((agent) => ({
        id: String(agent.id),
        display_name: agent.display_name ? String(agent.display_name) : String(agent.name),
        emoji: agent.emoji ? String(agent.emoji) : "🤖"
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
    // Built-in templates (UP-18) - match Python crud.py builtin templates
    const builtinTemplates = [
      {
        id: "code-review",
        name: "Code Review",
        description: "Code review thread for systematic analysis",
        is_builtin: true,
        system_prompt: "You are a code reviewer. Critically analyze the code for bugs, security issues, and best practices.",
        default_metadata: {},
        created_at: new Date().toISOString()
      },
      {
        id: "security-audit",
        name: "Security Audit",
        description: "Security-focused review thread",
        is_builtin: true,
        system_prompt: "You are a security auditor. Focus on identifying vulnerabilities, injection risks, and security best practices.",
        default_metadata: {},
        created_at: new Date().toISOString()
      },
      {
        id: "architecture",
        name: "Architecture",
        description: "System architecture discussion thread",
        is_builtin: true,
        system_prompt: "You are a system architect. Focus on high-level design, component relationships, and scalability.",
        default_metadata: {},
        created_at: new Date().toISOString()
      },
      {
        id: "brainstorm",
        name: "Brainstorm",
        description: "Creative brainstorming thread",
        is_builtin: true,
        system_prompt: "You are a creative brainstorming assistant. Help explore ideas, consider alternatives, and think outside the box.",
        default_metadata: {},
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
        SELECT thread_id, auto_administrator_enabled, timeout_seconds, switch_timeout_seconds,
               last_activity_time, auto_assigned_admin_id, auto_assigned_admin_name, admin_assignment_time,
               creator_admin_id, creator_admin_name, creator_assignment_time
        FROM thread_settings WHERE thread_id = ?
      `
    ).get(threadId) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return {
      auto_administrator_enabled: Boolean(row.auto_administrator_enabled),
      timeout_seconds: Number(row.timeout_seconds),
      switch_timeout_seconds: Number(row.switch_timeout_seconds),
      last_activity_time: String(row.last_activity_time),
      auto_assigned_admin_id: row.auto_assigned_admin_id ? String(row.auto_assigned_admin_id) : undefined,
      auto_assigned_admin_name: row.auto_assigned_admin_name ? String(row.auto_assigned_admin_name) : undefined,
      admin_assignment_time: row.admin_assignment_time ? String(row.admin_assignment_time) : undefined,
      creator_admin_id: row.creator_admin_id ? String(row.creator_admin_id) : undefined,
      creator_admin_name: row.creator_admin_name ? String(row.creator_admin_name) : undefined,
      creator_assignment_time: row.creator_assignment_time ? String(row.creator_assignment_time) : undefined
    };
  }

  updateThreadSettings(threadId: string, input: { auto_administrator_enabled?: boolean; timeout_seconds?: number; switch_timeout_seconds?: number }) {
    const existing = this.getThreadSettings(threadId);
    if (!existing) {
      return undefined;
    }
    
    // Validate timeout_seconds minimum (match Python crud.py L847-849)
    if (input.timeout_seconds !== undefined) {
      if (input.timeout_seconds < 30) {
        throw new Error("timeout_seconds must be at least 30");
      }
    }
    
    // Validate switch_timeout_seconds minimum (match Python crud.py L851-853)
    if (input.switch_timeout_seconds !== undefined) {
      if (input.switch_timeout_seconds < 30) {
        throw new Error("switch_timeout_seconds must be at least 30");
      }
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

  /**
   * Update last_activity_time for thread settings and clear auto-assigned admin.
   * Match Python crud.py thread_settings_update_activity.
   */
  threadSettingsUpdateActivity(threadId: string): void {
    const settings = this.threadSettings.get(threadId);
    if (!settings) {
      return;
    }
    const now = new Date().toISOString();
    settings.last_activity_time = now;
    settings.auto_assigned_admin_id = undefined;
    settings.auto_assigned_admin_name = undefined;
    settings.admin_assignment_time = undefined;
    this.threadSettings.set(threadId, settings);
    this.upsertThreadSettings(threadId);
    this.persistState();
  }

  touchThreadUpdatedAt(threadId: string): void {
    const thread = this.getThread(threadId);
    if (!thread) {
      return;
    }
    thread.updated_at = new Date().toISOString();
    this.threads.set(threadId, thread);
    this.upsertThread(thread);
    this.persistState();
  }

  updateMessageMetadata(messageId: string, metadataPatch: Record<string, unknown>): MessageRecord | undefined {
    const message = this.getMessage(messageId);
    if (!message) {
      return undefined;
    }
    message.metadata = {
      ...(message.metadata || {}),
      ...metadataPatch
    };
    this.insertMessage(message);
    this.persistState();
    return message;
  }

  /**
   * Assign an admin to the thread (automatic coordinator selection).
   * Ported from Python crud.py thread_settings_assign_admin.
   */
  assignAdmin(threadId: string, adminId: string, adminName: string): ReturnType<typeof this.getThreadSettings> | undefined {
    const settings = this.threadSettings.get(threadId);
    if (!settings || !settings.auto_administrator_enabled) {
      return undefined;
    }
    const now = new Date().toISOString();
    settings.auto_assigned_admin_id = adminId;
    settings.auto_assigned_admin_name = adminName;
    settings.admin_assignment_time = now;
    this.threadSettings.set(threadId, settings);
    this.upsertThreadSettings(threadId);
    this.persistState();
    return this.getThreadSettings(threadId);
  }

  /**
   * Set the thread creator as the default admin.
   * Ported from Python crud.py thread_settings_set_creator_admin.
   */
  setCreatorAdmin(threadId: string, creatorId: string, creatorName: string): ReturnType<typeof this.getThreadSettings> | undefined {
    const settings = this.threadSettings.get(threadId);
    if (!settings || !settings.auto_administrator_enabled) {
      return undefined;
    }
    const now = new Date().toISOString();
    settings.creator_admin_id = creatorId;
    settings.creator_admin_name = creatorName;
    settings.creator_assignment_time = now;
    this.threadSettings.set(threadId, settings);
    this.upsertThreadSettings(threadId);
    this.persistState();
    return this.getThreadSettings(threadId);
  }

  /**
   * Switch thread admin based on explicit human confirmation.
   * This operation clears creator-admin priority and sets the selected admin as
   * the active auto-assigned admin.
   * Ported from Python crud.py thread_settings_switch_admin.
   */
  switchAdmin(threadId: string, adminId: string, adminName: string): ReturnType<typeof this.getThreadSettings> | undefined {
    const settings = this.threadSettings.get(threadId);
    if (!settings || !settings.auto_administrator_enabled) {
      return undefined;
    }
    const now = new Date().toISOString();
    // Clear creator-admin priority and set new auto-assigned admin
    settings.creator_admin_id = undefined;
    settings.creator_admin_name = undefined;
    settings.creator_assignment_time = undefined;
    settings.auto_assigned_admin_id = adminId;
    settings.auto_assigned_admin_name = adminName;
    settings.admin_assignment_time = now;
    this.threadSettings.set(threadId, settings);
    this.upsertThreadSettings(threadId);
    this.persistState();
    return this.getThreadSettings(threadId);
  }

  /**
   * Build a Markdown transcript for thread_id.
   * Returns null if thread does not exist.
   * Ported from Python crud.py thread_export_markdown.
   */
  exportThreadMarkdown(threadId: string): string | null {
    const thread = this.getThread(threadId);
    if (!thread) {
      return null;
    }

    // Get messages without system prompt
    const msgs = this.getMessages(threadId, 0, false);

    const createdLabel = this.formatDate(thread.created_at);
    const exportedLabel = this.formatDate(new Date().toISOString());

    const lines: string[] = [
      `# ${thread.topic}`,
      "",
      `> **Status:** ${thread.status} | **Created:** ${createdLabel}`,
      `> **Messages:** ${msgs.length} | **Exported:** ${exportedLabel}`,
      "",
      "---",
      ""
    ];

    for (const m of msgs) {
      const author = m.author_name || m.author;
      const timestamp = this.formatDate(m.created_at);
      lines.push(`### ${author} — ${timestamp}`);
      lines.push("");
      lines.push(m.content);
      lines.push("");
      lines.push("---");
      lines.push("");
    }

    return lines.join("\n");
  }

  private formatDate(isoString: string): string {
    try {
      const d = new Date(isoString);
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      const hours = String(d.getUTCHours()).padStart(2, '0');
      const minutes = String(d.getUTCMinutes()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
    } catch {
      return isoString;
    }
  }

  searchMessages(query: string, threadId?: string, limit = 50): MessageRecord[] {
    const normalized = query.toLowerCase();
    let sql: string;
    let params: (string | number)[];

    if (threadId) {
      sql = `
        SELECT id, thread_id, seq, priority, author, author_id, author_name, author_emoji,
               role, content, metadata, reply_to_msg_id, created_at, edited_at, edit_version
        FROM messages
        WHERE LOWER(content) LIKE ? AND thread_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `;
      params = [`%${normalized}%`, threadId, limit];
    } else {
      sql = `
        SELECT id, thread_id, seq, priority, author, author_id, author_name, author_emoji,
               role, content, metadata, reply_to_msg_id, created_at, edited_at, edit_version
        FROM messages
        WHERE LOWER(content) LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `;
      params = [`%${normalized}%`, limit];
    }

    const rows = this.persistenceDb.prepare(sql).all(...params) as Array<Record<string, unknown>>;
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
      // Re-throw the error to allow tests to catch it
      throw error;
    }
  }

  deleteTemplate(templateId: string): boolean {
    // Check if it's a built-in template
    const builtinTemplates = this.getTemplates().filter(t => t.is_builtin);
    if (builtinTemplates.some(t => t.id === templateId)) {
      throw new Error("Cannot delete built-in template");
    }

    // Delete from database
    const result = this.persistenceDb.prepare("DELETE FROM templates WHERE id = ? AND is_builtin = 0").run(templateId);
    return result.changes > 0;
  }

  getLogs(after: number, limit: number): { entries: Array<{ id: number; line: string }>; next_cursor: number } {
    const entries = this.logEntries.filter((entry) => entry.id > after).slice(0, limit);
    return {
      entries,
      next_cursor: entries.at(-1)?.id || after
    };
  }

  getDiagnostics(): Record<string, unknown> {
    const now = Date.now();
    const uptimeSeconds = Math.floor((now - this.startTime) / 1000);
    
    // Count online agents
    let onlineAgentsTotal = 0;
    for (const agent of this.agents.values()) {
      if (agent.is_online) onlineAgentsTotal++;
    }
    
    // Count threads and messages
    let totalThreads = this.threads.size;
    let totalMessages = 0;
    for (const msgs of this.threadMessages.values()) {
      totalMessages += msgs.length;
    }
    
    return {
      // Database status
      db_ok: true,
      db_latency_ms: 0,
      
      // MCP status
      mcp_ok: true,
      mcp_tools_count: 28,
      mcp_prompts_count: 0,
      mcp_resources_count: 0,
      
      // SSE status
      active_sse_connections: 0,
      sse_simulated_ok: true,
      
      // Agent status
      online_agents_total: onlineAgentsTotal,
      sse_agents_count: onlineAgentsTotal,
      stdio_agents_count: 0,
      
      // Server info
      server_time_utc: new Date().toISOString(),
      pid: process.pid,
      total_latency_ms: 0,
      app_dir: process.cwd(),
      db_path: "memory",
      uptime_seconds: uptimeSeconds,
      total_threads: totalThreads,
      total_messages: totalMessages,
      
      // TS-specific
      startupMode: "ts-sidecar",
      version: "0.0.1",
      transport: "http+sse",
      
      // Logs for frontend
      logs: [
        `[${new Date().toISOString()}] Diagnostics complete (TS memory store)`
      ]
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

  getWaitingAgentsForThread(threadId: string): AgentRecord[] {
    // Match Python main.py L990-1002: return agents that are
    // is_online and last_activity === "msg_wait"
    const waits = this.threadWaitStates.get(threadId);
    if (!waits || waits.size === 0) {
      return [];
    }
    
    const waitingAgents: AgentRecord[] = [];
    for (const [agentId] of waits.entries()) {
      const agent = this.agents.get(agentId);
      if (agent && agent.is_online && agent.last_activity === "msg_wait") {
        waitingAgents.push(agent);
      }
    }
    return waitingAgents;
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
    const createdAt = String(row.created_at);
    return {
      id: String(row.id),
      topic: String(row.topic),
      status: row.status as ThreadStatus,
      created_at: createdAt,
      updated_at: row.updated_at ? String(row.updated_at) : createdAt,
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
      "SELECT id, topic, status, created_at, updated_at, system_prompt, template_id FROM threads WHERE topic = ?"
    ).get(topic) as Record<string, unknown> | undefined;
    return row ? this.rowToThreadRecord(row) : undefined;
  }

  private rowToMessageRecord(row: Record<string, unknown>): MessageRecord {
    // DEBUG: Log raw row data for troubleshooting
    if (Math.random() < 0.01) {  // Log 1% of messages to avoid spam
      console.log('[DEBUG] rowToMessageRecord raw row:', {
        id: row.id,
        author: row.author,
        author_id: row.author_id,
        author_name: row.author_name,
        role: row.role,
        content_preview: String(row.content)?.slice(0, 30)
      });
    }
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
      // Token is optional - not exposed in listAgents for security (Python parity)
      token: row.token ? String(row.token) : undefined,
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
      "SELECT id, topic, status, created_at, updated_at, system_prompt, template_id FROM threads"
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
      "SELECT * FROM thread_settings"
    ).all() as Array<Record<string, unknown>>;
    for (const row of settings) {
      this.threadSettings.set(String(row.thread_id), {
        auto_administrator_enabled: Boolean(row.auto_administrator_enabled),
        timeout_seconds: Number(row.timeout_seconds),
        switch_timeout_seconds: Number(row.switch_timeout_seconds),
        last_activity_time: String(row.last_activity_time || ""),
        auto_assigned_admin_id: row.auto_assigned_admin_id ? String(row.auto_assigned_admin_id) : undefined,
        auto_assigned_admin_name: row.auto_assigned_admin_name ? String(row.auto_assigned_admin_name) : undefined,
        admin_assignment_time: row.admin_assignment_time ? String(row.admin_assignment_time) : undefined,
        creator_admin_id: row.creator_admin_id ? String(row.creator_admin_id) : undefined,
        creator_admin_name: row.creator_admin_name ? String(row.creator_admin_name) : undefined,
        creator_assignment_time: row.creator_assignment_time ? String(row.creator_assignment_time) : undefined
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
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        summary TEXT,
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
        switch_timeout_seconds INTEGER NOT NULL,
        last_activity_time TEXT NOT NULL,
        auto_assigned_admin_id TEXT,
        auto_assigned_admin_name TEXT,
        admin_assignment_time TEXT,
        creator_admin_id TEXT,
        creator_admin_name TEXT,
        creator_assignment_time TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
    // 完全移植自 Python database.py 的迁移逻辑
    const runMigrations = (): void => {
      const addColumnIfMissing = (table: string, col: string, typedef: string): void => {
        try {
          const cols = this.persistenceDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
          const names = cols.map(c => c.name.toLowerCase());
          if (names.length > 0 && !names.includes(col.toLowerCase())) {
            this.persistenceDb.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${typedef}`);
          }
        } catch {
          // Table might not exist yet; CREATE TABLE IF NOT EXISTS already handled
        }
      };

      // Migration: agents table - display_name and alias_source for agent alias support
      addColumnIfMissing("agents", "display_name", "TEXT");
      addColumnIfMissing("agents", "alias_source", "TEXT");
      addColumnIfMissing("agents", "last_activity", "TEXT");
      addColumnIfMissing("agents", "last_activity_time", "TEXT");
      addColumnIfMissing("agents", "capabilities", "TEXT");
      addColumnIfMissing("agents", "skills", "TEXT");
      addColumnIfMissing("agents", "emoji", "TEXT");

      // Migration: messages table
      addColumnIfMissing("messages", "metadata", "TEXT");
      addColumnIfMissing("messages", "priority", "TEXT NOT NULL DEFAULT 'normal'");
      addColumnIfMissing("messages", "reply_to_msg_id", "TEXT");
      addColumnIfMissing("messages", "edited_at", "TEXT");
      addColumnIfMissing("messages", "edit_version", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing("messages", "author_id", "TEXT");
      addColumnIfMissing("messages", "author_name", "TEXT");
      addColumnIfMissing("messages", "author_emoji", "TEXT");

      // Migration: threads table
      addColumnIfMissing("threads", "system_prompt", "TEXT");
      addColumnIfMissing("threads", "template_id", "TEXT");
      addColumnIfMissing("threads", "updated_at", "TEXT NOT NULL DEFAULT ''");
      this.persistenceDb.prepare(
        "UPDATE threads SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = ''"
      ).run();

      // Migration: reply_tokens table
      addColumnIfMissing("reply_tokens", "agent_id", "TEXT");
      addColumnIfMissing("reply_tokens", "source", "TEXT");
      addColumnIfMissing("reply_tokens", "fast_returned_at", "TEXT");

      // Migration: thread_settings table
      addColumnIfMissing("thread_settings", "creator_admin_id", "TEXT");
      addColumnIfMissing("thread_settings", "creator_admin_name", "TEXT");
      addColumnIfMissing("thread_settings", "creator_assignment_time", "TEXT");
      addColumnIfMissing("thread_settings", "switch_timeout_seconds", "INTEGER NOT NULL DEFAULT 60");
      // New fields for thread activity tracking and admin assignment
      addColumnIfMissing("thread_settings", "last_activity_time", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing("thread_settings", "auto_assigned_admin_id", "TEXT");
      addColumnIfMissing("thread_settings", "auto_assigned_admin_name", "TEXT");
      addColumnIfMissing("thread_settings", "admin_assignment_time", "TEXT");
      addColumnIfMissing("thread_settings", "created_at", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing("thread_settings", "updated_at", "TEXT NOT NULL DEFAULT ''");
    };

    runMigrations();
  }

  private upsertThread(thread: ThreadRecord): void {
    const updatedAt = thread.updated_at || new Date().toISOString();
    this.persistenceDb.prepare(
      `
        INSERT INTO threads (id, topic, status, created_at, updated_at, system_prompt, template_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          topic = excluded.topic,
          status = excluded.status,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          system_prompt = excluded.system_prompt,
          template_id = excluded.template_id
      `
    ).run(thread.id, thread.topic, thread.status as string, thread.created_at, updatedAt, thread.system_prompt || null, thread.template_id || null);
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
    // Update in-memory map FIRST (critical for getWaitingAgentsForThread to see changes)
    this.agents.set(agent.id, agent);
    
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
      agent.token || null,
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
    const now = new Date().toISOString();
    this.persistenceDb.prepare(
      `
        INSERT INTO thread_settings (
          thread_id, auto_administrator_enabled, timeout_seconds, switch_timeout_seconds,
          last_activity_time, auto_assigned_admin_id, auto_assigned_admin_name, admin_assignment_time,
          creator_admin_id, creator_admin_name, creator_assignment_time, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          auto_administrator_enabled = excluded.auto_administrator_enabled,
          timeout_seconds = excluded.timeout_seconds,
          switch_timeout_seconds = excluded.switch_timeout_seconds,
          last_activity_time = excluded.last_activity_time,
          auto_assigned_admin_id = excluded.auto_assigned_admin_id,
          auto_assigned_admin_name = excluded.auto_assigned_admin_name,
          admin_assignment_time = excluded.admin_assignment_time,
          creator_admin_id = excluded.creator_admin_id,
          creator_admin_name = excluded.creator_admin_name,
          creator_assignment_time = excluded.creator_assignment_time,
          updated_at = excluded.updated_at
      `
    ).run(
      threadId,
      settings.auto_administrator_enabled ? 1 : 0,
      settings.timeout_seconds,
      settings.switch_timeout_seconds,
      settings.last_activity_time,
      settings.auto_assigned_admin_id || null,
      settings.auto_assigned_admin_name || null,
      settings.admin_assignment_time || null,
      settings.creator_admin_id || null,
      settings.creator_admin_name || null,
      settings.creator_assignment_time || null,
      now,
      now
    );
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

  invalidateReplyTokensForAgent(threadId: string, agentId: string): void {
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