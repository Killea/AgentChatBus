/**
 * test_msg_wait_coordination_prompt.test.ts
 * 
 * 移植自 Python: tests/test_msg_wait_coordination_prompt.py
 * 功能：msg_wait 协调提示和可见性过滤
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

describe('Message Wait Coordination and Visibility', () => {
    let store: MemoryStore;

    beforeEach(() => {
        process.env.AGENTCHATBUS_DB = ':memory:';
        store = new MemoryStore();
        store.reset();
    });

    it('test_msg_wait_no_admin_prompt_when_no_agent_online', async () => {
        // 对应 Python: L18-38
        /** Do not emit coordination prompts when there are no online agents. */
        const { thread } = store.createThread("msg-wait-no-online");

        const out = await store.waitForMessages({
            threadId: thread.id,
            afterSeq: 0,
            timeoutMs: 1
        });

        // TS 版本中 payload 直接返回对象，不需要 json.loads
        expect(out).not.toHaveProperty('coordination_prompt');
    });

    it('test_msg_wait_single_online_agent_has_no_dispatch_coordination_prompt', async () => {
        // 对应 Python: L69-92
        /** Coordinator prompts are now produced by the backend coordinator loop, not dispatch.msg_wait. */
        const { thread } = store.createThread("msg-wait-one-online");
        const agent = store.registerAgent({ ide: "VS Code", model: "GPT-5.3-Codex" });

        const out = await store.waitForMessages({
            threadId: thread.id,
            afterSeq: 0,
            timeoutMs: 50,
            agentId: agent.id,
            agentToken: agent.token
        });

        expect(out).not.toHaveProperty('coordination_prompt');
    });

    it('test_msg_wait_and_msg_list_exclude_human_only_system_messages', async () => {
        // 对应 Python: L95-148
        /** human_only system notices should be invisible to agent-facing wait/list flows. */
        const { thread } = store.createThread("msg-wait-human-only");
        const agent = store.registerAgent({ ide: "VS Code", model: "GPT-5.3-Codex" });

        // Simulate creating a system message with human_only visibility
        const systemMsg = store.postSystemMessage(
            thread.id,
            "Auto Administrator Timeout triggered after 100 seconds.",
            JSON.stringify({
                ui_type: "admin_switch_confirmation_required",
                visibility: "human_only",
                private_body: "do not leak this to agents"
            })
        );
        const transcript = store.getHumanTranscript(thread.id, 0, false);

        const out = await store.waitForMessages({
            threadId: thread.id,
            afterSeq: 0,
            timeoutMs: 50,
            agentId: agent.id,
            agentToken: agent.token
        });

        expect(systemMsg).toBeDefined();
        expect(out.messages).toEqual([]);
        expect(transcript).toHaveLength(1);
        expect(transcript[0].entry_kind).toBe("human_only");
        expect(transcript[0].content).toBe("Auto Administrator Timeout triggered after 100 seconds.");

        const listed = store.listMessages({
            threadId: thread.id,
            afterSeq: 0,
            returnFormat: 'json'
        });

        const listedPayload = JSON.parse(listed[0].text);
        expect(listedPayload).toEqual([]);
    });

    it('test_msg_wait_returns_targeted_takeover_instruction_to_agent', async () => {
        // 对应 Python: L151-187
        /** Targeted coordination instructions must stay visible to the intended agent. */
        const { thread } = store.createThread("msg-wait-targeted-takeover");
        const agent = store.registerAgent({ ide: "VS Code", model: "GPT-5.3-Codex" });

        store.postMessage({
            threadId: thread.id,
            author: "system",
            content: "Coordinator decision: please take over now.",
            role: "system",
            metadata: {
                ui_type: "admin_coordination_takeover_instruction",
                handoff_target: agent.id,
                target_admin_id: agent.id
            }
        });

        const out = await store.waitForMessages({
            threadId: thread.id,
            afterSeq: 0,
            timeoutMs: 50,
            agentId: agent.id,
            agentToken: agent.token
        });

        expect(out.messages).toHaveLength(1);
        // Note: Targeted messages should NOT be hidden if the agent is the target.
        // Wait, let's check MemoryStore.projectMessageForAgent logic.
        // It says visibility === "human_only" || audience === "human" -> hide.
        // Targeted takeover usually has handoff_target but NOT human_only visibility.
        expect(out.messages[0].content).toBe("Coordinator decision: please take over now.");
    });

    it('test_msg_wait_for_agent_unmatched_message_timeout_clears_wait_state', async () => {
        // 对应 Python: L190-244
        /** When for_agent does not match and msg_wait times out, the wait state should be cleared. */
        const { thread } = store.createThread("msg-wait-for-agent-unmatched");
        const agent = store.registerAgent({ ide: "VS Code", model: "GPT-5.3-Codex" });

        const sync = store.issueSyncContext(thread.id, agent.id, "test");
        store.postMessage({
            threadId: thread.id,
            author: agent.id,
            content: "message for another agent",
            expectedLastSeq: sync.current_seq,
            replyToken: sync.reply_token,
            role: "assistant",
            metadata: { handoff_target: "someone-else" }
        });

        // First sync call
        await store.waitForMessages({
            threadId: thread.id,
            afterSeq: 0,
            timeoutMs: 1,
            agentId: agent.id,
            agentToken: agent.token
        });

        // Real poll with for_agent
        const out = await store.waitForMessages({
            threadId: thread.id,
            afterSeq: 0,
            timeoutMs: 20,
            agentId: agent.id,
            agentToken: agent.token,
            forAgent: agent.id // Agent is waiting for its own messages
        });

        expect(out.messages).toEqual([]);
        
        // Wait states check
        const waitingAgents = store.getThreadWaitingAgents(thread.id);
        expect(waitingAgents).not.toContain(agent.id);
    });

    it('test_msg_wait_timeout_clears_wait_state', async () => {
        // 对应 Python: L247-273
        const { thread } = store.createThread("msg-wait-timeout-clears-state");
        const agent = store.registerAgent({ ide: "VS Code", model: "GPT-5.3-Codex" });

        const out = await store.waitForMessages({
            threadId: thread.id,
            afterSeq: 0,
            timeoutMs: 20,
            agentId: agent.id,
            agentToken: agent.token
        });

        expect(out.messages).toEqual([]);
        const waitingAgents = store.getThreadWaitingAgents(thread.id);
        expect(waitingAgents).not.toContain(agent.id);
    });
});
