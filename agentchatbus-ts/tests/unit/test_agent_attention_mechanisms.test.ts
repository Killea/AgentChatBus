/**
 * Agent Attention Mechanisms Tests
 *
 * 移植自：Python tests/test_agent_attention_mechanisms.py
 * 说明：实现与 Python 版本等价的断言。
 * 已实现：关注字段保留（enabled）场景。
 * 待实现：在 TS 中实现全局 feature-flag（ENABLE_HANDOFF_TARGET/ENABLE_STOP_REASON/ENABLE_PRIORITY）后，
 *      取消对 disabled 场景的 skip 并改为真实断言。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

async function postMsgWithAttention(store: MemoryStore, threadId: string) {
  const sync = store.issueSyncContext(threadId);
  return store.postMessage({
    threadId,
    author: 'agent-test',
    content: 'Testing attention mechanisms',
    expectedLastSeq: sync.current_seq,
    replyToken: sync.reply_token,
    metadata: { handoff_target: 'agent-xyz', stop_reason: 'timeout' },
    priority: 'urgent'
  });
}

describe('Agent Attention Mechanisms (Ported from Python)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(':memory:');
  });

  it('msg_get preserves attention fields when enabled', async () => {
    const { thread } = store.createThread('Topic');
    const msg = await postMsgWithAttention(store, thread.id);

    const fetched = store.getMessage(msg.id);
    expect(fetched).toBeDefined();
    expect(fetched?.priority).toBe('urgent');

    const meta = fetched?.metadata as any;
    expect(meta).toBeDefined();
    expect(meta.handoff_target).toBe('agent-xyz');
    expect(meta.stop_reason).toBe('timeout');
  });

  it.skip('msg_get strips attention fields when disabled (TODO: implement flags)', async () => {
    // TODO: implement feature flags in TS to replicate Python behavior
    // This test mirrors Python test_msg_get_attention_disabled
  });

  it.skip('msg_list strips attention fields when disabled (TODO: implement flags)', async () => {
    // TODO: implement feature flags in TS to replicate Python behavior
  });

  it.skip('msg_wait strips attention fields when disabled (TODO: implement flags)', async () => {
    // TODO: implement feature flags in TS to replicate Python behavior
  });

  it('msg_post returns attention fields when enabled', async () => {
    const { thread } = store.createThread('Topic');
    // issue sync then post
    const sync = store.issueSyncContext(thread.id);

    const result = store.postMessage({
      threadId: thread.id,
      author: 'agent-test',
      content: 'Testing post attention enabled',
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
      metadata: { handoff_target: 'agent-xyz', stop_reason: 'timeout' },
      priority: 'urgent'
    });

    expect(result.priority).toBe('urgent');
    const meta = result.metadata as any;
    expect(meta.handoff_target).toBe('agent-xyz');
    expect(meta.stop_reason).toBe('timeout');
  });

  it.skip('msg_post strips attention fields when disabled (TODO: implement flags)', async () => {
    // TODO: implement feature flags in TS to replicate Python behavior
  });
});
