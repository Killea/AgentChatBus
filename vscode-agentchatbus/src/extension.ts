import * as vscode from 'vscode';
import { AgentChatBusApiClient } from './api/client';
import { ThreadsTreeProvider, ThreadItem } from './providers/threadsProvider';
import { AgentsTreeProvider } from './providers/agentsProvider';
import { ChatPanel } from './views/chatPanel';
import type { Thread } from './api/types';
import { BusServerManager } from './busServerManager';
import { SetupProvider } from './providers/setupProvider';
import { McpLogProvider } from './providers/mcpLogProvider';
import { SettingsProvider } from './providers/settingsProvider';
import { StatusPanel } from './views/statusPanel';

let apiClient: AgentChatBusApiClient | undefined;
let mcpLogProvider: McpLogProvider | undefined;
let settingsProvider: SettingsProvider | undefined;
let mainViewsInitialized = false;

export function activate(context: vscode.ExtensionContext) {
    console.log('[AgentChatBus] Activating extension...');

    ChatPanel.setExtensionPath(context.extensionPath);

    const serverManager = new BusServerManager();
    const setupProvider = new SetupProvider();
    mcpLogProvider = new McpLogProvider();
    
    serverManager.setSetupProvider(setupProvider);
    serverManager.setMcpLogProvider(mcpLogProvider);
    
    context.subscriptions.push(serverManager);
    context.subscriptions.push(setupProvider);
    context.subscriptions.push(mcpLogProvider);
    
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('agentchatbus.setup', setupProvider),
        vscode.window.registerTreeDataProvider('agentchatbus.mcpLogs', mcpLogProvider)
    );

    // Set initial context for agent filter
    vscode.commands.executeCommand('setContext', 'agentchatbus:agentsFilterActive', true);

    const runSetup = async () => {
        try {
            console.log('[AgentChatBus] Starting setup process...');
            const isReady = await serverManager.ensureServerRunning();
            if (isReady) {
                console.log('[AgentChatBus] Server is ready, initializing main views.');
                initializeMainViews(context, serverManager);
            } else {
                console.warn('[AgentChatBus] Server failed to start.');
            }
        } catch (error) {
            console.error('[AgentChatBus] Fatal error during setup:', error);
            serverManager.log(`Fatal error: ${error}`, 'error');
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('agentchatbus.retrySetup', () => {
            console.log('[AgentChatBus] Retry command triggered.');
            setupProvider.reset();
            runSetup();
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('agentchatbus.serverUrl') &&
                !event.affectsConfiguration('agentchatbus.pythonPath') &&
                !event.affectsConfiguration('agentchatbus.autoStartBusServer')) {
                return;
            }

            serverManager.notifyMcpDefinitionsChanged();
        })
    );

    // Register MCP provider (asynchronous definition provision)
    serverManager.registerMcpProvider(context);

    // Start setup asynchronously to avoid blocking the activate() call
    Promise.resolve().then(() => {
        setTimeout(() => {
            runSetup();
        }, 500);
    });
}

