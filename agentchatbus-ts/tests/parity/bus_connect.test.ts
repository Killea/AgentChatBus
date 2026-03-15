import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec, ChildProcess } from 'child_process';

const PORT = 39766; // different port for tests
const BASE_URL = `http://127.0.0.1:${PORT}`;
let DB_PATH = path.join(__dirname, 'bus_connect.test.db');

describe('Bus Connect Parity Tests', () => {
    let serverProcess: ChildProcess;

    beforeEach(async () => {
        // Use a per-test temp DB file to avoid Windows file-lock/unlink races
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentchatbus-"));
        DB_PATH = path.join(tmpDir, `bus_connect-${randomUUID().slice(0,8)}.db`);

        // Start server in a separate process
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

    afterEach(() => {
        if (serverProcess) serverProcess.kill();
        try {
            if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
            const parent = path.dirname(DB_PATH);
            if (fs.existsSync(parent)) fs.rmdirSync(parent);
        } catch (e) {
            // ignore cleanup errors
        }
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
        expect(payload2.current_seq).toBe(1);
        expect(payload2.messages.length).toBeGreaterThanOrEqual(2); // System + First message
    });
});
