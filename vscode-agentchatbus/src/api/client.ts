import * as vscode from 'vscode';
import type { Thread, ThreadListResponse, Message, Agent, SyncContext } from './types';
import EventSource from 'eventsource';

export class AgentChatBusApiClient {
    private baseUrl: string;
    private eventSource: EventSource | null = null;
    public readonly onSseEvent = new vscode.EventEmitter<any>();

    constructor() {
        const config = vscode.workspace.getConfiguration('agentchatbus');
        this.baseUrl = config.get<string>('serverUrl', 'http://127.0.0.1:39765');
        
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('agentchatbus.serverUrl')) {
                const config = vscode.workspace.getConfiguration('agentchatbus');
                this.baseUrl = config.get<string>('serverUrl', 'http://127.0.0.1:39765');
                this.reconnectSSE();
            }
        });
    }

    getBaseUrl() {
        return this.baseUrl;
    }

    async getThreads(): Promise<Thread[]> {
        const response = await fetch(`${this.baseUrl}/api/threads`);
        if (!response.ok) throw new Error(`HTTP ${response.status} fetching threads`);
        const data = await response.json() as ThreadListResponse;
        return data.threads;
    }

    async getMessages(threadId: string, afterSeq?: number): Promise<any> {
        const url = `${this.baseUrl}/api/threads/${threadId}/messages` + (afterSeq !== undefined ? `?after_seq=${afterSeq}` : '');
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status} fetching messages`);
        return await response.json();
    }

    async getSyncContext(threadId: string): Promise<SyncContext> {
        const response = await fetch(`${this.baseUrl}/api/threads/${threadId}/sync-context`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} fetching sync-context`);
        return await response.json() as SyncContext;
    }

    async sendMessage(threadId: string, content: string, syncContext: SyncContext): Promise<Message> {
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
            } catch (e: any) {
                // Ignore parsing errors and fallback to original fail
                console.error("[AgentChatBus] Retry logic failed:", e.message);
            }
        }
        
        if (!response.ok) {
            throw new Error(`Failed to send message: HTTP ${response.status} ${errDetails}`);
        }
        return await response.json() as Message;
    }

    async getAgents(): Promise<Agent[]> {
        const response = await fetch(`${this.baseUrl}/api/agents`);
        if (!response.ok) throw new Error(`HTTP ${response.status} fetching agents`);
        const data = await response.json() as any;
        return data.agents || data; // handle depending on array vs object wrap
    }

    connectSSE(): void {
        this.disconnectSSE();
        const url = `${this.baseUrl}/events`;
        console.log(`[AgentChatBus] Connecting SSE to ${url}...`);
        this.eventSource = new EventSource(url);
        
        this.eventSource.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                this.onSseEvent.fire(data);
            } catch (err) {
                console.error("Failed to parse SSE event", err);
            }
        };

        this.eventSource.onerror = (e) => {
             console.log("[AgentChatBus] SSE error or disconnected. EventSource will typically auto-reconnect.");
        };
    }

    disconnectSSE(): void {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }

    reconnectSSE(): void {
        this.disconnectSSE();
        this.connectSSE();
    }
}