function initializeMainViews(context: vscode.ExtensionContext, serverManager: BusServerManager) {
    if (mainViewsInitialized) return;
    mainViewsInitialized = true;

    console.log('[AgentChatBus] Initializing main views...');
    apiClient = new AgentChatBusApiClient();
    apiClient.connectSSE();

    const threadsProvider = new ThreadsTreeProvider(apiClient);
    const agentsProvider = new AgentsTreeProvider(apiClient);
    settingsProvider = new SettingsProvider();

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('agentchatbus.threads', threadsProvider),
        vscode.window.registerTreeDataProvider('agentchatbus.agents', agentsProvider),
        vscode.window.registerTreeDataProvider('agentchatbus.settings', settingsProvider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('agentchatbus.refreshThreads', () => threadsProvider.refresh()),
        vscode.commands.registerCommand('agentchatbus.refreshAgents', () => agentsProvider.refresh()),
        vscode.commands.registerCommand('agentchatbus.toggleAgentFilter', () => agentsProvider.toggleRecentFilter()),
        vscode.commands.registerCommand('agentchatbus.clearMcpLogs', () => {
            mcpLogProvider?.clear();
        }),
        vscode.commands.registerCommand('agentchatbus.restartServer', async () => {
            const confirmed = await vscode.window.showWarningMessage(
                'Restart AgentChatBus Server? This will disconnect all active agents and reset the message bus state.',
                { modal: true },
                'Restart'
            );
            if (confirmed === 'Restart') {
                serverManager.restartServer();
            }
        }),
        vscode.commands.registerCommand('agentchatbus.openFullLog', () => {
            const logs = mcpLogProvider?.getLogs() || [];
            const panel = vscode.window.createWebviewPanel(
                'agentchatbusLogs',
                'AgentChatBus Full Logs',
                vscode.ViewColumn.One,
                {}
            );
            panel.webview.html = `<html><body><pre style="padding: 10px; font-family: monospace;">${logs.join('\n')}</pre></body></html>`;
        }),
        vscode.commands.registerCommand('agentchatbus.openWebConsole', () => {
            const config = vscode.workspace.getConfiguration('agentchatbus');
            const url = config.get<string>('serverUrl', 'http://127.0.0.1:39765');
            vscode.env.openExternal(vscode.Uri.parse(url));
        }),
        vscode.commands.registerCommand('agentchatbus.serverSettings', () => {
            vscode.window.showInformationMessage('Server settings are currently managed via VS Code Configuration.', { modal: true }, 'Open Settings').then(selection => {
                if (selection === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'agentchatbus');
                }
            });
        }),
        vscode.commands.registerCommand('agentchatbus.filterThreads', async () => {
            const statuses = ['discuss', 'implement', 'review', 'done', 'closed', 'archived'];
            const currentFilter = threadsProvider.getStatusFilter();
            
            const items: (vscode.QuickPickItem & { status: string })[] = statuses.map(s => ({
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
        }),
        vscode.commands.registerCommand('agentchatbus.openThread', (thread: Thread) => {
            if (thread && apiClient) {
                ChatPanel.createOrShow(thread, apiClient);
            }
        }),
        vscode.commands.registerCommand('agentchatbus.showStatus', () => {
            const metadata = serverManager.getStatusMetadata();
            StatusPanel.createOrShow(metadata);
        }),
        vscode.commands.registerCommand('agentchatbus.copyThreadId', (item: ThreadItem) => {
            if (item?.thread?.id) {
                vscode.env.clipboard.writeText(item.thread.id);
                vscode.window.showInformationMessage(`Copied Thread ID: ${item.thread.id}`);
            }
        }),
        vscode.commands.registerCommand('agentchatbus.deleteThread', async (item: ThreadItem) => {
            if (!item?.thread?.id || !apiClient) return;
            const confirmed = await vscode.window.showWarningMessage(
                `Are you sure you want to PERMANENTLY delete thread "${item.thread.topic}"? This cannot be undone.`,
                { modal: true },
                'Delete'
            );
            if (confirmed === 'Delete') {
                const ok = await apiClient.deleteThread(item.thread.id);
                if (ok) {
                    vscode.window.showInformationMessage('Thread deleted.');
                    threadsProvider.refresh();
                } else {
                    vscode.window.showErrorMessage('Failed to delete thread.');
                }
            }
        }),
        vscode.commands.registerCommand('agentchatbus.archiveThread', async (item: ThreadItem) => {
            if (!item?.thread?.id || !apiClient) return;
            const ok = await apiClient.archiveThread(item.thread.id);
            if (ok) {
                threadsProvider.refresh();
            } else {
                vscode.window.showErrorMessage('Failed to archive thread.');
            }
        }),
        vscode.commands.registerCommand('agentchatbus.unarchiveThread', async (item: ThreadItem) => {
            if (!item?.thread?.id || !apiClient) return;
            const ok = await apiClient.unarchiveThread(item.thread.id);
            if (ok) {
                threadsProvider.refresh();
            } else {
                vscode.window.showErrorMessage('Failed to unarchive thread.');
            }
        }),
        vscode.commands.registerCommand('agentchatbus.changeThreadStatus', async (item: ThreadItem) => {
            if (!item?.thread?.id || !apiClient) return;
            const statuses = ['discuss', 'implement', 'review', 'done', 'closed'];
            const result = await vscode.window.showQuickPick(statuses, {
                placeHolder: `Change status for "${item.thread.topic}" (current: ${item.thread.status})`
            });
            if (result && result !== item.thread.status) {
                const ok = await apiClient.setThreadState(item.thread.id, result);
                if (ok) {
                    threadsProvider.refresh();
                } else {
                    vscode.window.showErrorMessage('Failed to change thread status.');
                }
            }
        })
    );

    context.subscriptions.push({
        dispose: () => apiClient?.disconnectSSE()
    });
}

export function deactivate() {
    if (apiClient) {
        apiClient.disconnectSSE();
    }
}
