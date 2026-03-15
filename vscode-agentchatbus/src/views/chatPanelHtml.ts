import type { WebviewOptions, WebviewPanelOptions } from 'vscode';

export interface ChatPanelResources {
    rendererScriptUri: string;
    rendererStyleUri: string;
    panelScriptUri: string;
    panelStyleUri: string;
}

export interface ChatPanelConfig {
    threadId: string;
    threadTopic: string;
    threadStatus: string;
    baseUrl: string;
    mermaidScriptUrl: string;
    theme: string;
}

function escapeHtml(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeText(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function getChatPanelWebviewOptions(
    localResourceRoot: unknown
): WebviewOptions & WebviewPanelOptions {
    return {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [localResourceRoot as never],
    };
}

export function getRecoveredChatPanelWebviewOptions(
    localResourceRoot: unknown
): WebviewOptions & WebviewPanelOptions {
    return {
        enableScripts: false,
        localResourceRoots: [localResourceRoot as never],
    };
}

export function buildRecoveredChatPanelHtml(): string {
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 20px; }
                .card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 14px; max-width: 560px; }
                .hint { opacity: 0.8; margin-top: 8px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h3>Chat session needs reload</h3>
                <p>This chat webview was restored from a previous session and was reset for stability.</p>
                <p class="hint">Please open the thread again from the Threads panel.</p>
            </div>
        </body>
        </html>`;
}

export function buildChatPanelHtml(
    resources: ChatPanelResources,
    config: ChatPanelConfig
): string {
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Chat</title>
            <link rel="stylesheet" href="${resources.rendererStyleUri}">
            <link rel="stylesheet" href="${resources.panelStyleUri}">
        </head>
        <body
            data-theme="${escapeHtml(config.theme)}"
            data-thread-id="${escapeHtml(config.threadId)}"
            data-thread-topic="${escapeHtml(config.threadTopic)}"
            data-thread-status="${escapeHtml(config.threadStatus)}"
            data-base-url="${escapeHtml(config.baseUrl)}"
            data-mermaid-script-url="${escapeHtml(config.mermaidScriptUrl)}"
        >
            <div id="chat-shell">
                <header id="chat-header">
                    <div id="search-bar">
                        <input id="search-input" type="search" placeholder="Search this thread" spellcheck="false" />
                        <div id="search-counter">0 / 0</div>
                        <div class="chat-header-actions">
                            <button id="search-prev" class="icon-btn icon-only-btn" title="Previous match" aria-label="Previous match">⬆️</button>
                            <button id="search-next" class="icon-btn icon-only-btn" title="Next match" aria-label="Next match">⬇️</button>
                        </div>
                    </div>
                </header>

                <section id="chat-body">
                    <div id="messages-scroll">
                        <div id="loading-indicator">
                            <div class="loading-spinner"></div>
                            <div class="loading-label">Loading thread...</div>
                        </div>
                        <div id="message-container"></div>
                    </div>
                    <nav id="nav-sidebar" aria-label="Message navigation"></nav>
                </section>

                <section id="composer-shell">
                    <div id="reply-preview" class="hidden"></div>
                    <div id="image-preview" class="hidden"></div>
                    <div id="composer-layout">
                        <div id="composer-side-panel">
                            <div id="author-wrap" class="tooltip-anchor" data-tooltip="Edit the human display name used for new messages">
                                <input id="author-input" type="text" maxlength="60" aria-label="Human display name" />
                            </div>
                            <div class="toolbar-actions composer-side-actions">
                                <button id="mention-button" class="icon-btn tooltip-anchor" data-tooltip="Mention an agent in this thread" aria-label="Mention an agent in this thread">@</button>
                                <button id="upload-button" class="icon-btn tooltip-anchor" data-tooltip="Upload an image from file" aria-label="Upload an image from file">Image</button>
                            </div>
                        </div>
                        <div id="composer-main-panel">
                            <div id="composer-box">
                                <div id="compose-input" contenteditable="true" data-placeholder="Send a message. Type @ to mention an agent."></div>
                                <button id="send-button">Send</button>
                            </div>
                        </div>
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
                    <div id="ui-tooltip" class="ui-tooltip hidden" role="tooltip"></div>
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

            <script src="${resources.rendererScriptUri}"></script>
            <script src="${resources.panelScriptUri}"></script>
        </body>
        </html>`;
}