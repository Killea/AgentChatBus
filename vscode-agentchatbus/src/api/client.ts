import * as vscode from 'vscode';
import type { Thread, ThreadListResponse, Message, Agent, SyncContext, SendMessagePayload, UploadedImage } from './types';
import EventSource from 'eventsource';
import { buildSendMessageRequestBody, shouldRetrySendMessage } from '../logic/apiClient';
import {
    applyServerUrlChange,
    buildEventsUrl,
    parseSseEventData,
    parseUiAgentRegistrationPayload,
} from '../logic/apiClientRuntime';

export class AgentChatBusApiClient {
    private baseUrl: string;
    private eventSource: EventSource | null = null;
    private uiAgentAuth: { agent_id: string; token: string } | null = null;
    public readonly onSseEvent = new vscode.EventEmitter<any>();

    constructor() {
        const config = vscode.workspace.getConfiguration('agentchatbus');
        this.baseUrl = config.get<string>('serverUrl', 'http://127.0.0.1:39765');
        
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('agentchatbus.serverUrl')) {
                const config = vscode.workspace.getConfiguration('agentchatbus');
                const nextState = applyServerUrlChange(
                    this.baseUrl,
                    config.get<string>('serverUrl', 'http://127.0.0.1:39765'),
                    this.uiAgentAuth
                );
                this.baseUrl = nextState.baseUrl;
                this.uiAgentAuth = nextState.uiAgentAuth;
                if (nextState.shouldReconnectSse) {
                    this.reconnectSSE();
                }
            }
        });
    }

    getBaseUrl() {
        return this.baseUrl;
    }

    async getThreads(includeArchived: boolean = false): Promise<Thread[]> {
        const response = await fetch(`${this.baseUrl}/api/threads?include_archived=${includeArchived}`);
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

    async sendMessage(threadId: string, payload: string | SendMessagePayload, syncContext: SyncContext): Promise<Message> {
        let body = buildSendMessageRequestBody(payload, syncContext);

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
                // TS server responds with 409 + action='READ_MESSAGES_THEN_CALL_MSG_WAIT' at root level
                if (shouldRetrySendMessage(response.status, errJson)) {
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

    async getThreadAgents(threadId: string): Promise<Agent[]> {
        const response = await fetch(`${this.baseUrl}/api/threads/${encodeURIComponent(threadId)}/agents`);
        if (!response.ok) throw new Error(`HTTP ${response.status} fetching thread agents`);
        const data = await response.json() as any;
        return data.agents || data;
    }

    async getMetrics(): Promise<any> {
        const response = await fetch(`${this.baseUrl}/api/metrics`);
        if (!response.ok) throw new Error(`HTTP ${response.status} fetching metrics`);
        return await response.json();
    }

    async getHealth(): Promise<any> {
        const response = await fetch(`${this.baseUrl}/health`);
        if (!response.ok) throw new Error(`HTTP ${response.status} fetching health`);
        return await response.json();
    }

    private async ensureUiAgentAuth(): Promise<{ agent_id: string; token: string }> {
        if (this.uiAgentAuth?.agent_id && this.uiAgentAuth?.token) {
            return this.uiAgentAuth;
        }

        const response = await fetch(`${this.baseUrl}/api/agents/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'vscode-ui-human',
                display_name: 'VSCode User',
                ide: 'vscode',
                model: 'human',
            }),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} registering UI agent`);
        }

        const payload = await response.json() as any;
        this.uiAgentAuth = parseUiAgentRegistrationPayload(payload);
        return this.uiAgentAuth;
    }

    async createThread(topic: string): Promise<Thread> {
        const auth = await this.ensureUiAgentAuth();
        const response = await fetch(`${this.baseUrl}/api/threads`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Agent-Token': auth.token,
            },
            body: JSON.stringify({
                topic,
                creator_agent_id: auth.agent_id,
            }),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} creating thread: ${await response.text()}`);
        }
        const payload = await response.json() as any;
        return {
            id: String(payload.id),
            topic: String(payload.topic || topic),
            status: String(payload.status || 'discuss'),
            created_at: String(payload.created_at || new Date().toISOString()),
        };
    }

    async deleteThread(threadId: string): Promise<boolean> {
        const response = await fetch(`${this.baseUrl}/api/threads/${threadId}`, {
            method: 'DELETE'
        });
        return response.ok;
    }

    async archiveThread(threadId: string): Promise<boolean> {
        const response = await fetch(`${this.baseUrl}/api/threads/${threadId}/archive`, {
            method: 'POST'
        });
        return response.ok;
    }

    async unarchiveThread(threadId: string): Promise<boolean> {
        const response = await fetch(`${this.baseUrl}/api/threads/${threadId}/unarchive`, {
            method: 'POST'
        });
        return response.ok;
    }

    async setThreadState(threadId: string, state: string): Promise<boolean> {
        const response = await fetch(`${this.baseUrl}/api/threads/${threadId}/state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state })
        });
        return response.ok;
    }

    async uploadImage(fileName: string, mimeType: string, data: Uint8Array): Promise<UploadedImage> {
        const normalized = new Uint8Array(data.byteLength);
        normalized.set(data);
        const blob = new Blob([normalized.buffer], { type: mimeType || 'application/octet-stream' });
        const formData = new FormData();
        formData.append('file', blob, fileName || 'image');

        const response = await fetch(`${this.baseUrl}/api/upload/image`, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} uploading image: ${await response.text()}`);
        }

        return await response.json() as UploadedImage;
    }

    connectSSE(): void {
        this.disconnectSSE();
        const url = buildEventsUrl(this.baseUrl);
        console.log(`[AgentChatBus] Connecting SSE to ${url}...`);
        this.eventSource = new EventSource(url);
        
        this.eventSource.onmessage = (e) => {
            const parsed = parseSseEventData(e.data);
            if (parsed.ok) {
                this.onSseEvent.fire(parsed.data);
            } else {
                console.error("Failed to parse SSE event", parsed.error);
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
