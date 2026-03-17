/**
 * Metrics Unit Tests
 * Ported from Python: tests/test_metrics.py
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

describe('Metrics Unit Tests', () => {
  let store: MemoryStore;

  beforeEach(() => {
    process.env.AGENTCHATBUS_DB = ':memory:';
    store = new MemoryStore();
    store.reset();
  });

  function postMessage(threadId: string, author: string, content: string, metadata?: Record<string, unknown>) {
    const sync = store.issueSyncContext(threadId, author, 'test');
    return store.postMessage({
      threadId,
      author,
      content,
      metadata,
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
      role: 'user'
    });
  }

  it('metrics returns empty db baseline', () => {
    const m = store.getMetrics() as any;
    expect(m.threads.total).toBe(0);
    expect(m.threads.by_status).toEqual({});
    expect(m.messages.total).toBe(0);
    expect(m.messages.rate.last_1m).toBe(0);
    expect(m.messages.rate.last_5m).toBe(0);
    expect(m.messages.rate.last_15m).toBe(0);
    expect(m.agents.total).toBe(0);
    expect(m.agents.online).toBe(0);

    for (const reason of ['convergence', 'timeout', 'complete', 'error', 'impasse']) {
      expect(m.messages.stop_reasons?.[reason] ?? 0).toBe(0);
    }
  });

  it('metrics thread counts by status', () => {
    const t1 = store.createThread('Thread 1').thread;
    store.createThread('Thread 2');
    store.createThread('Thread 3');
    store.closeThread(t1.id, 'done');

    const m = store.getMetrics();
    expect(m.threads.total).toBe(3);
    expect(m.threads.by_status.discuss).toBe(2);
    expect(m.threads.by_status.closed).toBe(1);
  });

  it('metrics message total', () => {
    const thread = store.createThread('Msg Total Thread').thread;
    postMessage(thread.id, 'agent-a', 'message 1');
    postMessage(thread.id, 'agent-a', 'message 2');

    const m = store.getMetrics();
    expect(m.messages.total).toBe(2);
  });

  it('metrics stop_reason distribution', () => {
    const thread = store.createThread('Stop Reason Thread').thread;
    postMessage(thread.id, 'agent-a', 'm1', { stop_reason: 'convergence' });
    postMessage(thread.id, 'agent-a', 'm2', { stop_reason: 'convergence' });
    postMessage(thread.id, 'agent-a', 'm3', { stop_reason: 'timeout' });
    postMessage(thread.id, 'agent-a', 'm4');

    const m = store.getMetrics() as any;
    expect(m.messages.stop_reasons.convergence).toBe(2);
    expect(m.messages.stop_reasons.timeout).toBe(1);
    expect(m.messages.stop_reasons.complete).toBe(0);
    expect(m.messages.stop_reasons.error).toBe(0);
    expect(m.messages.stop_reasons.impasse).toBe(0);
  });

  it('metrics agent counts', () => {
    const a1 = store.registerAgent({ ide: 'VS Code', model: 'GPT-4' });
    store.registerAgent({ ide: 'Cursor', model: 'Claude' });

    // Force one stale heartbeat to simulate offline
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    (store as any).persistenceDb.prepare('UPDATE agents SET last_heartbeat = ? WHERE id = ?').run(old, a1.id);

    const m = store.getMetrics();
    expect(m.agents.total).toBe(2);
    expect(m.agents.online).toBeLessThan(m.agents.total);
  });

  it('metrics has required fields', () => {
    const m = store.getMetrics();

    expect(m.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(m.started_at).toBeDefined();
    expect(m.schema_version).toBeDefined();
    expect(m.threads).toBeDefined();
    expect(m.messages).toBeDefined();
    expect(m.agents).toBeDefined();
  });

  // Ported from Python: test_metrics_message_rate_windows
  it('metrics message rate windows', () => {
    const thread = store.createThread('Rate Window Thread').thread;

    // Insert messages with controlled timestamps
    const now = Date.now();

    // 30 seconds ago - should be in all windows
    const ts30s = new Date(now - 30 * 1000).toISOString();
    insertMessageWithTimestamp(thread.id, ts30s, 1);

    // 3 minutes ago - should be in 5m and 15m, NOT 1m
    const ts3m = new Date(now - 3 * 60 * 1000).toISOString();
    insertMessageWithTimestamp(thread.id, ts3m, 2);

    // 10 minutes ago - should be in 15m only
    const ts10m = new Date(now - 10 * 60 * 1000).toISOString();
    insertMessageWithTimestamp(thread.id, ts10m, 3);

    // 20 minutes ago - should be in none of the windows
    const ts20m = new Date(now - 20 * 60 * 1000).toISOString();
    insertMessageWithTimestamp(thread.id, ts20m, 4);

    const m = store.getMetrics();
    expect(m.messages.rate.last_1m).toBeGreaterThanOrEqual(1);  // 30s message
    expect(m.messages.rate.last_5m).toBeGreaterThanOrEqual(2);  // 30s + 3m
    expect(m.messages.rate.last_15m).toBeGreaterThanOrEqual(3); // 30s + 3m + 10m
    // The 20m message must NOT appear in last_15m
    expect(m.messages.rate.last_15m).toBeLessThan(m.messages.total);
  });

  // Ported from Python: test_metrics_avg_latency_with_messages
  it('metrics avg_latency_ms with multiple messages', () => {
    const thread = store.createThread('Latency Thread').thread;
    const now = Date.now();

    // Three messages 5 seconds apart, all within the last 15 minutes
    for (let i = 0; i < 3; i++) {
      const ts = new Date(now - (10 - i * 5) * 1000).toISOString();
      insertMessageWithTimestamp(thread.id, ts, 100 + i);
    }

    const m = store.getMetrics();
    expect(m.messages.avg_latency_ms).not.toBeNull();
    expect(m.messages.avg_latency_ms).toBeGreaterThan(0);
  });

  // Ported from Python: test_metrics_avg_latency_single_message
  it('metrics avg_latency_ms null with single message', () => {
    const thread = store.createThread('Single Msg Thread').thread;
    const now = Date.now();
    const ts = new Date(now - 30 * 1000).toISOString();
    insertMessageWithTimestamp(thread.id, ts, 1);

    const m = store.getMetrics();
    expect(m.messages.avg_latency_ms).toBeNull();
  });

  // Ported from Python: test_metrics_stop_reason_empty
  it('metrics stop_reason empty when no stop_reasons in messages', () => {
    const thread = store.createThread('No Stop Reason Thread').thread;
    // Plain message with no stop_reason metadata
    postMessage(thread.id, 'agent-a', 'plain message');

    const m = store.getMetrics() as any;
    for (const reason of ['convergence', 'timeout', 'complete', 'error', 'impasse']) {
      expect(m.messages.stop_reasons[reason]).toBe(0);
    }
  });

  // Ported from Python: test_metrics_agent_counts_total
  it('metrics agent counts total', () => {
    const before = store.getMetrics();
    const initial = before.agents.total;

    store.registerAgent({ ide: 'IDE-A', model: 'model-x' });
    store.registerAgent({ ide: 'IDE-B', model: 'model-y' });

    const m = store.getMetrics();
    expect(m.agents.total).toBe(initial + 2);
  });

  // Helper: Insert message with controlled timestamp (match Python _insert_message_with_timestamp)
  function insertMessageWithTimestamp(threadId: string, createdAt: string, seq: number) {
    const id = `msg-${seq}-${Date.now()}`;
    (store as any).persistenceDb.prepare(
      `INSERT INTO messages (id, thread_id, author, role, content, seq, created_at, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, threadId, 'test-agent', 'user', 'test content', seq, createdAt, 'normal');
  }

  // Ported from Python: test_metrics_agent_online_offline
  it('metrics agent online offline status', () => {
    const a1 = store.registerAgent({ ide: 'VS Code', model: 'GPT-4' });
    const a2 = store.registerAgent({ ide: 'Cursor', model: 'Claude' });

    // Both agents initially online
    let m = store.getMetrics();
    expect(m.agents.online).toBe(2);

    // Make a1 offline (heartbeat older than timeout)
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    (store as any).persistenceDb.prepare('UPDATE agents SET last_heartbeat = ? WHERE id = ?').run(old, a1.id);

    m = store.getMetrics();
    expect(m.agents.online).toBe(1);
    expect(m.agents.total).toBe(2);
  });

  // Ported from Python: test_api_metrics_returns_200 (HTTP layer test - adapted for unit)
  it('metrics returns valid json structure', () => {
    const m = store.getMetrics();
    
    // Verify JSON-serializable structure
    const json = JSON.stringify(m);
    const parsed = JSON.parse(json);
    
    expect(parsed.threads).toBeDefined();
    expect(parsed.messages).toBeDefined();
    expect(parsed.agents).toBeDefined();
    expect(parsed.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  // Ported from Python: test_api_metrics_schema_keys
  it('metrics schema has all required keys', () => {
    const m = store.getMetrics() as any;
    
    // Top-level keys
    expect(m.uptime_seconds).toBeDefined();
    expect(m.started_at).toBeDefined();
    expect(m.schema_version).toBeDefined();
    
    // Threads keys
    expect(m.threads.total).toBeDefined();
    expect(m.threads.by_status).toBeDefined();
    
    // Messages keys
    expect(m.messages.total).toBeDefined();
    expect(m.messages.rate).toBeDefined();
    expect(m.messages.rate.last_1m).toBeDefined();
    expect(m.messages.rate.last_5m).toBeDefined();
    expect(m.messages.rate.last_15m).toBeDefined();
    
    // Agents keys
    expect(m.agents.total).toBeDefined();
    expect(m.agents.online).toBeDefined();
  });

  // Ported from Python: test_api_metrics_uptime_positive
  it('metrics uptime is positive after start', () => {
    const m = store.getMetrics();
    
    // Uptime should be non-negative
    expect(m.uptime_seconds).toBeGreaterThanOrEqual(0);
    
    // Wait a bit and check again
    const start = m.uptime_seconds;
    const m2 = store.getMetrics();
    expect(m2.uptime_seconds).toBeGreaterThanOrEqual(start);
  });
});
