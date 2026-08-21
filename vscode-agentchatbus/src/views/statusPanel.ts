import * as vscode from 'vscode';

export class StatusPanel {
    public static currentPanel: StatusPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, private metadata: any) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getHtmlForWebview();
    }

    public static createOrShow(metadata: any) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (StatusPanel.currentPanel) {
            StatusPanel.currentPanel.metadata = metadata;
            StatusPanel.currentPanel._panel.webview.html = StatusPanel.currentPanel._getHtmlForWebview();
            StatusPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'acbStatus',
            'AgentChatBus: Server Status',
            column || vscode.ViewColumn.One,
            { enableScripts: true }
        );

        StatusPanel.currentPanel = new StatusPanel(panel, metadata);
    }

    public dispose() {
        StatusPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _getHtmlForWebview() {
        const m = this.metadata;
        const ide = m.ide || {};
        const mcp = m.mcp || {};
        const lmProbe = m.lmProbe || {};
        const attempts = Array.isArray(m.resolutionAttempts) ? m.resolutionAttempts : [];
        const isExternalMode = String(m.startupMode || '').startsWith('external-service');
        const serverReachable = Boolean(m.serverReachable);
        const isLocalHost = Boolean(m.pid) || Boolean(ide.isOwner);
        const isExternalHost = !isLocalHost && serverReachable;
        // Status is tri-state: RUNNING · LOCAL (this IDE hosts the process),
        // RUNNING · EXTERNAL (service is reachable but hosted by another IDE / external process),
        // or STOPPED (not reachable and no local process).
        const serverStatus = isLocalHost
            ? 'RUNNING · LOCAL'
            : isExternalHost
                ? 'RUNNING · EXTERNAL'
                : 'STOPPED';
        const serverStatusBadgeClass = isLocalHost || isExternalHost ? 'ok' : 'error';
        // Hint shown directly under Status to disambiguate "EXTERNAL":
        // tells the user the service is alive but hosted by another IDE,
        // and identifies the hosting IDE when the backend reports an owner.
        const ownerLabel = typeof ide.ownerLabel === 'string' && ide.ownerLabel ? ide.ownerLabel : '';
        const ownerInstanceId = typeof ide.ownerInstanceId === 'string' && ide.ownerInstanceId ? ide.ownerInstanceId : '';
        const ownerShortId = ownerInstanceId ? ownerInstanceId.slice(0, 8) : '';
        const registeredIdeCount = typeof ide.registeredSessionsCount === 'number' ? ide.registeredSessionsCount : 0;
        const serverStatusHint = isLocalHost
            ? 'This IDE is hosting the server process.'
            : isExternalHost
                ? (ownerLabel
                    ? `Server is running in another IDE: ${ownerLabel}${ownerShortId ? ` (instance ${ownerShortId})` : ''}.${registeredIdeCount > 0 ? ` ${registeredIdeCount} IDE(s) registered.` : ''}`
                    : 'Server is reachable but hosted by an external process (no IDE owner reported by the backend).')
                : 'Server is not running. Start it from an IDE or externally.';
        const isRemote = String(m.serverScope || '').toLowerCase() === 'remote';
        const hidden = '[hidden for remote server]';
        const pidDisplay = isRemote
            ? hidden
            : (m.pid
                ? String(m.pid)
                : isExternalHost
                    ? (ownerLabel ? `hosted by ${ownerLabel}` : 'external process')
                    : 'N/A');
        const uptime = m.startTime
            ? this._getUptime(new Date(m.startTime))
            : (typeof m.backendUptimeSeconds === 'number'
                ? this._formatUptimeSeconds(m.backendUptimeSeconds)
                : 'N/A');
        const startedAtDisplay = m.startTime || m.backendStartedAt || 'N/A';
        const mcpApiStatus = mcp.apiAvailable ? 'AVAILABLE' : 'UNAVAILABLE';
        const mcpProviderStatus = mcp.providerRegistered ? 'REGISTERED' : 'PENDING';

        const lmApiAvailable = Boolean(lmProbe.apiAvailable);
        const lmSelectAvailable = Boolean(lmProbe.selectChatModelsAvailable);
        const lmProactiveSupported = Boolean(lmProbe.supportedForProactiveInvocation);
        const lmCopilotSupported = Boolean(lmProbe.supportedForCopilotVendor);
        const lmProbeAt = typeof lmProbe.probeAt === 'string' ? lmProbe.probeAt : 'N/A';
        const lmError = typeof lmProbe.error === 'string' ? lmProbe.error : '';
        const lmNotes = Array.isArray(lmProbe.notes) ? lmProbe.notes : [];
        const lmModels = Array.isArray(lmProbe.models) ? lmProbe.models : [];
        const lmCopilotModels = Array.isArray(lmProbe.copilotModels) ? lmProbe.copilotModels : [];
        const lmApiStatus = lmApiAvailable ? 'AVAILABLE' : 'UNAVAILABLE';
        const lmSelectStatus = lmSelectAvailable ? 'AVAILABLE' : 'UNAVAILABLE';
        const lmProactiveStatus = lmProactiveSupported ? 'SUPPORTED' : 'UNSUPPORTED';
        const lmCopilotStatus = lmCopilotSupported ? 'SUPPORTED' : (lmModels.length > 0 ? 'MISSING' : 'UNSUPPORTED');
        const lmProactiveBadgeClass = lmProactiveSupported ? 'ok' : 'error';
        const lmCopilotBadgeClass = lmCopilotSupported ? 'ok' : (lmModels.length > 0 ? 'warn' : 'error');
        const startupMode = this._getStartupModeSummary(m.startupMode);
        const webUiMode = this._getWebUiModeSummary(m.startupMode, m.env?.AGENTCHATBUS_WEB_UI_DIR);
        const backend = this._getBackendSummary(m.backendEngine, m.startupMode);
        const backendSource = m.backendEngineSource || 'unknown';
        const backendVersion = m.backendVersion || 'N/A';
        const backendRuntime = m.backendRuntime || 'N/A';
        const bindHost = String(m.bindHost || 'N/A');
        const lanIps = Array.isArray(m.lanIps) ? m.lanIps : [];
        const serverUrlDisplay = String(m.serverUrl || 'N/A');
        const bindHostDisplay = bindHost === '0.0.0.0'
            ? `0.0.0.0 (all interfaces)${lanIps.length > 0 ? ' — accessible via: ' + lanIps.join(', ') : ''}`
            : bindHost;
        const agentTransportRaw = String(m.agentTransport || '').trim().toLowerCase();
        const agentTransport = agentTransportRaw === 'v1-http' ? 'v1-http' : (agentTransportRaw === 'v2-socket' ? 'v2-socket' : 'unknown');
        const agentTransportLabel = agentTransport === 'v2-socket'
            ? 'V2: Socket (recommended)'
            : agentTransport === 'v1-http'
                ? 'V1: HTTP + SSE (legacy)'
                : 'N/A';
        const agentTransportBadgeClass = agentTransport === 'v2-socket' ? 'ok' : agentTransport === 'v1-http' ? 'warn' : 'neutral';
        const agentTransportTooltip = agentTransport === 'v2-socket'
            ? 'V2 (Socket): Agents connect via Unix socket / Windows named pipe. No IP or port configuration needed for agents. The HTTP server still runs for the Web UI only — agents do NOT connect to the IP/port.'
            : agentTransport === 'v1-http'
                ? 'V1 (HTTP + SSE, legacy): Agents connect via HTTP + SSE to the server IP and port. Requires agents to know the server URL.'
                : 'Agent transport mode could not be determined from the running backend.';
        // Build the list of URLs that clients can actually connect to.
        const port = (() => {
            try { return String(new URL(serverUrlDisplay).port || '39765'); }
            catch { return '39765'; }
        })();
        const accessUrls: string[] = [];
        if (bindHost === '0.0.0.0' || bindHost === '::') {
            if (lanIps.length > 0) {
                for (const ip of lanIps) { accessUrls.push(`http://${ip}:${port}`); }
            }
            accessUrls.push(`http://127.0.0.1:${port}`);
        } else if (bindHost !== 'N/A' && bindHost !== 'unknown') {
            accessUrls.push(`http://${bindHost}:${port}`);
        } else {
            accessUrls.push(serverUrlDisplay);
        }
        const appDir = isRemote ? hidden : (m.env?.AGENTCHATBUS_APP_DIR || 'N/A');
        const dbPath = isRemote ? hidden : (m.env?.AGENTCHATBUS_DB || 'N/A');
        const commandDisplay = isRemote ? hidden : (m.command || 'N/A');
        const argsDisplay = isRemote ? hidden : (m.args ? m.args.join(' ') : 'N/A');
        const workDirDisplay = isRemote ? hidden : (m.cwd || 'N/A');
        const hostNodeDisplay = isRemote ? hidden : (m.hostNodeExecutable || 'N/A');
        const envHtml = isRemote
            ? '<div class="value">Hidden for remote server to avoid exposing local process details.</div>'
            : this._renderEnv(m.env);
        
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
        .grid { display: flex; flex-direction: column; gap: 16px; }
        .card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border); padding: 15px; border-radius: 4px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .label { font-weight: bold; color: var(--vscode-descriptionForeground); font-size: 0.9em; min-width: 120px; display: inline-block; }
        .value { font-family: 'Courier New', Courier, monospace; color: var(--vscode-textPreformat-foreground); word-break: break-all; }
        .status-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.8em; font-weight: bold; background: #28a745; color: white; }
        .status-badge.ok { background: #28a745; }
        .status-badge.warn { background: #d29922; }
        .status-badge.error { background: #d73a49; }
        .status-badge.neutral { background: #6a737d; }
        .hint { margin-top: 10px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
        .warn { margin: 12px 0 18px; border: 1px solid #d29922; background: rgba(210, 153, 34, 0.12); color: var(--vscode-editor-foreground); padding: 10px 12px; border-radius: 6px; font-size: 0.9em; }
        .mode-help { margin-top: 10px; border-top: 1px solid var(--vscode-widget-border); padding-top: 8px; }
        .mode-help-item { margin-top: 4px; }
        .mode-help code { font-size: 0.95em; }
        .mode-tag { display: inline-flex; align-items: center; gap: 8px; }
        .env-list { margin: 0; padding: 0; list-style: none; font-size: 0.9em; }
        .env-item { border-bottom: 1px solid var(--vscode-widget-border); padding: 4px 0; display: flex; justify-content: space-between; }
        .env-key { color: var(--vscode-symbolIcon-variableForeground); }
        .env-val { color: var(--vscode-textLink-foreground); text-align: right; overflow: hidden; text-overflow: ellipsis; }
        .access-urls { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
        .access-url-row { display: flex; align-items: center; gap: 8px; }
        .copy-btn { border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; padding: 2px 10px; font-size: 0.8em; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); white-space: nowrap; }
        .copy-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground)); }
        .copy-btn.copied { background: #28a745; color: #fff; border-color: #28a745; }
    </style>
</head>
<body>
    <h1>📟 AgentChatBus System Diagnostics</h1>
    ${isRemote ? `<div class="warn">⚠️ ${m.privacyWarning || 'Remote server detected. Sensitive fields are hidden.'}</div>` : ''}
    
    <div class="grid">
        <div class="card">
            <h2>🌍 Server Instance</h2>
            <div><span class="label">Status:</span> <span class="status-badge ${serverStatusBadgeClass}">${serverStatus}</span></div>
            <div class="hint">${this._escapeHtml(serverStatusHint)}</div>
            <div><span class="label">Bind Address:</span> <span class="value">${bindHostDisplay}</span></div>
            <div>
                <span class="label">Access URLs:</span>
                <div class="access-urls">
                    ${accessUrls.map(url => `
                    <div class="access-url-row">
                        <span class="value">${this._escapeHtml(url)}</span>
                        <button class="copy-btn" data-url="${this._escapeHtml(url)}" title="Copy to clipboard">Copy</button>
                    </div>`).join('')}
                </div>
            </div>
            <div><span class="label">PID:</span> <span class="value">${pidDisplay}</span></div>
            <div><span class="label">Uptime:</span> <span class="value">${uptime}</span></div>
            <div><span class="label">Started At:</span> <span class="value">${startedAtDisplay}</span></div>
            <div><span class="label">Backend:</span> <span class="value">${backend}</span></div>
            <div><span class="label">Backend Version:</span> <span class="value">${backendVersion}</span></div>
            <div><span class="label">Backend Runtime:</span> <span class="value">${backendRuntime}</span></div>
            <div><span class="label">Backend Source:</span> <span class="value">${backendSource}</span></div>
            <div title="${this._escapeHtml(agentTransportTooltip)}"><span class="label">Agent Transport:</span> <span class="status-badge ${agentTransportBadgeClass}" title="${this._escapeHtml(agentTransportTooltip)}">${agentTransportLabel}</span></div>
            ${agentTransport === 'v2-socket'
                ? `<div class="hint" title="In V2 mode, the HTTP server is for Web UI access only. Agents connect via socket, not the IP/port.">ℹ️ In V2 mode, the URLs above are for <strong>Web UI access only</strong>. MCP agents connect via Unix socket / named pipe and do <strong>not</strong> use the IP address or port.</div>`
                : agentTransport === 'v1-http'
                    ? `<div class="hint" title="In V1 mode, agents connect to the server IP and port via HTTP + SSE.">ℹ️ In V1 mode, agents connect to the URLs above via HTTP + SSE.</div>`
                    : ''}
        </div>

        <div class="card">
            <h2>⚙️ Startup Configuration</h2>
            <div><span class="label">Mode:</span> <span class="value mode-tag">${startupMode.icon} ${startupMode.label}</span></div>
            <div><span class="label">Web UI Mode:</span> <span class="value mode-tag">${webUiMode.icon} ${webUiMode.label}</span></div>
            <div><span class="label">Managed By:</span> <span class="value">${startupMode.managedBy}</span></div>
            <div class="hint">${startupMode.description}</div>
            <div class="hint">${webUiMode.description}</div>
            <div><span class="label">Resolved By:</span> <span class="value">${m.resolvedBy || 'N/A'}</span></div>
            <div><span class="label">Web UI Path:</span> <span class="value">${isRemote ? hidden : (m.env?.AGENTCHATBUS_WEB_UI_DIR || 'N/A')}</span></div>
            <div><span class="label">Executable:</span> <span class="value">${commandDisplay}</span></div>
            <div><span class="label">Arguments:</span> <span class="value">${argsDisplay}</span></div>
            <div><span class="label">WorkDir:</span> <span class="value">${workDirDisplay}</span></div>
            <div><span class="label">App Dir:</span> <span class="value">${appDir}</span></div>
            <div><span class="label">DB Path:</span> <span class="value">${dbPath}</span></div>
            <div class="mode-help">
                <div><span class="label">Supported Modes:</span> <span class="value">5</span></div>
                <div class="mode-help-item">🛠️ <code>workspace-dev-service</code>: Extension launches local workspace agentchatbus-ts with local web-ui sources and dev auto-reload.</div>
                <div class="mode-help-item">✅ <code>bundled-ts-service</code>: Extension launches bundled agentchatbus-ts (managed by VS Code extension).</div>
                <div class="mode-help-item">🔒 <code>Extension Bundled Web UI</code>: Reads the web UI packaged inside the extension.</div>
                <div class="mode-help-item">✅ <code>Workspace Web UI</code>: Reads the live <code>web-ui/</code> sources from the current repo.</div>
                <div class="mode-help-item">🧩 <code>external-service-extension-managed</code>: External backend detected, ownership is assignable (typically started by an extension-managed bootstrap).</div>
                <div class="mode-help-item">👤 <code>external-service-manual</code>: External backend detected, ownership is not assignable (typically started manually by command).</div>
                <div class="mode-help-item">📡 <code>external-service-unknown</code>: External backend detected, but health payload lacks ownership detail (legacy/limited backend).</div>
            </div>
        </div>

        <div class="card">
            <h2>💻 Runtime Environment</h2>
            <div><span class="label">Platform:</span> <span class="value">${m.platform} (${m.arch})</span></div>
            <div><span class="label">Node.js:</span> <span class="value">${m.nodeVersion}</span></div>
            <div><span class="label">Host Node:</span> <span class="value">${hostNodeDisplay}</span></div>
            <div><span class="label">Extension:</span> <span class="value">${m.extensionVersion || 'N/A'}</span></div>
            <div><span class="label">VS Code:</span> <span class="value">${m.vscodeVersion}</span></div>
        </div>

        <div class="card">
            <h2>🪪 IDE Ownership</h2>
            <div><span class="label">Instance ID:</span> <span class="value">${ide.instanceId || 'N/A'}</span></div>
            <div><span class="label">Label:</span> <span class="value">${ide.label || 'N/A'}</span></div>
            <div><span class="label">Registered:</span> <span class="value">${ide.registered ? 'yes' : 'no'}</span></div>
            <div><span class="label">Is Owner:</span> <span class="value">${ide.isOwner ? 'yes' : 'no'}</span></div>
            <div><span class="label">Can Shutdown:</span> <span class="value">${ide.canShutdown ? 'yes' : 'no'}</span></div>
            <div><span class="label">Owner Assignable:</span> <span class="value">${ide.ownershipAssignable ? 'yes' : 'no'}</span></div>
            <div><span class="label">Current Owner:</span> <span class="value">${ide.ownerInstanceId || 'none'}</span></div>
            <div><span class="label">Owner Label:</span> <span class="value">${ide.ownerLabel || 'none'}</span></div>
            <div><span class="label">Registered IDEs:</span> <span class="value">${ide.registeredSessionsCount ?? 0}</span></div>
        </div>

        <div class="card">
            <h2>🔌 MCP Integration</h2>
            <div><span class="label">API:</span> <span class="status-badge">${mcpApiStatus}</span></div>
            <div><span class="label">Provider:</span> <span class="status-badge">${mcpProviderStatus}</span></div>
            <div><span class="label">Provider ID:</span> <span class="value">${mcp.providerId || 'N/A'}</span></div>
            <div><span class="label">Label:</span> <span class="value">${mcp.providerLabel || 'N/A'}</span></div>
            <div><span class="label">Transport:</span> <span class="value">${mcp.transport || 'N/A'}</span></div>
            <div><span class="label">Server URL:</span> <span class="value">${mcp.serverUrl || 'N/A'}</span></div>
            <div><span class="label">MCP Endpoint:</span> <span class="value">${mcp.sseEndpoint || 'N/A'}</span></div>
            <div><span class="label">Required VS Code:</span> <span class="value">${mcp.requiredVscodeVersion || 'N/A'}</span></div>
        </div>

        <div class="card">
            <h2>🤖 IDE Agent Invocation (vscode.lm)</h2>
            <div><span class="label">LM API:</span> <span class="status-badge ${lmApiAvailable ? 'ok' : 'error'}">${lmApiStatus}</span></div>
            <div><span class="label">selectChatModels:</span> <span class="status-badge ${lmSelectAvailable ? 'ok' : 'error'}">${lmSelectStatus}</span></div>
            <div><span class="label">Models:</span> <span class="value">${lmModels.length}</span></div>
            <div><span class="label">Copilot models:</span> <span class="value">${lmCopilotModels.length}</span></div>
            <div><span class="label">Proactive invoke:</span> <span class="status-badge ${lmProactiveBadgeClass}">${lmProactiveStatus}</span></div>
            <div><span class="label">Copilot vendor:</span> <span class="status-badge ${lmCopilotBadgeClass}">${lmCopilotStatus}</span></div>
            <div><span class="label">Probe At:</span> <span class="value">${lmProbeAt}</span></div>
            ${lmError ? `<div class="warn">⚠️ Language model probe error: <span class="value">${this._escapeHtml(lmError)}</span></div>` : ''}
            ${this._renderLmNotes(lmNotes)}
            ${lmCopilotModels.length > 0
                ? `<div class="hint">Copilot models (vendor=copilot):</div><div class="env-list">${this._renderLmModels(lmCopilotModels)}</div>`
                : `<div class="hint">No Copilot models found. Showing all models visible to extensions:</div><div class="env-list">${this._renderLmModels(lmModels)}</div>`
            }
            ${lmProactiveSupported
                ? `<div class="hint">If this is SUPPORTED, AgentChatBus can proactively call an IDE chat model (runNewCopilotSession). If canSendRequest=unknown, the first invocation will trigger a VS Code consent prompt.</div>`
                : `<div class="warn">This environment does not support proactive IDE agent invocation from this extension. If you still want agents to use AgentChatBus, use MCP integration from your chat UI (the chat tool calls the bus, rather than the bus calling the chat tool).</div>`
            }
        </div>
    </div>

    <h2>🖇️ Process Environment Variables</h2>
    <div class="card" style="max-width: 100%;">
        <div class="env-list">
            ${envHtml}
        </div>
    </div>

    <h2>🧭 Resolution Attempts</h2>
    <div class="card" style="max-width: 100%;">
        <div class="env-list">
            ${this._renderAttempts(attempts)}
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        document.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const url = btn.getAttribute('data-url') || '';
                try {
                    await navigator.clipboard.writeText(url);
                    btn.textContent = 'Copied!';
                    btn.classList.add('copied');
                    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
                } catch {
                    // Fallback for environments without clipboard API
                    const ta = document.createElement('textarea');
                    ta.value = url;
                    document.body.appendChild(ta);
                    ta.select();
                    try { document.execCommand('copy'); } catch {}
                    document.body.removeChild(ta);
                    btn.textContent = 'Copied!';
                    btn.classList.add('copied');
                    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
                }
            });
        });
    </script>
</body>
</html>`;
    }

    private _getStartupModeSummary(startupMode: unknown): {
        label: string;
        description: string;
        icon: string;
        managedBy: string;
    } {
        const mode = String(startupMode || '').trim().toLowerCase();
        if (mode === 'workspace-dev-service') {
            return {
                label: 'workspace-dev-service',
                description: 'Launched directly from the current AgentChatBus workspace using local agentchatbus-ts and local web-ui sources.',
                icon: '🛠️',
                managedBy: '🧪 This extension (workspace-dev runtime)',
            };
        }
        if (mode === 'bundled-ts-service') {
            return {
                label: 'bundled-ts-service',
                description: 'Launched directly by this extension using bundled agentchatbus-ts runtime.',
                icon: '✅',
                managedBy: '🧩 This extension (owner-managed launch)',
            };
        }
        if (mode === 'external-service') {
            return {
                label: 'external-service',
                description: 'External backend process detected by health probe and attached by this extension.',
                icon: '🔗',
                managedBy: '🌐 External service',
            };
        }
        if (mode === 'external-service-extension-managed') {
            return {
                label: 'external-service-extension-managed',
                description: 'External backend detected with ownership assignable=true (extension-managed bootstrap).',
                icon: '🧩',
                managedBy: '🔌 External bootstrap (extension-assigned ownership)',
            };
        }
        if (mode === 'external-service-manual') {
            return {
                label: 'external-service-manual',
                description: 'External backend detected with ownership assignable=false (manual command startup).',
                icon: '👤',
                managedBy: '👤 Manual external process',
            };
        }
        if (mode === 'external-service-unknown') {
            return {
                label: 'external-service-unknown',
                description: 'External backend detected but ownership metadata is unavailable from /health.',
                icon: '📡',
                managedBy: '❓ External service (owner metadata unavailable)',
            };
        }
        return {
            label: mode || 'N/A',
            description: 'Unknown mode. Extension currently documents workspace-dev-service, bundled-ts-service, and the external-service variants.',
            icon: '🔎',
            managedBy: '❔ Unknown',
        };
    }

    private _getBackendSummary(engine: unknown, startupMode: unknown): string {
        const normalizedEngine = String(engine || '').trim().toLowerCase();
        if (normalizedEngine === 'node') return 'Node.js';
        if (normalizedEngine === 'python') return 'Python';

        const mode = String(startupMode || '').trim().toLowerCase();
        if (mode === 'workspace-dev-service') return 'Node.js';
        if (mode === 'bundled-ts-service') return 'Node.js';
        return 'Unknown';
    }

    private _getWebUiModeSummary(
        startupMode: unknown,
        webUiDir: unknown,
    ): {
        label: string;
        description: string;
        icon: string;
    } {
        const mode = String(startupMode || '').trim().toLowerCase();
        const normalizedWebUiDir = String(webUiDir || '').trim().replace(/\\/g, '/').toLowerCase();

        if (mode === 'bundled-ts-service') {
            return {
                label: 'Extension Bundled Web UI',
                description: 'Using the web UI packaged inside the VS Code extension resources.',
                icon: '🔒',
            };
        }

        if (mode === 'workspace-dev-service') {
            return {
                label: 'Workspace Web UI',
                description: 'Using the live web-ui sources from the current AgentChatBus workspace.',
                icon: '✅',
            };
        }

        if (normalizedWebUiDir.includes('/resources/web-ui')) {
            return {
                label: 'Extension Bundled Web UI',
                description: 'Resolved AGENTCHATBUS_WEB_UI_DIR points at extension-packaged web UI assets.',
                icon: '🔒',
            };
        }

        if (normalizedWebUiDir.endsWith('/web-ui') || normalizedWebUiDir.includes('/web-ui/')) {
            return {
                label: 'Workspace Web UI',
                description: 'Resolved AGENTCHATBUS_WEB_UI_DIR points at a repo/workspace web-ui directory.',
                icon: '✅',
            };
        }

        return {
            label: 'Unknown Web UI Source',
            description: 'Could not determine whether the server is using bundled or workspace web UI assets.',
            icon: '❓',
        };
    }

    private _escapeHtml(raw: unknown): string {
        return String(raw ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private _renderLmNotes(notes: string[]) {
        if (!Array.isArray(notes) || notes.length === 0) {
            return '';
        }

        const lines = notes
            .map((line) => `<div class="mode-help-item">• ${this._escapeHtml(line)}</div>`)
            .join('');

        return `<div class="hint">${lines}</div>`;
    }

    private _renderLmModels(models: any[]) {
        if (!Array.isArray(models) || models.length === 0) {
            return '<div class="value">No models detected.</div>';
        }

        return models
            .map((model) => {
                const name = this._escapeHtml(model?.name || 'model');
                const id = this._escapeHtml(model?.id || '');
                const vendor = this._escapeHtml(model?.vendor || '');
                const family = this._escapeHtml(model?.family || '');
                const version = this._escapeHtml(model?.version || '');
                const maxInputTokens = this._escapeHtml(model?.maxInputTokens ?? '');
                const canSendRequest = this._escapeHtml(model?.canSendRequest || 'unknown');
                const right = `${vendor}/${family}/${version} • maxInputTokens=${maxInputTokens} • canSendRequest=${canSendRequest}`;

                return `
                    <div class="env-item">
                        <span class="env-key" title="${id}">${name}</span>
                        <span class="env-val" title="${id}">${right}</span>
                    </div>
                `;
            })
            .join('');
    }

    private _renderEnv(env: any) {
        if (!env) return '<div class="value">No environment overrides detected.</div>';
        
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

    private _renderAttempts(attempts: string[]) {
        if (attempts.length === 0) {
            return '<div class="value">No recorded resolution attempts.</div>';
        }

        return attempts
            .map(entry => `
                <div class="env-item">
                    <span class="env-key">step</span>
                    <span class="env-val" title="${entry}">${entry}</span>
                </div>
            `)
            .join('');
    }

    private _getUptime(startTime: Date): string {
        const diff = Date.now() - startTime.getTime();
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
        if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    private _formatUptimeSeconds(totalSeconds: number): string {
        const safeSeconds = Math.max(0, Math.floor(totalSeconds));
        const minutes = Math.floor(safeSeconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
        if (hours > 0) return `${hours}h ${minutes % 60}m ${safeSeconds % 60}s`;
        if (minutes > 0) return `${minutes}m ${safeSeconds % 60}s`;
        return `${safeSeconds}s`;
    }
}
