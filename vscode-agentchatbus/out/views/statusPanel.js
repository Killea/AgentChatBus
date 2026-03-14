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
exports.StatusPanel = void 0;
const vscode = __importStar(require("vscode"));
class StatusPanel {
    metadata;
    static currentPanel;
    _panel;
    _disposables = [];
    constructor(panel, metadata) {
        this.metadata = metadata;
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getHtmlForWebview();
    }
    static createOrShow(metadata) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
        if (StatusPanel.currentPanel) {
            StatusPanel.currentPanel.metadata = metadata;
            StatusPanel.currentPanel._panel.webview.html = StatusPanel.currentPanel._getHtmlForWebview();
            StatusPanel.currentPanel._panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel('acbStatus', 'AgentChatBus: Server Status', column || vscode.ViewColumn.One, { enableScripts: true });
        StatusPanel.currentPanel = new StatusPanel(panel, metadata);
    }
    dispose() {
        StatusPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
    _getHtmlForWebview() {
        const m = this.metadata;
        const mcp = m.mcp || {};
        const uptime = m.startTime ? this._getUptime(new Date(m.startTime)) : 'N/A';
        const serverStatus = m.pid ? 'RUNNING' : 'STOPPED';
        const mcpApiStatus = mcp.apiAvailable ? 'AVAILABLE' : 'UNAVAILABLE';
        const mcpProviderStatus = mcp.providerRegistered ? 'REGISTERED' : 'PENDING';
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Server Status</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 20px;
            line-height: 1.6;
        }
        h1 { color: var(--vscode-button-background); border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 10px; font-weight: 300; }
        h2 { font-size: 1.1em; margin-top: 30px; color: var(--vscode-symbolIcon-propertyForeground); text-transform: uppercase; letter-spacing: 1px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border); padding: 15px; border-radius: 4px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .label { font-weight: bold; color: var(--vscode-descriptionForeground); font-size: 0.9em; min-width: 120px; display: inline-block; }
        .value { font-family: 'Courier New', Courier, monospace; color: var(--vscode-textPreformat-foreground); word-break: break-all; }
        .status-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.8em; font-weight: bold; background: #28a745; color: white; }
        .env-list { margin: 0; padding: 0; list-style: none; font-size: 0.9em; }
        .env-item { border-bottom: 1px solid var(--vscode-widget-border); padding: 4px 0; display: flex; justify-content: space-between; }
        .env-key { color: var(--vscode-symbolIcon-variableForeground); }
        .env-val { color: var(--vscode-textLink-foreground); text-align: right; overflow: hidden; text-overflow: ellipsis; }
    </style>
</head>
<body>
    <h1>📟 AgentChatBus System Diagnostics</h1>
    
    <div class="grid">
        <div class="card">
            <h2>🌍 Server Instance</h2>
            <div><span class="label">Status:</span> <span class="status-badge">${serverStatus}</span></div>
            <div><span class="label">PID:</span> <span class="value">${m.pid || 'N/A'}</span></div>
            <div><span class="label">Uptime:</span> <span class="value">${uptime}</span></div>
            <div><span class="label">Started At:</span> <span class="value">${m.startTime || 'N/A'}</span></div>
        </div>

        <div class="card">
            <h2>⚙️ Startup Configuration</h2>
            <div><span class="label">Executable:</span> <span class="value">${m.command || 'N/A'}</span></div>
            <div><span class="label">Arguments:</span> <span class="value">${m.args ? m.args.join(' ') : 'N/A'}</span></div>
            <div><span class="label">WorkDir:</span> <span class="value">${m.cwd || 'N/A'}</span></div>
        </div>

        <div class="card">
            <h2>💻 Runtime Environment</h2>
            <div><span class="label">Platform:</span> <span class="value">${m.platform} (${m.arch})</span></div>
            <div><span class="label">Node.js:</span> <span class="value">${m.nodeVersion}</span></div>
            <div><span class="label">VS Code:</span> <span class="value">${m.vscodeVersion}</span></div>
        </div>

        <div class="card">
            <h2>🔌 MCP Integration</h2>
            <div><span class="label">API:</span> <span class="status-badge">${mcpApiStatus}</span></div>
            <div><span class="label">Provider:</span> <span class="status-badge">${mcpProviderStatus}</span></div>
            <div><span class="label">Provider ID:</span> <span class="value">${mcp.providerId || 'N/A'}</span></div>
            <div><span class="label">Label:</span> <span class="value">${mcp.providerLabel || 'N/A'}</span></div>
            <div><span class="label">Transport:</span> <span class="value">${mcp.transport || 'N/A'}</span></div>
            <div><span class="label">Server URL:</span> <span class="value">${mcp.serverUrl || 'N/A'}</span></div>
            <div><span class="label">SSE Endpoint:</span> <span class="value">${mcp.sseEndpoint || 'N/A'}</span></div>
            <div><span class="label">Required VS Code:</span> <span class="value">${mcp.requiredVscodeVersion || 'N/A'}</span></div>
        </div>
    </div>

    <h2>🖇️ Process Environment Variables (PYTHONPATH+)</h2>
    <div class="card" style="max-width: 100%;">
        <div class="env-list">
            ${this._renderEnv(m.env)}
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
    </script>
</body>
</html>`;
    }
    _renderEnv(env) {
        if (!env)
            return '<div class="value">No environment overrides detected.</div>';
        // Show all env for maximum geek factor
        return Object.entries(env)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, val]) => `
                <div class="env-item">
                    <span class="env-key">${key}</span>
                    <span class="env-val" title="${val}">${val}</span>
                </div>
            `).join('');
    }
    _getUptime(startTime) {
        const diff = Date.now() - startTime.getTime();
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days > 0)
            return `${days}d ${hours % 24}h ${minutes % 60}m`;
        if (hours > 0)
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        if (minutes > 0)
            return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }
}
exports.StatusPanel = StatusPanel;
//# sourceMappingURL=statusPanel.js.map