import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { exec, ChildProcess } from 'child_process';

const PORT = 39766; // different port for tests
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Helper function to call MCP tools
async function callMcpTool(toolName: string, params: Record<string, any>) {
    const res = await fetch(`${BASE_URL}/api/mcp/tool/${toolName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
    });
    const data = await res.json();
    return JSON.parse(data[0].text);
}

describe('Bus Connect Parity Tests', () => {
    let serverProcess: ChildProcess;

    beforeEach(async () => {
        // Use in-memory database like Python tests (:memory:)
        // This ensures complete isolation - each test starts fresh with seq=0
        const DB_PATH = ':memory:';

        // Start server in a separate process with fresh in-memory DB
        serverProcess = exec(`npx tsx src/cli/index.ts serve`, {
            env: {
                ...process.env,
                AGENTCHATBUS_PORT: PORT.toString(),
                AGENTCHATBUS_DB: DB_PATH
            }
        });

        // Wait for server to be ready
        let ready = false;
        for (let i = 0; i < 30; i++) {
            try {
                const res = await fetch(`${BASE_URL}/api/metrics`);
                if (res.ok) {
                    ready = true;
                    break;
                }
            } catch (e) {}
            await new Promise(r => setTimeout(r, 200));
        }
        if (!ready) throw new Error("Server failed to start");
    }, 10000);

    afterEach(async () => {
        // Kill server process - this clears the in-memory singleton state
        if (serverProcess) {
            // On Windows, use taskkill for more reliable process termination
            const { execSync } = await import('child_process');
            try {
                if (serverProcess.pid) {
                    if (process.platform === 'win32') {
                        execSync(`taskkill /pid ${serverProcess.pid} /T /F`, { stdio: 'ignore' });
                    } else {
                        serverProcess.kill('SIGKILL');
                    }
                }
            } catch (e) {
                // Ignore if process already exited
            }
            // Wait to ensure clean shutdown
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        // No need to clean up DB files - :memory: is automatically cleaned
    });

    it('manages bus_connect flow: register -> join -> post (UP-PARITY)', async () => {
        const threadName = "BusConnect-Topic-" + randomUUID().slice(0, 8);
        
        // 1. Initial bus_connect (new agent, new thread)
        const connectRes = await fetch(`${BASE_URL}/api/mcp/tool/bus_connect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                thread_name: threadName,
                ide: "Vitest",
                model: "ParityBot",
                capabilities: ["testing"],
                skills: [{ id: "sync-check", name: "Sync Checker" }]
            })
        });

        expect(connectRes.status).toBe(200);
        const connectData = await connectRes.json();
        const payload = JSON.parse(connectData[0].text);

        expect(payload.agent.registered).toBe(true);
        expect(payload.thread.topic).toBe(threadName);
        expect(payload.thread.created).toBe(true);
        expect(payload.current_seq).toBe(0);
        expect(payload.reply_token).toBeDefined();

        const agentId = payload.agent.agent_id;
        const agentToken = payload.agent.token;
        const threadId = payload.thread.thread_id;

        // 2. Post first message using provided sync context
        const postRes = await fetch(`${BASE_URL}/api/mcp/tool/msg_post`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                thread_id: threadId,
                author: agentId,
                content: "First message from parity bot",
                expected_last_seq: payload.current_seq,
                reply_token: payload.reply_token,
                role: "assistant"
            })
        });

        expect(postRes.status).toBe(200);
        const postData = await postRes.json();
        const postPayload = JSON.parse(postData[0].text);
        expect(postPayload.seq).toBe(1);

        // 3. msg_wait for next turn
        const waitRes = await fetch(`${BASE_URL}/api/mcp/tool/msg_wait`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                thread_id: threadId,
                after_seq: 1,
                timeout_ms: 100,
                agent_id: agentId,
                token: agentToken
            })
        });

        expect(waitRes.status).toBe(200);
        const waitData = await waitRes.json();
        const waitPayload = JSON.parse(waitData[0].text);
        expect(waitPayload.current_seq).toBe(1);
        expect(waitPayload.messages).toHaveLength(0);
        expect(waitPayload.reply_token).toBeDefined();

        // 4. Second connect (reuse agent, existing thread)
        const connectRes2 = await fetch(`${BASE_URL}/api/mcp/tool/bus_connect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                thread_name: threadName,
                agent_id: agentId,
                token: agentToken
            })
        });
        expect(connectRes2.status).toBe(200);
        const connectData2 = await connectRes2.json();
        const payload2 = JSON.parse(connectData2[0].text);
        
        expect(payload2.agent.registered).toBe(false); // Already existed
        expect(payload2.thread.created).toBe(false);
        expect(payload2.current_seq).toBe(1); // Exactly 1 (the message we posted)
        expect(payload2.messages.length).toBeGreaterThanOrEqual(1); // At least the first message
    });

    it('bus_connect new agent new thread', async () => {
        // 对应 Python: L21-55
        const args = {
            thread_name: "Test-Auto-Create-" + randomUUID().slice(0, 8),
            ide: "TestIDE",
            model: "TestModel"
        };

        const payload = await callMcpTool('bus_connect', args);
        
        // Check agent
        expect(payload.agent.registered).toBe(true);
        expect(payload.agent.agent_id).toBeDefined();
        expect(payload.agent.token).toBeDefined();

        // Check thread
        expect(payload.thread.topic).toBe(args.thread_name);
        expect(payload.thread.created).toBe(true);

        // Check sync context
        expect(payload.current_seq).toBe(0);
        expect(payload.reply_token).toBeDefined();
    });

    it('bus_connect new agent existing thread', async () => {
        // 对应 Python: L57-92
        const threadName = "Existing-Topic-" + randomUUID().slice(0, 8);
        
        // First connect creates thread and posts message
        const payload1 = await callMcpTool('bus_connect', {
            thread_name: threadName,
            ide: "TestIDE",
            model: "TestModel"
        });
        
        // Post a message
        await callMcpTool('msg_post', {
            thread_id: payload1.thread.thread_id,
            author: payload1.agent.agent_id,
            content: "First message",
            expected_last_seq: payload1.current_seq,
            reply_token: payload1.reply_token,
            role: "assistant"
        });

        // Second connect should find existing thread with message
        const payload2 = await callMcpTool('bus_connect', {
            thread_name: threadName,
            ide: "TestIDE2",
            model: "TestModel2"
        });
        
        expect(payload2.agent.registered).toBe(true);
        expect(payload2.thread.created).toBe(false);
        expect(payload2.thread.topic).toBe(threadName);
        expect(payload2.messages.length).toBeGreaterThanOrEqual(1);
        expect(payload2.current_seq).toBeGreaterThanOrEqual(1);
        expect(payload2.reply_token).toBeDefined();
    });

    it('bus_connect no reuse agent', async () => {
        // 对应 Python: L125-150
        const threadName = "No-Reuse-" + randomUUID().slice(0, 8);
        
        // First connect
        const payload1 = await callMcpTool('bus_connect', {
            thread_name: threadName,
            ide: "TestIDE",
            model: "TestModel"
        });
        
        const agentId = payload1.agent.agent_id;
        
        // Try to connect with wrong credentials - should create new agent
        const payload2 = await callMcpTool('bus_connect', {
            thread_name: threadName + "-2",
            ide: "TestIDE",
            model: "TestModel"
        });
        
        // Should successfully create new agent
        expect(payload2.agent.registered).toBe(true);
        expect(payload2.agent.agent_id).not.toBe(agentId);
    });

    it('bus_connect projects human-only message for agent view', async () => {
        // 对应 Python: L96-123
        const threadName = "Hidden-Topic-" + randomUUID().slice(0, 8);
        
        // Setup: create thread and a hidden message
        const payload1 = await callMcpTool('bus_connect', {
            thread_name: threadName,
            ide: "Human",
            model: "Admin"
        });
        
        await callMcpTool('msg_post', {
            thread_id: payload1.thread.thread_id,
            author: "system",
            content: "Only humans should read this.",
            expected_last_seq: payload1.current_seq,
            reply_token: payload1.reply_token,
            role: "system",
            metadata: { visibility: "human_only", ui_type: "admin_switch_confirmation_required" }
        });

        // Now connect as an agent
        const payload2 = await callMcpTool('bus_connect', {
            thread_name: threadName,
            ide: "TestIDE",
            model: "TestModel"
        });
        
        expect(payload2.messages.length).toBeGreaterThanOrEqual(2); // System prompt + Hidden msg
        // Find the hidden message in the list
        const hiddenMsg = payload2.messages.find((m: any) => m.metadata?.visibility === "human_only");
        expect(hiddenMsg).toBeDefined();
        expect(hiddenMsg.content).toBe("[human-only content hidden]");
    });

    it('msg_post seq mismatch returns first read messages', async () => {
        // 对应 Python: L335-431
        const threadName = "SeqMismatch-" + randomUUID().slice(0, 8);
        
        const payload1 = await callMcpTool('bus_connect', {
            thread_name: threadName,
            ide: "VS Code",
            model: "GPT-5"
        });
        
        // Post something to move seq to 1
        await callMcpTool('msg_post', {
            thread_id: payload1.thread.thread_id,
            author: payload1.agent.agent_id,
            content: "seed",
            expected_last_seq: payload1.current_seq,
            reply_token: payload1.reply_token,
            role: "assistant"
        });

        // Get fresh token for seq 1
        const waitPayload = await callMcpTool('msg_wait', {
            thread_id: payload1.thread.thread_id,
            after_seq: 1,
            timeout_ms: 1,
            agent_id: payload1.agent.agent_id,
            token: payload1.agent.token
        });

        // Now move seq ahead manually via another connection to trigger mismatch
        const payload2 = await callMcpTool('bus_connect', {
            thread_name: threadName,
            ide: "Admin",
            model: "Manual"
        });
        
        // Post 6 messages to exceed tolerance (5)
        for (let i = 0; i < 6; i++) {
            const sync = await callMcpTool('msg_wait', {
                thread_id: payload2.thread.thread_id,
                after_seq: i + 1,
                timeout_ms: 1,
                agent_id: payload2.agent.agent_id,
                token: payload2.agent.token
            });
            await callMcpTool('msg_post', {
                thread_id: payload2.thread.thread_id,
                author: payload2.agent.agent_id,
                content: `Update ${i}`,
                expected_last_seq: sync.current_seq,
                reply_token: sync.reply_token,
                role: "assistant"
            });
        }

        // Now try to post with the stale token from agent 1
        const errPayload = await callMcpTool('msg_post', {
            thread_id: payload1.thread.thread_id,
            author: payload1.agent.agent_id,
            content: "stale post",
            expected_last_seq: waitPayload.current_seq, // Still 1
            reply_token: waitPayload.reply_token,
            role: "assistant"
        });

        expect(errPayload.error).toBe("SeqMismatchError");
        expect(errPayload.action).toBe("READ_MESSAGES_THEN_CALL_MSG_WAIT");
        expect(errPayload.new_messages_1st_read).toBeDefined();
        expect(errPayload.new_messages_1st_read.length).toBeGreaterThanOrEqual(6);
    });
});
