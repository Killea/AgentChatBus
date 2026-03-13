import * as vscode from 'vscode';
import { AgentChatBusApiClient } from './api/client';
import { ThreadsTreeProvider } from './providers/threadsProvider';
import { AgentsTreeProvider } from './providers/agentsProvider';
import { ChatPanel } from './views/chatPanel';
import type { Thread } from './api/types';

export function activate(context: vscode.ExtensionContext) {
    console.log('AgentChatBus extension is now active!');

    const apiClient = new AgentChatBusApiClient();
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
        vscode.commands.registerCommand('agentchatbus.openThread', (thread: Thread) => {
            if (thread) {
                ChatPanel.createOrShow(thread, apiClient);
            }
        })
    );

    context.subscriptions.push({
        dispose: () => apiClient.disconnectSSE()
    });
}

export function deactivate() {}
