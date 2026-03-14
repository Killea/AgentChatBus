import * as vscode from 'vscode';
import { AgentChatBusApiClient } from './api/client';
import { ThreadsTreeProvider } from './providers/threadsProvider';
import { AgentsTreeProvider } from './providers/agentsProvider';
import { ChatPanel } from './views/chatPanel';
import type { Thread } from './api/types';
import { BusServerManager } from './busServerManager';
import { SetupProvider } from './providers/setupProvider';
import { McpLogProvider } from './providers/mcpLogProvider';

let apiClient: AgentChatBusApiClient | undefined;
let mcpLogProvider: McpLogProvider | undefined;
let mainViewsInitialized = false;

export function activate(context: vscode.ExtensionContext) {
    console.log('[AgentChatBus] Activating extension...');

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

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('agentchatbus.threads', threadsProvider),
        vscode.window.registerTreeDataProvider('agentchatbus.agents', agentsProvider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('agentchatbus.refreshThreads', () => threadsProvider.refresh()),
        vscode.commands.registerCommand('agentchatbus.refreshAgents', () => agentsProvider.refresh()),
        vscode.commands.registerCommand('agentchatbus.toggleAgentFilter', () => agentsProvider.toggleRecentFilter()),
        vscode.commands.registerCommand('agentchatbus.clearMcpLogs', () => {
            mcpLogProvider?.clear();
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
