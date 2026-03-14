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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatPanel = void 0;
const vscode = __importStar(require("vscode"));
class ChatPanel {
    static currentPanels = new Map();
    static _extensionPath = '';
    _panel;
    _thread;
    _apiClient;
    _disposables = [];
    // Sync context state
    _currentSeq = 0;
    _replyToken = '';
    constructor(panel, thread, apiClient) {
        this._panel = panel;
        this._thread = thread;
        this._apiClient = apiClient;
        this._update();
        this._loadInitialMessages();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'sendMessage':
                    await this._handleSendMessage(message.payload);
                    return;
            }
        }, null, this._disposables);
        // Listen for SSE messages
        const sseDisposable = this._apiClient.onSseEvent.event(async (e) => {
            if (e.type === 'msg.new' && e.payload && e.payload.thread_id === this._thread.id) {
                // Ignore if we already have this seq locally
                if (e.payload.seq <= this._currentSeq)
                    return;
                await this._loadNewMessages();
            }
        });
        this._disposables.push(sseDisposable);
    }
    static setExtensionPath(path) {
        ChatPanel._extensionPath = path;
    }
    static createOrShow(thread, apiClient) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
        if (ChatPanel.currentPanels.has(thread.id)) {
            ChatPanel.currentPanels.get(thread.id)._panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel('agentChatBusChat', `ACB: ${thread.topic || thread.id.substring(0, 8)}`, column || vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(ChatPanel._extensionPath)
            ]
        });
        ChatPanel.currentPanels.set(thread.id, new ChatPanel(panel, thread, apiClient));
    }
    async _loadInitialMessages() {
        try {
            const wrapper = await this._apiClient.getMessages(this._thread.id);
            const messages = Array.isArray(wrapper) ? wrapper : (wrapper.messages || []);
            if (messages.length > 0) {
                this._currentSeq = messages[messages.length - 1].seq;
            }
            if (!Array.isArray(wrapper)) {
                if (wrapper.current_seq)
                    this._currentSeq = wrapper.current_seq;
                if (wrapper.reply_token)
                    this._replyToken = wrapper.reply_token;
            }
            this._panel.webview.postMessage({ command: 'loadMessages', messages });
        }
        catch (e) {
            vscode.window.showErrorMessage(`Failed to load messages: ${e.message}`);
        }
    }
    async _loadNewMessages() {
        try {
            const wrapper = await this._apiClient.getMessages(this._thread.id, this._currentSeq);
            const messages = Array.isArray(wrapper) ? wrapper : (wrapper.messages || []);
            const newMessages = [];
            for (const msg of messages) {
                if (msg.seq > this._currentSeq) {
                    newMessages.push(msg);
                    this._currentSeq = msg.seq;
                }
            }
            if (!Array.isArray(wrapper)) {
                if (wrapper.reply_token)
                    this._replyToken = wrapper.reply_token;
            }
            if (newMessages.length > 0) {
                this._panel.webview.postMessage({ command: 'appendMessages', messages: newMessages });
            }
        }
        catch (e) {
            console.error(`Failed to load new messages: ${e.message}`);
        }
    }
    _pushMessage(message) {
        this._panel.webview.postMessage({ command: 'newMessage', message });
    }
    async _handleSendMessage(payload) {
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
        }
        catch (e) {
            const errorMessage = e?.message || String(e);
            this._panel.webview.postMessage({
                command: 'sendResult',
                ok: false,
                error: errorMessage
            });
        }
    }
    dispose() {
        ChatPanel.currentPanels.delete(this._thread.id);
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
    _update() {
        this._panel.webview.html = this._getHtmlForWebview();
    }
    _getHtmlForWebview() {
        const webview = this._panel.webview;
        // Resource paths
        const rendererScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(vscode.Uri.file(ChatPanel._extensionPath), 'resources', 'media', 'messageRenderer.js'));
        const rendererStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(vscode.Uri.file(ChatPanel._extensionPath), 'resources', 'media', 'messageRenderer.css'));
        const panelScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(vscode.Uri.file(ChatPanel._extensionPath), 'resources', 'media', 'chatPanel.js'));
        const panelStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(vscode.Uri.file(ChatPanel._extensionPath), 'resources', 'media', 'chatPanel.css'));
        const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(vscode.Uri.file(ChatPanel._extensionPath), 'resources', 'media', 'mermaid.min.js'));
        const config = {
            threadId: this._thread.id,
            threadTopic: this._thread.topic || this._thread.id.substring(0, 8),
            threadStatus: this._thread.status,
            baseUrl: this._apiClient.getBaseUrl(),
            theme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light'
        };
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Chat</title>
            <link rel="stylesheet" href="${rendererStyleUri}">
            <link rel="stylesheet" href="${panelStyleUri}">
        </head>
        <body data-theme="${config.theme}">
            <div id="chat-shell">
                <header id="chat-header">
                    <div class="chat-thread-meta">
                        <div class="chat-thread-title">${config.threadTopic.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                        <div class="chat-thread-subtitle">${config.threadStatus.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                    </div>
                    <div class="chat-header-actions">
                        <button id="search-prev" class="icon-btn" title="Previous match">Up</button>
                        <button id="search-next" class="icon-btn" title="Next match">Down</button>
                    </div>
                </header>

                <section id="search-bar">
                    <input id="search-input" type="search" placeholder="Search this thread" spellcheck="false" />
                    <div id="search-counter">0 / 0</div>
                </section>

                <section id="chat-body">
                    <div id="messages-scroll">
                        <div id="message-container"></div>
                    </div>
                    <nav id="nav-sidebar" aria-label="Message navigation"></nav>
                </section>

                <section id="composer-shell">
                    <div id="reply-preview" class="hidden"></div>
                    <div id="image-preview" class="hidden"></div>
                    <div id="composer-toolbar">
                        <div id="author-wrap">
                            <label for="author-input">Name</label>
                            <input id="author-input" type="text" maxlength="60" />
                        </div>
                        <div class="toolbar-actions">
                            <button id="mention-button" class="icon-btn" title="Mention an agent">@</button>
                            <button id="upload-button" class="icon-btn" title="Upload image">Image</button>
                        </div>
                    </div>
                    <div id="composer-box">
                        <div id="compose-input" contenteditable="true" data-placeholder="Send a message. Type @ to mention an agent."></div>
                        <button id="send-button">Send</button>
                    </div>
                    <input id="image-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden />
                    <div id="mention-menu" class="floating-menu hidden"></div>
                    <div id="reaction-menu" class="floating-menu hidden">
                        <button data-reaction="👍">👍</button>
                        <button data-reaction="❤️">❤️</button>
                        <button data-reaction="🎯">🎯</button>
                        <button data-reaction="🔥">🔥</button>
                        <button data-reaction="👀">👀</button>
                        <button data-reaction="✅">✅</button>
                    </div>
                </section>
            </div>

            <div id="modal-backdrop" class="hidden">
                <div id="modal-card">
                    <div id="modal-header">
                        <div id="modal-title">Details</div>
                        <button id="modal-close" class="icon-btn">Close</button>
                    </div>
                    <div id="modal-content"></div>
                </div>
            </div>

            <div id="toast" class="hidden"></div>

            <script src="${mermaidUri}"></script>
            <script>
                window.ACB_CHAT_PANEL_CONFIG = ${JSON.stringify(config)};
            </script>
            <script src="${rendererScriptUri}"></script>
            <script src="${panelScriptUri}"></script>
            <script>
                window.addEventListener('load', () => {
                    if (window.AcbChatPanel && typeof window.AcbChatPanel.init === 'function') {
                        window.AcbChatPanel.init();
                    }
                });
            </script>
        </body>
        </html>`;
    }
}
exports.ChatPanel = ChatPanel;
//# sourceMappingURL=chatPanel.js.map