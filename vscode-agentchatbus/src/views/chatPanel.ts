import * as vscode from 'vscode';
import type { AgentChatBusApiClient } from '../api/client';
import type { Thread, Message, SendMessagePayload } from '../api/types';
import {
    buildChatPanelHtml,
    buildRecoveredChatPanelHtml,
    getChatPanelWebviewOptions,
    getRecoveredChatPanelWebviewOptions,
} from './chatPanelHtml';

export class ChatPanel {
    public static readonly VIEW_TYPE = 'agentChatBusChat.v2';
    public static readonly LEGACY_VIEW_TYPE = 'agentChatBusChat';
    public static currentPanel: ChatPanel | undefined;
    private static _extensionPath: string = '';
    private readonly _panel: vscode.WebviewPanel;
    private _thread: Thread;
    private readonly _apiClient: AgentChatBusApiClient;
    private _disposables: vscode.Disposable[] = [];

    // Sync context state
    private _currentSeq: number = 0;
    private _replyToken: string = '';
    private _loadGeneration: number = 0;

    private constructor(panel: vscode.WebviewPanel, thread: Thread, apiClient: AgentChatBusApiClient) {
        this._panel = panel;
        this._thread = thread;
        this._apiClient = apiClient;

        this._update();
        this._loadInitialMessages();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'sendMessage':
                        await this._handleSendMessage(message.payload);
                        return;
                    case 'createThread':
                        await this._handleCreateThread(message.topic);
                        return;
                    case 'uploadImage':
                        await this._handleUploadImage(message.requestId, message.payload);
                        return;
                    case 'loadAgents':
                        await this._handleLoadAgents(message.requestId);
                        return;
                }
            },
            null,
            this._disposables
        );

        // Listen for SSE messages
        const sseDisposable = this._apiClient.onSseEvent.event(async (e) => {
            if (e.type === 'msg.new' && e.payload && e.payload.thread_id === this._thread.id) {
                // Ignore if we already have this seq locally
                if (e.payload.seq <= this._currentSeq) return;
                
                await this._loadNewMessages();
            }
        });
        this._disposables.push(sseDisposable);
    }

    public static setExtensionPath(path: string) {
        ChatPanel._extensionPath = path;
    }

    public static reviveRecoveredPanel(panel: vscode.WebviewPanel) {
        panel.title = 'ACB: Chat (Restore)';
        panel.webview.options = getRecoveredChatPanelWebviewOptions(
            vscode.Uri.file(ChatPanel._extensionPath)
        );
        panel.webview.html = buildRecoveredChatPanelHtml();
    }

    public static createOrShow(thread: Thread, apiClient: AgentChatBusApiClient) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel._panel.reveal(column);
            ChatPanel.currentPanel._switchThread(thread);
            return;
        }

        try {
            console.log('[ACB-ChatPanel] Creating webview panel, extensionPath:', ChatPanel._extensionPath);
            const panel = vscode.window.createWebviewPanel(
                ChatPanel.VIEW_TYPE,
                `ACB: ${thread.topic || thread.id.substring(0, 8)}`,
                column || vscode.ViewColumn.One,
                getChatPanelWebviewOptions(vscode.Uri.file(ChatPanel._extensionPath))
            );
            console.log('[ACB-ChatPanel] Panel created successfully, setting content...');
            ChatPanel.currentPanel = new ChatPanel(panel, thread, apiClient);
            console.log('[ACB-ChatPanel] Panel fully initialized.');
        } catch (err: any) {
            console.error('[ACB-ChatPanel] Failed to create webview panel:', err);
            vscode.window.showErrorMessage(`Failed to open chat panel: ${err?.message || err}`);
        }
    }

    private _switchThread(thread: Thread) {
        if (this._thread.id === thread.id) {
            return;
        }

        this._thread = thread;
        this._currentSeq = 0;
        this._replyToken = '';
        this._panel.title = `ACB: ${thread.topic || thread.id.substring(0, 8)}`;
        this._update();
        void this._loadInitialMessages();
    }

    private async _loadInitialMessages() {
        const threadId = this._thread.id;
        const loadGeneration = ++this._loadGeneration;
        try {
            const wrapper = await this._apiClient.getMessages(threadId);
            const messages = Array.isArray(wrapper) ? wrapper : (wrapper.messages || []);

            if (threadId !== this._thread.id || loadGeneration !== this._loadGeneration) {
                return;
            }
            
            if (messages.length > 0) {
                 this._currentSeq = messages[messages.length - 1].seq;
            }
            if (!Array.isArray(wrapper)) {
                if (wrapper.current_seq) this._currentSeq = wrapper.current_seq;
                if (wrapper.reply_token) this._replyToken = wrapper.reply_token;
            }

            this._panel.webview.postMessage({ command: 'loadMessages', messages });
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to load messages: ${e.message}`);
        }
    }

    private async _loadNewMessages() {
        const threadId = this._thread.id;
        const loadGeneration = this._loadGeneration;
        try {
            const wrapper = await this._apiClient.getMessages(threadId, this._currentSeq);
            const messages = Array.isArray(wrapper) ? wrapper : (wrapper.messages || []);

            if (threadId !== this._thread.id || loadGeneration !== this._loadGeneration) {
                return;
            }

            const newMessages: Message[] = [];
            
            for (const msg of messages) {
                if (msg.seq > this._currentSeq) {
                    newMessages.push(msg);
                    this._currentSeq = msg.seq;
                }
            }
            if (!Array.isArray(wrapper)) {
                if (wrapper.reply_token) this._replyToken = wrapper.reply_token;
            }
            if (newMessages.length > 0) {
                this._panel.webview.postMessage({ command: 'appendMessages', messages: newMessages });
            }
        } catch (e: any) {
            console.error(`Failed to load new messages: ${e.message}`);
        }
    }

    private _pushMessage(message: Message) {
        this._panel.webview.postMessage({ command: 'newMessage', message });
    }

    private async _handleSendMessage(payload: SendMessagePayload | undefined) {
        if (!payload?.content?.trim() && (!payload?.images || payload.images.length === 0)) {
            this._panel.webview.postMessage({
                command: 'sendResult',
                ok: false,
                error: 'Message content is empty.'
            });
            return;
        }

        try {
            const sync = await this._apiClient.getSyncContext(this._thread.id);
            const m = await this._apiClient.sendMessage(this._thread.id, payload, sync);

            if (m && m.seq > this._currentSeq) {
                this._currentSeq = m.seq;
                this._pushMessage(m);
            }

            this._panel.webview.postMessage({ command: 'sendResult', ok: true });
        } catch (e: any) {
            const errorMessage = e?.message || String(e);
            this._panel.webview.postMessage({
                command: 'sendResult',
                ok: false,
                error: errorMessage
            });
        }
    }

    private async _handleUploadImage(requestId: string | undefined, payload: any) {
        if (!requestId) {
            return;
        }

        try {
            const fileName = typeof payload?.name === 'string' ? payload.name : 'image';
            const mimeType = typeof payload?.type === 'string' ? payload.type : 'application/octet-stream';
            const bytes = Array.isArray(payload?.data) ? Uint8Array.from(payload.data) : undefined;

            if (!bytes || bytes.length === 0) {
                throw new Error('Image payload is empty.');
            }

            const image = await this._apiClient.uploadImage(fileName, mimeType, bytes);
            this._panel.webview.postMessage({
                command: 'uploadResult',
                requestId,
                ok: true,
                image,
            });
        } catch (e: any) {
            this._panel.webview.postMessage({
                command: 'uploadResult',
                requestId,
                ok: false,
                error: e?.message || String(e),
            });
        }
    }

    private async _handleLoadAgents(requestId: string | undefined) {
        if (!requestId) {
            return;
        }

        try {
            const agents = await this._apiClient.getThreadAgents(this._thread.id);
            this._panel.webview.postMessage({
                command: 'agentsResult',
                requestId,
                ok: true,
                agents,
            });
        } catch (e: any) {
            this._panel.webview.postMessage({
                command: 'agentsResult',
                requestId,
                ok: false,
                error: e?.message || String(e),
            });
        }
    }

    private async _handleCreateThread(topicRaw: unknown) {
        const topic = String(topicRaw || '').trim() || `New Thread ${new Date().toLocaleString()}`;
        try {
            const thread = await this._apiClient.createThread(topic);
            this._switchThread(thread);
            void vscode.commands.executeCommand('agentchatbus.refreshThreads');
        } catch (e: any) {
            this._panel.webview.postMessage({
                command: 'createThreadResult',
                ok: false,
                error: e?.message || String(e),
            });
        }
    }

    public dispose() {
        if (ChatPanel.currentPanel === this) {
            ChatPanel.currentPanel = undefined;
        }
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) { x.dispose(); }
        }
    }

    private _update() {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview() {
        const webview = this._panel.webview;
        
        // Resource paths
        const extensionUri = vscode.Uri.file(ChatPanel._extensionPath);
        const rendererScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'media', 'messageRenderer.js'));
        const rendererStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'media', 'messageRenderer.css'));
        const panelScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'media', 'chatPanel.js'));
        const panelStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'media', 'chatPanel.css'));
        const config = {
            threadId: this._thread.id,
            threadTopic: this._thread.topic || this._thread.id.substring(0, 8),
            threadStatus: this._thread.status,
            baseUrl: this._apiClient.getBaseUrl(),
            mermaidScriptUrl: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'media', 'mermaid.min.js')).toString(),
            theme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light'
        };
        return buildChatPanelHtml(
            {
                rendererScriptUri: rendererScriptUri.toString(),
                rendererStyleUri: rendererStyleUri.toString(),
                panelScriptUri: panelScriptUri.toString(),
                panelStyleUri: panelStyleUri.toString(),
            },
            config
        );
    }
}
