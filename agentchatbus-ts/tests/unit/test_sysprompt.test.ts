/**
 * System Prompt Tests
 * Ported from Python: tests/test_sysprompt.py
 * 
 * Tests that msg_list returns synthetic system prompt messages correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';
import { randomUUID } from 'crypto';
import { unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let store: MemoryStore;
let dbPath: string;

// Match Python crud.GLOBAL_SYSTEM_PROMPT and TS memoryStore.GLOBAL_SYSTEM_PROMPT
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

beforeEach(() => {
  dbPath = join(tmpdir(), `test-sysprompt-${randomUUID()}.db`);
  store = new MemoryStore(dbPath);
});

afterEach(() => {
  try {
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
  } catch {}
});

describe('System Prompt', () => {
  it('msg_list uses builtin prompt when thread has no custom prompt', () => {
    const { thread } = store.createThread('sysprompt-default');

    const msgs = store.getMessages(thread.id, 0, true);

    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0].seq).toBe(0);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].author).toBe('system');
    expect(msgs[0].content).toBe(GLOBAL_SYSTEM_PROMPT);
  });

  it('msg_list appends thread prompt without overriding builtin prompt', () => {
    const customPrompt = 'Creator preference: prioritize concise updates.';
    const { thread } = store.createThread('sysprompt-custom', customPrompt);

    const msgs = store.getMessages(thread.id, 0, true);

    expect(msgs.length).toBeGreaterThan(0);
    const promptText = msgs[0].content;

    expect(promptText).toContain('## Section: System (Built-in)');
    expect(promptText).toContain('## Section: Thread Create (Provided By Creator)');
    expect(promptText).toContain(GLOBAL_SYSTEM_PROMPT);
    expect(promptText).toContain(customPrompt);

    // Ensure built-in guidance appears before custom guidance.
    const builtinIndex = promptText.indexOf(GLOBAL_SYSTEM_PROMPT);
    const customIndex = promptText.indexOf(customPrompt);
    expect(builtinIndex).toBeLessThan(customIndex);
  });

  it('msg_list without include_system_prompt does not include system message', () => {
    const { thread } = store.createThread('sysprompt-exclude');
    
    // Post a regular message first
    const sync = store.issueSyncContext(thread.id);
    store.postMessage({
      threadId: thread.id,
      author: 'user',
      content: 'Hello',
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
    });

    const msgs = store.getMessages(thread.id, 0, false);

    // Should not include synthetic system message
    expect(msgs.some(m => m.role === 'system')).toBe(false);
  });

  it('msg_list with after_seq > 0 does not include system prompt', () => {
    const { thread } = store.createThread('sysprompt-after-seq');
    
    // Post a regular message
    const sync1 = store.issueSyncContext(thread.id);
    const msg1 = store.postMessage({
      threadId: thread.id,
      author: 'user',
      content: 'First',
      expectedLastSeq: sync1.current_seq,
      replyToken: sync1.reply_token,
    });

    // Request messages after seq 0 - should not include system prompt
    const msgs = store.getMessages(thread.id, 0, true);
    expect(msgs[0].role).toBe('system'); // This is for afterSeq=0

    // Now get messages after seq > 0
    const sync2 = store.issueSyncContext(thread.id);
    store.postMessage({
      threadId: thread.id,
      author: 'user',
      content: 'Second',
      expectedLastSeq: sync2.current_seq,
      replyToken: sync2.reply_token,
    });

    const msgsAfter = store.getMessages(thread.id, msg1.seq, true);
    // Should not include system message when afterSeq > 0
    expect(msgsAfter.every(m => m.seq > 0)).toBe(true);
  });
});
