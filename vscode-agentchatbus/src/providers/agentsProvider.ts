import * as vscode from 'vscode';
import type { AgentChatBusApiClient } from '../api/client';
import type { Agent } from '../api/types';

export class AgentsTreeProvider implements vscode.TreeDataProvider<AgentItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<AgentItem | undefined | void> = new vscode.EventEmitter<AgentItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<AgentItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private apiClient: AgentChatBusApiClient) {
        apiClient.onSseEvent.event((e) => {
            if (e.event_type && e.event_type.startsWith('agent.')) {
                this.refresh();
            }
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: AgentItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: AgentItem): Promise<AgentItem[]> {
        if (element) return [];

        try {
            const agents = await this.apiClient.getAgents();
            return agents.map(a => new AgentItem(a));
        } catch (error: any) {
            console.error('Failed to fetch agents:', error);
            return [];
        }
    }
}

export class AgentItem extends vscode.TreeItem {
    constructor(
        public readonly agent: Agent
    ) {
        const displayName = agent.display_name || agent.name || agent.id;
        super(displayName, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `IDE: ${agent.ide || 'N/A'}\nModel: ${agent.model || 'N/A'}`;
        this.description = agent.is_online ? 'Online' : 'Offline';
        this.iconPath = new vscode.ThemeIcon(agent.is_online ? 'circle-filled' : 'circle-outline', agent.is_online ? new vscode.ThemeColor('testing.iconPassed') : new vscode.ThemeColor('testing.iconUntested'));
    }
}
