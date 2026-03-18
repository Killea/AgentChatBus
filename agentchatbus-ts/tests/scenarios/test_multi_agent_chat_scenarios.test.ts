/**
 * Scenario-level regression tests for realistic multi-agent chat flows.
 * Ported from Python: tests/test_multi_agent_chat_scenarios.py
 *
 * These tests intentionally exercise business behavior instead of isolated helper
 * contracts. The goal is to protect the real chat experience that agents rely on:
 *
 * 1. Multiple agents join the same thread through bus_connect.
 * 2. Agents alternate between msg_post and msg_wait over several rounds.
 * 3. One agent falls behind while other agents keep chatting.
 * 4. That agent's stale msg_post is rejected with SeqMismatchError.
 * 5. The rejected agent then calls msg_wait and must receive a fast recovery path:
 *    the wait returns immediately with missed messages plus a fresh reply_token.
 * 6. Using that fresh sync context, the agent must be able to rejoin the chat and
 *    post successfully.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';
import {
  MissingSyncFieldsError,
  ReplyTokenInvalidError,
  ReplyTokenReplayError,
  SeqMismatchError
} from '../../src/core/types/errors.js';

const FAST_RETURN_MAX_MS = 110;

describe('Multi-Agent Chat Scenarios (Ported from Python)', () => {
  let store: MemoryStore;
  let agentTokens: Map<string, string>;

  beforeEach(() => {
    process.env.AGENTCHATBUS_DB = ':memory:';
    store = new MemoryStore();
    store.reset();
    agentTokens = new Map();
  });

  afterEach(() => {
    // Clean up any pending async operations
  });

  // Helper: Simulate bus_connect - register agent and join/create thread
  async function busConnect(threadName: string, ide: string, model: string): Promise<{
    threadId: string;
    agentId: string;
    token: string;
    currentSeq: number;
    replyToken: string;
    messages: ReturnType<typeof store.getMessages>;
  }> {
    const agent = store.registerAgent({ ide, model });
    agentTokens.set(agent.id, agent.token);
    const { thread } = store.createThread(threadName);
    const messages = store.getMessages(thread.id, 0);
    const sync = store.issueSyncContext(thread.id, agent.id, 'bus_connect');

    return {
      threadId: thread.id,
      agentId: agent.id,
      token: agent.token,
      currentSeq: sync.current_seq,
      replyToken: sync.reply_token,
      messages
    };
  }

  // Helper: Post a message as an agent
  async function postAs(
    threadId: string,
    agentId: string,
    content: string,
    expectedLastSeq: number,
    replyToken: string,
    role: 'assistant' | 'user' = 'assistant'
    ): Promise<{ seq: number; message: ReturnType<typeof store.getMessage> } | { error: string; action?: string; new_messages_1st_read?: ReturnType<typeof store.getMessages> }> {
    try {
      const message = store.postMessage({
        threadId,
        author: agentId,
        content,
        expectedLastSeq,
        replyToken,
        role
      });
      return { seq: message.seq, message };
    } catch (error) {
      if (
        error instanceof MissingSyncFieldsError ||
        error instanceof SeqMismatchError ||
        error instanceof ReplyTokenInvalidError ||
        error instanceof ReplyTokenReplayError
      ) {
        store.invalidateReplyTokensForAgent(threadId, agentId);
        store.setRefreshRequest(threadId, agentId, error.constructor.name);
      }
      if (error instanceof SeqMismatchError) {
        return {
          error: 'SeqMismatchError',
          action: 'READ_MESSAGES_THEN_CALL_MSG_WAIT',
          new_messages_1st_read: error.new_messages
        };
      }
      if (error instanceof ReplyTokenReplayError) {
        return {
          error: 'ReplyTokenReplayError',
          action: 'CALL_MSG_WAIT'
        };
      }
      throw error;
    }
  }

  // Helper: Wait for messages as an agent
  async function waitAs(
    threadId: string,
    agentId: string,
    afterSeq: number,
    timeoutMs: number = 50
  ): Promise<{
    messages: ReturnType<typeof store.getMessages>;
    current_seq: number;
    reply_token: string;
    fast_return: boolean;
  }> {
    const result = await store.waitForMessages({
      threadId,
      agentId,
      agentToken: agentTokens.get(agentId),
      afterSeq,
      timeoutMs
    });
    return {
      messages: result.messages,
      current_seq: result.current_seq,
      reply_token: result.reply_token,
      fast_return: result.fast_return
    };
  }

  it('three_agent_chat_recovers_from_rejected_stale_post_via_fast_wait_refresh', async () => {
    /**
     * Protect the real three-agent chat flow, including stale-post recovery.
     *
     * Scenario requirements:
     * - Agent A starts the thread and posts.
     * - Agent B joins and replies.
     * - Agent C joins after the conversation has already started.
     * - B obtains a valid msg_wait token, then goes silent while A and C continue
     *   chatting for enough rounds to push B outside seq tolerance.
     * - B's old post must be rejected with SeqMismatchError and must include the
     *   missed messages for first-read guidance.
     * - B's very next msg_wait must fast-return with the same missed messages and
     *   a fresh reply_token so B can recover without getting stuck waiting.
     * - B then posts successfully with the refreshed sync context.
     * - The final transcript must show the full conversation in order.
     */
    const threadName = 'Scenario Three Agent Recovery';

    // Agent A connects and posts first message
    const connectA = await busConnect(threadName, 'VS Code', 'GPT-5.3-Codex');
    const threadId = connectA.threadId;
    const agentAId = connectA.agentId;
    const agentAToken = connectA.token;

    const postA1 = await postAs(threadId, agentAId, 'A1: starting the discussion', connectA.currentSeq, connectA.replyToken);
    expect(postA1).toHaveProperty('seq', 1);

    // Agent B joins and sees A1
    const connectB = await busConnect(threadName, 'VS Code', 'GPT-5.3-Codex');
    const agentBId = connectB.agentId;
    const agentBToken = connectB.token;
    expect(connectB.currentSeq).toBe(1);
    expect(connectB.messages.some(m => m.content === 'A1: starting the discussion')).toBe(true);

    const postB1 = await postAs(threadId, agentBId, 'B1: I joined and reviewed A\'s idea', connectB.currentSeq, connectB.replyToken);
    expect(postB1).toHaveProperty('seq', 2);

    // Agent C joins and sees A1, B1
    const connectC = await busConnect(threadName, 'VS Code', 'GPT-5.3-Codex');
    const agentCId = connectC.agentId;
    const agentCToken = connectC.token;
    expect(connectC.currentSeq).toBe(2);
    expect(connectC.messages.some(m => m.content === 'A1: starting the discussion')).toBe(true);
    expect(connectC.messages.some(m => m.content === 'B1: I joined and reviewed A\'s idea')).toBe(true);

    // B gets a valid wait token at seq=2, then falls behind while A and C keep chatting.
    const bStaleSync = await waitAs(threadId, agentBId, 2, 1);
    expect(bStaleSync.messages).toEqual([]);
    expect(bStaleSync.current_seq).toBe(2);

    // A and C continue chatting (multiple rounds)
    const waitA1 = await waitAs(threadId, agentAId, 1, 50);
    expect(waitA1.messages.map(m => m.content)).toEqual(['B1: I joined and reviewed A\'s idea']);
    const postA2 = await postAs(threadId, agentAId, 'A2: I propose we split the work', waitA1.current_seq, waitA1.reply_token);
    expect(postA2).toHaveProperty('seq', 3);

    const waitC1 = await waitAs(threadId, agentCId, 2, 50);
    expect(waitC1.messages.map(m => m.content)).toEqual(['A2: I propose we split the work']);
    const postC1 = await postAs(threadId, agentCId, 'C1: I can take the validation path', waitC1.current_seq, waitC1.reply_token);
    expect(postC1).toHaveProperty('seq', 4);

    const waitA2 = await waitAs(threadId, agentAId, 3, 50);
    expect(waitA2.messages.map(m => m.content)).toEqual(['C1: I can take the validation path']);
    const postA3 = await postAs(threadId, agentAId, 'A3: I will update dispatch behavior', waitA2.current_seq, waitA2.reply_token);
    expect(postA3).toHaveProperty('seq', 5);

    const waitC2 = await waitAs(threadId, agentCId, 4, 50);
    expect(waitC2.messages.map(m => m.content)).toEqual(['A3: I will update dispatch behavior']);
    const postC2 = await postAs(threadId, agentCId, 'C2: I will cover regression tests', waitC2.current_seq, waitC2.reply_token);
    expect(postC2).toHaveProperty('seq', 6);

    const waitA3 = await waitAs(threadId, agentAId, 5, 50);
    expect(waitA3.messages.map(m => m.content)).toEqual(['C2: I will cover regression tests']);
    const postA4 = await postAs(threadId, agentAId, 'A4: please verify the fast-return edge case', waitA3.current_seq, waitA3.reply_token);
    expect(postA4).toHaveProperty('seq', 7);

    const waitC3 = await waitAs(threadId, agentCId, 6, 50);
    expect(waitC3.messages.map(m => m.content)).toEqual(['A4: please verify the fast-return edge case']);
    const postC3 = await postAs(threadId, agentCId, 'C3: verified, the chat is still moving', waitC3.current_seq, waitC3.reply_token);
    expect(postC3).toHaveProperty('seq', 8);

    // B is still trying to speak with the stale sync context captured earlier at seq=2.
    const stalePost = await postAs(
      threadId,
      agentBId,
      'B-stale: I am posting with outdated context',
      bStaleSync.current_seq,
      bStaleSync.reply_token
    );
    expect(stalePost).toHaveProperty('error', 'SeqMismatchError');
    expect(stalePost).toHaveProperty('action', 'READ_MESSAGES_THEN_CALL_MSG_WAIT');
    expect((stalePost as any).new_messages_1st_read?.map(m => m.content)).toEqual([
      'A2: I propose we split the work',
      'C1: I can take the validation path',
      'A3: I will update dispatch behavior',
      'C2: I will cover regression tests',
      'A4: please verify the fast-return edge case',
      'C3: verified, the chat is still moving',
    ]);

    // B's next msg_wait must fast-return with missed messages
    const refreshStart = Date.now();
    const waitBRefresh = await waitAs(threadId, agentBId, 2, 120);
    const refreshElapsed = Date.now() - refreshStart;
    expect(refreshElapsed).toBeLessThan(80); // Fast return should be immediate
    expect(waitBRefresh.current_seq).toBe(8);
    expect(waitBRefresh.messages.map(m => m.content)).toEqual([
      'A2: I propose we split the work',
      'C1: I can take the validation path',
      'A3: I will update dispatch behavior',
      'C2: I will cover regression tests',
      'A4: please verify the fast-return edge case',
      'C3: verified, the chat is still moving',
    ]);
    // When there are messages, fast_return is false (messages take priority)
    // The key is that the wait returned quickly (< 80ms), not the fast_return flag
    expect(waitBRefresh.fast_return).toBe(false);

    // B can now post successfully
    const postB2 = await postAs(
      threadId,
      agentBId,
      'B2: I caught up and can continue normally now',
      waitBRefresh.current_seq,
      waitBRefresh.reply_token
    );
    expect(postB2).toHaveProperty('seq', 9);

    // Final transcript must show full conversation in order
    const transcript = store.getMessages(threadId, 0);
    const assistantMessages = transcript.filter(m => m.role === 'assistant');
    expect(assistantMessages.map(m => m.content)).toEqual([
      'A1: starting the discussion',
      'B1: I joined and reviewed A\'s idea',
      'A2: I propose we split the work',
      'C1: I can take the validation path',
      'A3: I will update dispatch behavior',
      'C2: I will cover regression tests',
      'A4: please verify the fast-return edge case',
      'C3: verified, the chat is still moving',
      'B2: I caught up and can continue normally now',
    ]);
  });

  it('single_agent_empty_room_waits_normally_instead_of_fast_returning', async () => {
    /**
     * Protect the most common idle-chat behavior: one agent waiting for others.
     *
     * Business requirement:
     * - A single agent entering an empty or quiet thread is usually waiting for
     *   another participant to arrive.
     * - In that state, msg_wait must perform a real wait.
     * - It must not fast-return unless there was a prior msg_post failure that
     *   explicitly requested a one-shot refresh.
     */
    const connectA = await busConnect('Scenario Single Agent Idle Wait', 'VS Code', 'GPT-5.3-Codex');
    const threadId = connectA.threadId;
    const agentAId = connectA.agentId;

    const postA1 = await postAs(threadId, agentAId, 'A1: I am here and waiting for collaborators', connectA.currentSeq, connectA.replyToken);
    expect(postA1).toHaveProperty('seq', 1);

    // Single agent should wait normally (not fast-return)
    const start = Date.now();
    const waitA = await waitAs(threadId, agentAId, 1, 120);
    const elapsed = Date.now() - start;

    expect(waitA.messages).toEqual([]);
    expect(waitA.current_seq).toBe(1);
    // Should have waited the full timeout (or close to it), not fast-returned
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it('three_agent_chat_can_recover_from_two_separate_stale_post_failures', async () => {
    /**
     * Protect repeated recovery cycles, not just the first one.
     *
     * Why this matters:
     * - A future refactor might make the first refresh succeed but fail to clear or
     *   re-arm the refresh state correctly for a second stale-post incident.
     * - In real chats, an agent can fall behind, recover, and then fall behind
     *   again a few turns later.
     *
     * This scenario intentionally forces the same agent through two distinct
     * SeqMismatchError -> msg_wait fast-return -> successful recovery cycles.
     */
    const threadName = 'Scenario Repeated Recovery';

    const connectA = await busConnect(threadName, 'VS Code', 'GPT-5.3-Codex');
    const threadId = connectA.threadId;
    const agentAId = connectA.agentId;
    const agentAToken = connectA.token;

    const postA1 = await postAs(threadId, agentAId, 'A1: open the thread', connectA.currentSeq, connectA.replyToken);
    expect(postA1).toHaveProperty('seq', 1);

    const connectB = await busConnect(threadName, 'VS Code', 'GPT-5.3-Codex');
    const agentBId = connectB.agentId;
    const agentBToken = connectB.token;

    const postB1 = await postAs(threadId, agentBId, 'B1: I am in', connectB.currentSeq, connectB.replyToken);
    expect(postB1).toHaveProperty('seq', 2);

    const connectC = await busConnect(threadName, 'VS Code', 'GPT-5.3-Codex');
    const agentCId = connectC.agentId;

    // B gets sync at seq=2
    const bSyncRound1 = await waitAs(threadId, agentBId, 2, 1);
    expect(bSyncRound1.current_seq).toBe(2);

    // A and C continue - first burst
    const waitA1 = await waitAs(threadId, agentAId, 1, 50);
    expect(waitA1.messages.map(m => m.content)).toEqual(['B1: I am in']);
    const postA2 = await postAs(threadId, agentAId, 'A2: first burst 1', waitA1.current_seq, waitA1.reply_token);
    expect(postA2).toHaveProperty('seq', 3);

    const waitC1 = await waitAs(threadId, agentCId, 2, 50);
    expect(waitC1.messages.map(m => m.content)).toEqual(['A2: first burst 1']);
    const postC1 = await postAs(threadId, agentCId, 'C1: first burst 2', waitC1.current_seq, waitC1.reply_token);
    expect(postC1).toHaveProperty('seq', 4);

    const waitA2 = await waitAs(threadId, agentAId, 3, 50);
    const postA3 = await postAs(threadId, agentAId, 'A3: first burst 3', waitA2.current_seq, waitA2.reply_token);
    expect(postA3).toHaveProperty('seq', 5);

    const waitC2 = await waitAs(threadId, agentCId, 4, 50);
    const postC2 = await postAs(threadId, agentCId, 'C2: first burst 4', waitC2.current_seq, waitC2.reply_token);
    expect(postC2).toHaveProperty('seq', 6);

    const waitA3 = await waitAs(threadId, agentAId, 5, 50);
    const postA4 = await postAs(threadId, agentAId, 'A4: first burst 5', waitA3.current_seq, waitA3.reply_token);
    expect(postA4).toHaveProperty('seq', 7);

    const waitC3 = await waitAs(threadId, agentCId, 6, 50);
    const postC3 = await postAs(threadId, agentCId, 'C3: first burst 6', waitC3.current_seq, waitC3.reply_token);
    expect(postC3).toHaveProperty('seq', 8);

    // Round 1: B's stale post is rejected
    const stalePostRound1 = await postAs(
      threadId,
      agentBId,
      'B-stale-1: too old',
      bSyncRound1.current_seq,
      bSyncRound1.reply_token
    );
    expect(stalePostRound1).toHaveProperty('error', 'SeqMismatchError');
    expect((stalePostRound1 as any).new_messages_1st_read?.length).toBe(6);

    // B's msg_wait fast-returns
    const refreshRound1Start = Date.now();
    const waitBRound1 = await waitAs(threadId, agentBId, 2, 120);
    expect(Date.now() - refreshRound1Start).toBeLessThan(FAST_RETURN_MAX_MS);
    expect(waitBRound1.current_seq).toBe(8);
    expect(waitBRound1.messages.length).toBe(6);

    // B gets a fresh token at seq=8 but falls behind again
    const waitA4 = await waitAs(threadId, agentAId, 7, 50);
    const postA5 = await postAs(threadId, agentAId, 'A5: second burst 1', waitA4.current_seq, waitA4.reply_token);
    expect(postA5).toHaveProperty('seq', 9);

    const waitC4 = await waitAs(threadId, agentCId, 8, 50);
    const postC4 = await postAs(threadId, agentCId, 'C4: second burst 2', waitC4.current_seq, waitC4.reply_token);
    expect(postC4).toHaveProperty('seq', 10);

    const waitA5 = await waitAs(threadId, agentAId, 9, 50);
    const postA6 = await postAs(threadId, agentAId, 'A6: second burst 3', waitA5.current_seq, waitA5.reply_token);
    expect(postA6).toHaveProperty('seq', 11);

    const waitC5 = await waitAs(threadId, agentCId, 10, 50);
    const postC5 = await postAs(threadId, agentCId, 'C5: second burst 4', waitC5.current_seq, waitC5.reply_token);
    expect(postC5).toHaveProperty('seq', 12);

    const waitA6 = await waitAs(threadId, agentAId, 11, 50);
    const postA7 = await postAs(threadId, agentAId, 'A7: second burst 5', waitA6.current_seq, waitA6.reply_token);
    expect(postA7).toHaveProperty('seq', 13);

    const waitC6 = await waitAs(threadId, agentCId, 12, 50);
    const postC6 = await postAs(threadId, agentCId, 'C6: second burst 6', waitC6.current_seq, waitC6.reply_token);
    expect(postC6).toHaveProperty('seq', 14);

    // Round 2: B's stale post is rejected again
    const stalePostRound2 = await postAs(
      threadId,
      agentBId,
      'B-stale-2: too old again',
      waitBRound1.current_seq,
      waitBRound1.reply_token
    );
    expect(stalePostRound2).toHaveProperty('error', 'SeqMismatchError');
    expect((stalePostRound2 as any).new_messages_1st_read?.length).toBe(6);

    // B's msg_wait fast-returns again (second recovery)
    const refreshRound2Start = Date.now();
    const waitBRound2 = await waitAs(threadId, agentBId, 8, 120);
    expect(Date.now() - refreshRound2Start).toBeLessThan(FAST_RETURN_MAX_MS);
    expect(waitBRound2.current_seq).toBe(14);
    expect(waitBRound2.messages.length).toBe(6);

    // B posts successfully after second recovery
    const postB2 = await postAs(
      threadId,
      agentBId,
      'B2: I recovered twice and can still continue',
      waitBRound2.current_seq,
      waitBRound2.reply_token
    );
    expect(postB2).toHaveProperty('seq', 15);
  });

  it('two_agents_competing_from_same_sync_context_force_recovery_before_retry', async () => {
    /**
     * Protect the tighter race where two agents both hold sync-context at the same seq.
     *
     * Business requirement:
     * - Two agents can both be fully caught up and each hold a valid reply token
     *   for the same thread seq.
     * - Once one of them posts, the other must fail with SeqMismatchError instead
     *   of succeeding with stale context.
     * - The failed agent's next msg_wait should return quickly with the winning
     *   message and a fresh token so it can retry immediately.
     */
    const threadName = 'Scenario Same Context Competition';

    const connectA = await busConnect(threadName, 'VS Code', 'GPT-5.3-Codex');
    const threadId = connectA.threadId;
    const agentAId = connectA.agentId;

    const postA1 = await postAs(
      threadId,
      agentAId,
      'A1: baseline context for competing replies',
      connectA.currentSeq,
      connectA.replyToken
    );
    expect(postA1).toHaveProperty('seq', 1);

    const connectB = await busConnect(threadName, 'VS Code', 'GPT-5.3-Codex');
    const agentBId = connectB.agentId;
    const connectC = await busConnect(threadName, 'VS Code', 'GPT-5.3-Codex');
    const agentCId = connectC.agentId;

    const syncB = await waitAs(threadId, agentBId, 1, 1);
    const syncC = await waitAs(threadId, agentCId, 1, 1);
    expect(syncB.messages).toEqual([]);
    expect(syncC.messages).toEqual([]);
    expect(syncB.current_seq).toBe(1);
    expect(syncC.current_seq).toBe(1);

    const postB1 = await postAs(
      threadId,
      agentBId,
      'B1: I won the race from seq=1',
      syncB.current_seq,
      syncB.reply_token
    );
    expect(postB1).toHaveProperty('seq', 2);

    const stalePostC = await postAs(
      threadId,
      agentCId,
      'C-stale: I incorrectly tried to use the same seq=1 context',
      syncC.current_seq,
      syncC.reply_token
    );
    expect(stalePostC).toHaveProperty('error', 'SeqMismatchError');
    expect((stalePostC as any).new_messages_1st_read?.map((m: any) => m.content)).toEqual([
      'B1: I won the race from seq=1',
    ]);
    expect(store.getRefreshRequest(threadId, agentCId)?.reason).toBe('SeqMismatchError');

    const refreshStart = Date.now();
    const waitCRefresh = await waitAs(threadId, agentCId, 1, 120);
    expect(Date.now() - refreshStart).toBeLessThan(FAST_RETURN_MAX_MS);
    expect(waitCRefresh.current_seq).toBe(2);
    expect(waitCRefresh.messages.map(m => m.content)).toEqual([
      'B1: I won the race from seq=1',
    ]);
    expect(waitCRefresh.fast_return).toBe(false);
    expect(store.getRefreshRequest(threadId, agentCId)).toBeUndefined();

    const postC1 = await postAs(
      threadId,
      agentCId,
      'C1: recovered after the race and replied with fresh context',
      waitCRefresh.current_seq,
      waitCRefresh.reply_token
    );
    expect(postC1).toHaveProperty('seq', 3);

    const transcript = store.getMessages(threadId, 0);
    expect(transcript.filter(m => m.role === 'assistant').map(m => m.content)).toEqual([
      'A1: baseline context for competing replies',
      'B1: I won the race from seq=1',
      'C1: recovered after the race and replied with fresh context',
    ]);
  });

  it('human_only_messages_stay_redacted_across_seq_mismatch_and_recovery', async () => {
    /**
     * Protect visibility filtering when an agent falls behind across hidden system notices.
     *
     * Business requirement:
     * - SeqMismatch first-read guidance must not leak private human-only content.
     * - The follow-up recovery msg_wait should return the same redacted projection.
     * - After recovering, the agent must still be able to continue chatting normally.
     */
    const threadName = 'Scenario Human Only Recovery';

    const connectA = await busConnect(threadName, 'VS Code', 'GPT-5.3-Codex');
    const threadId = connectA.threadId;
    const agentAId = connectA.agentId;

    const postA1 = await postAs(
      threadId,
      agentAId,
      'A1: visible kickoff message',
      connectA.currentSeq,
      connectA.replyToken
    );
    expect(postA1).toHaveProperty('seq', 1);

    const connectB = await busConnect(threadName, 'VS Code', 'GPT-5.3-Codex');
    const agentBId = connectB.agentId;
    const bStaleSync = await waitAs(threadId, agentBId, 1, 1);
    expect(bStaleSync.current_seq).toBe(1);
    expect(bStaleSync.messages).toEqual([]);

    store.postSystemMessage(
      threadId,
      'human-only moderation note',
      JSON.stringify({
        visibility: 'human_only',
        ui_type: 'admin_switch_confirmation_required',
        private_body: 'do not leak this hidden body'
      })
    );

    const waitA1 = await waitAs(threadId, agentAId, 1, 50);
    expect(waitA1.messages.map(m => m.content)).toEqual(['[human-only content hidden]']);
    expect(waitA1.messages[0].metadata).not.toHaveProperty('private_body');

    const postA2 = await postAs(
      threadId,
      agentAId,
      'A2: visible follow-up after the hidden notice',
      waitA1.current_seq,
      waitA1.reply_token
    );
    expect(postA2).toHaveProperty('seq', 3);

    const stalePostB = await postAs(
      threadId,
      agentBId,
      'B-stale: this should require redacted recovery',
      bStaleSync.current_seq,
      bStaleSync.reply_token
    );
    expect(stalePostB).toHaveProperty('error', 'SeqMismatchError');
    expect((stalePostB as any).new_messages_1st_read?.map((m: any) => m.content)).toEqual([
      '[human-only content hidden]',
      'A2: visible follow-up after the hidden notice',
    ]);
    expect((stalePostB as any).new_messages_1st_read?.[0].metadata).toMatchObject({
      visibility: 'human_only',
      content_hidden: true,
      content_hidden_reason: 'human_only',
      ui_type: 'admin_switch_confirmation_required',
    });
    expect((stalePostB as any).new_messages_1st_read?.[0].metadata).not.toHaveProperty('private_body');
    expect(JSON.stringify((stalePostB as any).new_messages_1st_read?.[0].metadata)).not.toContain('private_body');

    const waitBRefresh = await waitAs(threadId, agentBId, 1, 120);
    expect(waitBRefresh.current_seq).toBe(3);
    expect(waitBRefresh.messages.map(m => m.content)).toEqual([
      '[human-only content hidden]',
      'A2: visible follow-up after the hidden notice',
    ]);
    expect(waitBRefresh.messages[0].metadata).not.toHaveProperty('private_body');
    expect(JSON.stringify(waitBRefresh.messages[0].metadata)).not.toContain('private_body');

    const postB1 = await postAs(
      threadId,
      agentBId,
      'B1: recovered without seeing the hidden body',
      waitBRefresh.current_seq,
      waitBRefresh.reply_token
    );
    expect(postB1).toHaveProperty('seq', 4);
  });

  it('replayed_msg_post_token_failure_triggers_one_shot_fast_refresh_without_fake_new_messages', async () => {
    /**
     * Protect the replay-token recovery path inside an active chat.
     *
     * This scenario is different from stale-post recovery:
     * - The token is invalid because it was already consumed, not because the
     *   agent fell behind due to lots of unseen messages.
     * - The next msg_wait must still fast-return quickly with a fresh token.
     * - Because no new context arrived, that fast-return must not invent messages.
     * - The agent should be able to immediately continue chatting with the fresh
     *   token instead of getting stuck in a long wait.
     */
    const threadName = 'Scenario Replay Token Recovery';

    const connectA = await busConnect(threadName, 'VS Code', 'GPT-5.3-Codex');
    const threadId = connectA.threadId;
    const agentAId = connectA.agentId;

    const postA1 = await postAs(threadId, agentAId, 'A1: starting a replay-sensitive conversation', connectA.currentSeq, connectA.replyToken);
    expect(postA1).toHaveProperty('seq', 1);

    const connectB = await busConnect(threadName, 'VS Code', 'GPT-5.3-Codex');
    const agentBId = connectB.agentId;
    const postB1 = await postAs(threadId, agentBId, 'B1: acknowledged', connectB.currentSeq, connectB.replyToken);
    expect(postB1).toHaveProperty('seq', 2);

    const connectC = await busConnect(threadName, 'VS Code', 'GPT-5.3-Codex');
    const agentCId = connectC.agentId;
    const postC1 = await postAs(threadId, agentCId, 'C1: also acknowledged', connectC.currentSeq, connectC.replyToken);
    expect(postC1).toHaveProperty('seq', 3);

    const waitA1 = await waitAs(threadId, agentAId, 1, 50);
    expect(waitA1.messages.map(m => m.content)).toEqual([
      'B1: acknowledged',
      'C1: also acknowledged',
    ]);

    const postA2 = await postAs(threadId, agentAId, 'A2: this uses the fresh wait token correctly', waitA1.current_seq, waitA1.reply_token);
    expect(postA2).toHaveProperty('seq', 4);

    // A tries to reuse the same token (replay attack)
    const replayPost = await postAs(
      threadId,
      agentAId,
      'A-replay: this incorrectly reuses the same token',
      waitA1.current_seq,
      waitA1.reply_token
    );
    expect(replayPost).toHaveProperty('error', 'ReplyTokenReplayError');
    expect(replayPost).toHaveProperty('action', 'CALL_MSG_WAIT');
    expect((replayPost as any).new_messages_1st_read).toBeUndefined();

    // A's msg_wait must fast-return WITHOUT fake messages
    const refreshStart = Date.now();
    const waitARecover = await waitAs(threadId, agentAId, 4, 120);
    expect(Date.now() - refreshStart).toBeLessThan(FAST_RETURN_MAX_MS);
    expect(waitARecover.messages).toEqual([]);
    expect(waitARecover.current_seq).toBe(4);

    // A can continue with fresh token
    const postA3 = await postAs(threadId, agentAId, 'A3: recovered from replay and continued normally', waitARecover.current_seq, waitARecover.reply_token);
    expect(postA3).toHaveProperty('seq', 5);

    // B sees all the messages including A's recovery
    const waitB1 = await waitAs(threadId, agentBId, 2, 50);
    expect(waitB1.messages.map(m => m.content)).toEqual([
      'C1: also acknowledged',
      'A2: this uses the fresh wait token correctly',
      'A3: recovered from replay and continued normally',
    ]);
  });
});
