import * as vscode from 'vscode';
import { AgentChatBusApiClient } from './api/client';
import { ThreadsTreeProvider } from './providers/threadsProvider';
import { AgentsTreeProvider } from './providers/agentsProvider';
import { ChatPanel } from './views/chatPanel';
import type { Thread } from './api/types';
import { BusServerManager } from './busServerManager';
import { SetupProvider } from './providers/setupProvider';

let apiClient: AgentChatBusApiClient | undefined;
let mainViewsInitialized = false;

export async function activate(context: vscode.ExtensionContext) {
    console.log('AgentChatBus extension is now active!');

    const serverManager = new BusServerManager();
    const setupProvider = new SetupProvider();
    serverManager.setSetupProvider(setupProvider);
    
    context.subscriptions.push(serverManager);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('agentchatbus.setup', setupProvider)
    );

    // Initial check/start
    const runSetup = async () => {
        const isReady = await serverManager.ensureServerRunning();
        if (isReady) {
            initializeMainViews(context);
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('agentchatbus.retrySetup', () => {
            setupProvider.reset();
            runSetup();
        })
    );

    // Register MCP provider (if supported)
    serverManager.registerMcpProvider(context);

    runSetup();
}

function initializeMainViews(context: vscode.ExtensionContext) {
    if (mainViewsInitialized) return;
    mainViewsInitialized = true;

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
