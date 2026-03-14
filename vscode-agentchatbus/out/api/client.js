"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentChatBusApiClient = void 0;
const vscode = __importStar(require("vscode"));
const eventsource_1 = __importDefault(require("eventsource"));
class AgentChatBusApiClient {
    baseUrl;
    eventSource = null;
    onSseEvent = new vscode.EventEmitter();
    constructor() {
        const config = vscode.workspace.getConfiguration('agentchatbus');
        this.baseUrl = config.get('serverUrl', 'http://127.0.0.1:39765');
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('agentchatbus.serverUrl')) {
                const config = vscode.workspace.getConfiguration('agentchatbus');
                this.baseUrl = config.get('serverUrl', 'http://127.0.0.1:39765');
                this.reconnectSSE();
            }
        });
    }
    getBaseUrl() {
        return this.baseUrl;
    }
    async getThreads(includeArchived = false) {
        const response = await fetch(`${this.baseUrl}/api/threads?include_archived=${includeArchived}`);
        if (!response.ok)
            throw new Error(`HTTP ${response.status} fetching threads`);
        const data = await response.json();
        return data.threads;
    }
    async getMessages(threadId, afterSeq) {
        const url = `${this.baseUrl}/api/threads/${threadId}/messages` + (afterSeq !== undefined ? `?after_seq=${afterSeq}` : '');
        const response = await fetch(url);
        if (!response.ok)
            throw new Error(`HTTP ${response.status} fetching messages`);
        return await response.json();
    }
    async getSyncContext(threadId) {
        const response = await fetch(`${this.baseUrl}/api/threads/${threadId}/sync-context`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        if (!response.ok)
            throw new Error(`HTTP ${response.status} fetching sync-context`);
        return await response.json();
    }
    async sendMessage(threadId, content, syncContext) {
        let body = {
            author: 'System (Human)', // Identifies local human
            content,
            expected_last_seq: syncContext.current_seq,
            reply_token: syncContext.reply_token
        };
        // If client knows it lacks a valid token, eagerly fetch one
        if (!body.reply_token || typeof body.expected_last_seq !== 'number') {
            const sync = await this.getSyncContext(threadId);
            body.reply_token = sync.reply_token;
            body.expected_last_seq = sync.current_seq;
        }
        let response = await fetch(`${this.baseUrl}/api/threads/${threadId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        let errDetails = '';
        if (!response.ok) {
            errDetails = await response.text();
            try {
                const errJson = JSON.parse(errDetails);
                // AgentChatBus specific fast-retry logic for SeqMismatch/TokenInvalid
                if (response.status === 400 && errJson?.detail?.action === 'CALL_SYNC_CONTEXT_THEN_RETRY') {
                    console.log("[AgentChatBus] Recovering from sync mismatch. Fetching new context...");
                    const sync = await this.getSyncContext(threadId);
                    body.reply_token = sync.reply_token;
                    body.expected_last_seq = sync.current_seq;
                    response = await fetch(`${this.baseUrl}/api/threads/${threadId}/messages`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    if (!response.ok) {
                        errDetails = await response.text();
                    }
                }
            }
            catch (e) {
                // Ignore parsing errors and fallback to original fail
                console.error("[AgentChatBus] Retry logic failed:", e.message);
            }
        }
        if (!response.ok) {
            throw new Error(`Failed to send message: HTTP ${response.status} ${errDetails}`);
        }
        return await response.json();
    }
    async getAgents() {
        const response = await fetch(`${this.baseUrl}/api/agents`);
        if (!response.ok)
            throw new Error(`HTTP ${response.status} fetching agents`);
        const data = await response.json();
        return data.agents || data; // handle depending on array vs object wrap
    }
    connectSSE() {
        this.disconnectSSE();
        const url = `${this.baseUrl}/events`;
        console.log(`[AgentChatBus] Connecting SSE to ${url}...`);
        this.eventSource = new eventsource_1.default(url);
        this.eventSource.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                this.onSseEvent.fire(data);
            }
            catch (err) {
                console.error("Failed to parse SSE event", err);
            }
        };
        this.eventSource.onerror = (e) => {
            console.log("[AgentChatBus] SSE error or disconnected. EventSource will typically auto-reconnect.");
        };
    }
    disconnectSSE() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }
    reconnectSSE() {
        this.disconnectSSE();
        this.connectSSE();
    }
}
exports.AgentChatBusApiClient = AgentChatBusApiClient;
//# sourceMappingURL=client.js.map