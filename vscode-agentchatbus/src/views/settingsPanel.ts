import * as vscode from 'vscode';

type AgentChatBusSettings = {
    serverUrl: string;
    autoStartBusServer: boolean;
    msgWaitMinTimeoutMs: number;
    scopeLabel: string;
};

type WebviewMessage =
    | {
        command: 'saveSettings';
        payload?: {
            serverUrl?: string;
            autoStartBusServer?: boolean;
            msgWaitMinTimeoutMs?: number | string;
        };
    }
    | { command: 'openVscodeSettings' };

export class SettingsPanel {
    public static currentPanel: SettingsPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel) {
        this.panel = panel;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
            void this.handleMessage(message);
        }, null, this.disposables);
        this.render();
    }

    public static createOrShow(): void {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        if (SettingsPanel.currentPanel) {
            SettingsPanel.currentPanel.panel.reveal(column);
            void SettingsPanel.currentPanel.render();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'acbSettings',
            'AgentChatBus: Server Settings',
            column,
            {
                enableScripts: true,
            }
        );

        SettingsPanel.currentPanel = new SettingsPanel(panel);
    }

    public dispose(): void {
        SettingsPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length > 0) {
            const disposable = this.disposables.pop();
            disposable?.dispose();
        }
    }

    private async handleMessage(message: WebviewMessage): Promise<void> {
        if (message.command === 'openVscodeSettings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'AgentChatBus');
            return;
        }

        if (message.command !== 'saveSettings') {
            return;
        }

        const payload = message.payload || {};
        const serverUrl = String(payload.serverUrl || '').trim();
        if (!serverUrl) {
            void vscode.window.showErrorMessage('Server URL must not be empty.');
            return;
        }

        const config = vscode.workspace.getConfiguration('agentchatbus');
        await config.update('serverUrl', serverUrl, this.resolveConfigurationTarget('serverUrl'));
        await config.update(
            'autoStartBusServer',
            Boolean(payload.autoStartBusServer),
            this.resolveConfigurationTarget('autoStartBusServer')
        );
        const rawMinTimeout = payload.msgWaitMinTimeoutMs;
        const parsedMinTimeout = Number(rawMinTimeout);
        if (!Number.isFinite(parsedMinTimeout) || parsedMinTimeout < 0) {
            void vscode.window.showErrorMessage('msg_wait minimum timeout must be a non-negative number.');
            return;
        }
        await config.update(
            'msgWaitMinTimeoutMs',
            Math.floor(parsedMinTimeout),
            this.resolveConfigurationTarget('msgWaitMinTimeoutMs')
        );

        void vscode.window.showInformationMessage('AgentChatBus settings saved to VS Code configuration.');
        await this.render();
    }

    private resolveConfigurationTarget(
        section: 'serverUrl' | 'autoStartBusServer' | 'msgWaitMinTimeoutMs'
    ): vscode.ConfigurationTarget {
        const config = vscode.workspace.getConfiguration('agentchatbus');
        const inspected = config.inspect(section);
        if (inspected?.workspaceFolderValue !== undefined) {
            return vscode.ConfigurationTarget.WorkspaceFolder;
        }
        if (inspected?.workspaceValue !== undefined) {
            return vscode.ConfigurationTarget.Workspace;
        }
        return vscode.ConfigurationTarget.Global;
    }

    private getSettings(): AgentChatBusSettings {
        const config = vscode.workspace.getConfiguration('agentchatbus');
        const serverUrlInspect = config.inspect<string>('serverUrl');
        const autoStartInspect = config.inspect<boolean>('autoStartBusServer');
        const msgWaitMinInspect = config.inspect<number>('msgWaitMinTimeoutMs');

        const scopeLabel = serverUrlInspect?.workspaceFolderValue !== undefined
            || autoStartInspect?.workspaceFolderValue !== undefined
            || msgWaitMinInspect?.workspaceFolderValue !== undefined
            ? 'Workspace Folder'
            : serverUrlInspect?.workspaceValue !== undefined
                || autoStartInspect?.workspaceValue !== undefined
                || msgWaitMinInspect?.workspaceValue !== undefined
                ? 'Workspace'
                : 'User';

        return {
            serverUrl: config.get<string>('serverUrl', 'http://127.0.0.1:39765'),
            autoStartBusServer: config.get<boolean>('autoStartBusServer', true),
            msgWaitMinTimeoutMs: Math.max(0, Math.floor(config.get<number>('msgWaitMinTimeoutMs', 60000))),
            scopeLabel,
        };
    }

    private async render(): Promise<void> {
        const settings = this.getSettings();
        this.panel.webview.html = this.getHtml(settings);
    }

    private getHtml(settings: AgentChatBusSettings): string {
        const escapedServerUrl = this.escapeHtml(settings.serverUrl);
        const checked = settings.autoStartBusServer ? 'checked' : '';
        const msgWaitMinTimeoutMs = this.escapeHtml(String(settings.msgWaitMinTimeoutMs));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AgentChatBus Settings</title>
    <style>
        :root {
            color-scheme: light dark;
        }
        body {
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 24px;
            line-height: 1.5;
        }
        h1 {
            font-size: 1.5rem;
            font-weight: 600;
            margin: 0 0 12px;
        }
        p {
            color: var(--vscode-descriptionForeground);
            margin: 0 0 18px;
        }
        .card {
            max-width: 760px;
            padding: 20px;
            border: 1px solid var(--vscode-widget-border);
            border-radius: 10px;
            background: color-mix(in srgb, var(--vscode-sideBar-background) 85%, transparent);
        }
        .meta {
            margin-bottom: 18px;
            font-size: 0.92rem;
            color: var(--vscode-descriptionForeground);
        }
        label {
            display: block;
            margin: 16px 0 6px;
            font-weight: 600;
        }
        input[type="text"] {
            width: 100%;
            box-sizing: border-box;
            padding: 10px 12px;
            border-radius: 6px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }
        .checkbox-row {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-top: 16px;
        }
        .checkbox-row label {
            margin: 0;
            font-weight: 500;
        }
        .hint {
            margin-top: 8px;
            font-size: 0.9rem;
            color: var(--vscode-descriptionForeground);
        }
        .actions {
            display: flex;
            gap: 12px;
            margin-top: 24px;
            flex-wrap: wrap;
        }
        button {
            border: none;
            border-radius: 6px;
            padding: 10px 14px;
            cursor: pointer;
            font: inherit;
        }
        .primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .code {
            font-family: var(--vscode-editor-font-family);
        }
    </style>
</head>
<body>
    <h1>Server Settings</h1>
    <p>This panel edits the same VS Code settings used by the extension. You can change them here or in Settings UI, and both stay in sync.</p>
    <div class="card">
        <div class="meta">Current configuration scope: <span class="code">${this.escapeHtml(settings.scopeLabel)}</span></div>
        <label for="serverUrl">Server URL</label>
        <input id="serverUrl" type="text" value="${escapedServerUrl}" spellcheck="false" />
        <div class="hint">Examples: <span class="code">http://127.0.0.1:39765</span> or <span class="code">http://192.168.50.186:39765</span></div>
        <div class="checkbox-row">
            <input id="autoStartBusServer" type="checkbox" ${checked} />
            <label for="autoStartBusServer">Automatically start the AgentChatBus server when needed</label>
        </div>
        <label for="msgWaitMinTimeoutMs">msg_wait Minimum Blocking Timeout (ms)</label>
        <input id="msgWaitMinTimeoutMs" type="text" value="${msgWaitMinTimeoutMs}" spellcheck="false" />
        <div class="hint">Server may enforce this minimum for blocking waits. Quick-return recovery paths remain immediate. Bundled server restart required after change.</div>
        <div class="actions">
            <button class="primary" id="saveButton">Save to VS Code Settings</button>
            <button class="secondary" id="openButton">Open VS Code Settings</button>
        </div>
        <div class="hint">VS Code search keyword: <span class="code">AgentChatBus</span></div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('saveButton').addEventListener('click', () => {
            vscode.postMessage({
                command: 'saveSettings',
                payload: {
                    serverUrl: document.getElementById('serverUrl').value,
                    autoStartBusServer: document.getElementById('autoStartBusServer').checked,
                    msgWaitMinTimeoutMs: document.getElementById('msgWaitMinTimeoutMs').value
                }
            });
        });
        document.getElementById('openButton').addEventListener('click', () => {
            vscode.postMessage({ command: 'openVscodeSettings' });
        });
    </script>
</body>
</html>`;
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}
