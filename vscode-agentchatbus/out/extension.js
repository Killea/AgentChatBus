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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const client_1 = require("./api/client");
const threadsProvider_1 = require("./providers/threadsProvider");
const agentsProvider_1 = require("./providers/agentsProvider");
const chatPanel_1 = require("./views/chatPanel");
const busServerManager_1 = require("./busServerManager");
const cursorMcpConfig_1 = require("./cursorMcpConfig");
const setupProvider_1 = require("./providers/setupProvider");
const mcpLogProvider_1 = require("./providers/mcpLogProvider");
const settingsProvider_1 = require("./providers/settingsProvider");
const statusPanel_1 = require("./views/statusPanel");
let apiClient;
let mcpLogProvider;
let settingsProvider;
let cursorConfigManager;
let serverManagerInstance;
let mainViewsInitialized = false;
function activate(context) {
    console.log('[AgentChatBus] Activating extension...');
    chatPanel_1.ChatPanel.setExtensionPath(context.extensionPath);
    const serverManager = new busServerManager_1.BusServerManager();
    serverManagerInstance = serverManager;
    cursorConfigManager = new cursorMcpConfig_1.CursorMcpConfigManager();
    const setupProvider = new setupProvider_1.SetupProvider();
    mcpLogProvider = new mcpLogProvider_1.McpLogProvider();
    serverManager.setSetupProvider(setupProvider);
    serverManager.setMcpLogProvider(mcpLogProvider);
    context.subscriptions.push(serverManager);
    context.subscriptions.push(setupProvider);
    context.subscriptions.push(mcpLogProvider);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('agentchatbus.setup', setupProvider), vscode.window.registerTreeDataProvider('agentchatbus.mcpLogs', mcpLogProvider));
    // Set initial context for agent filter
    vscode.commands.executeCommand('setContext', 'agentchatbus:agentsFilterActive', true);
    const runSetup = async () => {
        try {
            console.log('[AgentChatBus] Starting setup process...');
            const isReady = await serverManager.ensureServerRunning();
            if (isReady) {
                console.log('[AgentChatBus] Server is ready, initializing main views.');
                if (cursorConfigManager) {
                    initializeMainViews(context, serverManager, cursorConfigManager);
                }
            }
            else {
                console.warn('[AgentChatBus] Server failed to start.');
            }
        }
        catch (error) {
            console.error('[AgentChatBus] Fatal error during setup:', error);
            serverManager.log(`Fatal error: ${error}`, 'error');
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('agentchatbus.retrySetup', () => {
        console.log('[AgentChatBus] Retry command triggered.');
        setupProvider.reset();
        runSetup();
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('agentchatbus.serverUrl') &&
            !event.affectsConfiguration('agentchatbus.pythonPath') &&
            !event.affectsConfiguration('agentchatbus.autoStartBusServer')) {
            return;
        }
        serverManager.notifyMcpDefinitionsChanged();
    }));
    // Register MCP provider (asynchronous definition provision)
    serverManager.registerMcpProvider(context);
    // Start setup asynchronously to avoid blocking the activate() call
    Promise.resolve().then(() => {
        setTimeout(() => {
            runSetup();
        }, 500);
    });
}
function initializeMainViews(context, serverManager, cursorConfigManager) {
    if (mainViewsInitialized)
        return;
    mainViewsInitialized = true;
    console.log('[AgentChatBus] Initializing main views...');
    apiClient = new client_1.AgentChatBusApiClient();
    apiClient.connectSSE();
    const threadsProvider = new threadsProvider_1.ThreadsTreeProvider(apiClient);
    const agentsProvider = new agentsProvider_1.AgentsTreeProvider(apiClient);
    settingsProvider = new settingsProvider_1.SettingsProvider();
    context.subscriptions.push(vscode.window.registerTreeDataProvider('agentchatbus.threads', threadsProvider), vscode.window.registerTreeDataProvider('agentchatbus.agents', agentsProvider), vscode.window.registerTreeDataProvider('agentchatbus.settings', settingsProvider));
    context.subscriptions.push(vscode.commands.registerCommand('agentchatbus.refreshThreads', () => threadsProvider.refresh()), vscode.commands.registerCommand('agentchatbus.refreshAgents', () => agentsProvider.refresh()), vscode.commands.registerCommand('agentchatbus.toggleAgentFilter', () => agentsProvider.toggleRecentFilter()), vscode.commands.registerCommand('agentchatbus.clearMcpLogs', () => {
        mcpLogProvider?.clear();
    }), vscode.commands.registerCommand('agentchatbus.restartServer', async () => {
        const confirmed = await vscode.window.showWarningMessage('Restart AgentChatBus Server? This will disconnect all active agents and reset the message bus state.', { modal: true }, 'Restart');
        if (confirmed === 'Restart') {
            serverManager.restartServer();
        }
    }), vscode.commands.registerCommand('agentchatbus.stopServer', async () => {
        const status = serverManager.getStatusMetadata();
        const isExternal = status.startupMode === 'external-service';
        const confirmed = await vscode.window.showWarningMessage(isExternal
            ? 'Force stop the externally managed AgentChatBus service? The extension will send a localhost shutdown request to the running MCP server.'
            : 'Force stop AgentChatBus Server? This will immediately terminate the MCP service managed by the extension.', { modal: true }, 'Force Stop');
        if (confirmed === 'Force Stop') {
            const stopped = await serverManager.stopServer();
            if (!stopped) {
                vscode.window.showWarningMessage(isExternal
                    ? 'The external AgentChatBus service did not accept the shutdown request.'
                    : 'No extension-managed MCP service could be force stopped.');
            }
        }
    }), vscode.commands.registerCommand('agentchatbus.openFullLog', () => {
        const logs = mcpLogProvider?.getLogs() || [];
        const panel = vscode.window.createWebviewPanel('agentchatbusLogs', 'AgentChatBus Full Logs', vscode.ViewColumn.One, {});
        panel.webview.html = `<html><body><pre style="padding: 10px; font-family: monospace;">${logs.join('\n')}</pre></body></html>`;
    }), vscode.commands.registerCommand('agentchatbus.openWebConsole', () => {
        const config = vscode.workspace.getConfiguration('agentchatbus');
        const url = config.get('serverUrl', 'http://127.0.0.1:39765');
        vscode.env.openExternal(vscode.Uri.parse(url));
    }), vscode.commands.registerCommand('agentchatbus.serverSettings', () => {
        vscode.window.showInformationMessage('Server settings are currently managed via VS Code Configuration.', { modal: true }, 'Open Settings').then(selection => {
            if (selection === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'agentchatbus');
            }
        });
    }), vscode.commands.registerCommand('agentchatbus.filterThreads', async () => {
        const statuses = ['discuss', 'implement', 'review', 'done', 'closed', 'archived'];
        const currentFilter = threadsProvider.getStatusFilter();
        const items = statuses.map(s => ({
            label: s.charAt(0).toUpperCase() + s.slice(1),
            status: s,
            picked: currentFilter.includes(s),
            description: s === 'archived' ? '(archived threads are hidden by default)' : undefined
        }));
        const result = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: 'Select thread statuses to display',
            ignoreFocusOut: true
        });
        if (result) {
            const selectedStatuses = result.map(i => i.status);
            threadsProvider.setStatusFilter(selectedStatuses);
        }
    }), vscode.commands.registerCommand('agentchatbus.openThread', (thread) => {
        if (thread && apiClient) {
            chatPanel_1.ChatPanel.createOrShow(thread, apiClient);
        }
    }), vscode.commands.registerCommand('agentchatbus.showStatus', () => {
        const metadata = serverManager.getStatusMetadata();
        statusPanel_1.StatusPanel.createOrShow(metadata);
    }), vscode.commands.registerCommand('agentchatbus.showMcpStatus', () => {
        const metadata = serverManager.getStatusMetadata();
        statusPanel_1.StatusPanel.createOrShow(metadata);
    }), vscode.commands.registerCommand('agentchatbus.configureCursorMcp', async () => {
        const config = vscode.workspace.getConfiguration('agentchatbus');
        const serverUrl = config.get('serverUrl', 'http://127.0.0.1:39765');
        const previewPath = cursorConfigManager.getGlobalConfigPath();
        const normalizedServerUrl = serverUrl.replace(/\/+$/, '');
        const sseUrl = `${normalizedServerUrl}/mcp/sse`;
        const confirmed = await vscode.window.showInformationMessage(`Update Cursor global MCP config at ${previewPath} to point ${'agentchatbus'} at ${sseUrl}?`, { modal: true }, 'Configure Cursor');
        if (confirmed !== 'Configure Cursor') {
            return;
        }
        try {
            const result = await cursorConfigManager.configureGlobalAgentChatBus(serverUrl);
            const action = result.changed ? 'configured' : 'already up to date';
            const followUp = await vscode.window.showInformationMessage(`Cursor MCP ${action}: ${result.serverName} -> ${result.sseUrl}`, 'Open Config');
            if (followUp === 'Open Config') {
                await cursorConfigManager.openGlobalConfig();
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const followUp = await vscode.window.showErrorMessage(`Failed to configure Cursor MCP: ${message}`, 'Open Config');
            if (followUp === 'Open Config') {
                await cursorConfigManager.openGlobalConfig();
            }
        }
    }), vscode.commands.registerCommand('agentchatbus.openCursorMcpConfig', async () => {
        await cursorConfigManager.openGlobalConfig();
    }), vscode.commands.registerCommand('agentchatbus.copyThreadId', (item) => {
        if (item?.thread?.id) {
            vscode.env.clipboard.writeText(item.thread.id);
            vscode.window.showInformationMessage(`Copied Thread ID: ${item.thread.id}`);
        }
    }), vscode.commands.registerCommand('agentchatbus.deleteThread', async (item) => {
        if (!item?.thread?.id || !apiClient)
            return;
        const confirmed = await vscode.window.showWarningMessage(`Are you sure you want to PERMANENTLY delete thread "${item.thread.topic}"? This cannot be undone.`, { modal: true }, 'Delete');
        if (confirmed === 'Delete') {
            const ok = await apiClient.deleteThread(item.thread.id);
            if (ok) {
                vscode.window.showInformationMessage('Thread deleted.');
                threadsProvider.refresh();
            }
            else {
                vscode.window.showErrorMessage('Failed to delete thread.');
            }
        }
    }), vscode.commands.registerCommand('agentchatbus.archiveThread', async (item) => {
        if (!item?.thread?.id || !apiClient)
            return;
        const ok = await apiClient.archiveThread(item.thread.id);
        if (ok) {
            threadsProvider.refresh();
        }
        else {
            vscode.window.showErrorMessage('Failed to archive thread.');
        }
    }), vscode.commands.registerCommand('agentchatbus.unarchiveThread', async (item) => {
        if (!item?.thread?.id || !apiClient)
            return;
        const ok = await apiClient.unarchiveThread(item.thread.id);
        if (ok) {
            threadsProvider.refresh();
        }
        else {
            vscode.window.showErrorMessage('Failed to unarchive thread.');
        }
    }), vscode.commands.registerCommand('agentchatbus.changeThreadStatus', async (item) => {
        if (!item?.thread?.id || !apiClient)
            return;
        const statuses = ['discuss', 'implement', 'review', 'done', 'closed'];
        const result = await vscode.window.showQuickPick(statuses, {
            placeHolder: `Change status for "${item.thread.topic}" (current: ${item.thread.status})`
        });
        if (result && result !== item.thread.status) {
            const ok = await apiClient.setThreadState(item.thread.id, result);
            if (ok) {
                threadsProvider.refresh();
            }
            else {
                vscode.window.showErrorMessage('Failed to change thread status.');
            }
        }
    }));
    context.subscriptions.push({
        dispose: () => apiClient?.disconnectSSE()
    });
}
async function deactivate() {
    if (serverManagerInstance) {
        await serverManagerInstance.handleIdeDeactivate();
    }
    if (apiClient) {
        apiClient.disconnectSSE();
    }
}
//# sourceMappingURL=extension.js.map