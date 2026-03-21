import * as vscode from 'vscode';
import type { AgentChatBusApiClient } from '../api/client';
import type { Agent } from '../api/types';
import {
    buildAgentItemViewModel,
    filterAndSortAgents,
    shouldRefreshAgentsForEventType,
} from '../logic/agents';

export class AgentsTreeProvider implements vscode.TreeDataProvider<AgentItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<AgentItem | undefined | void> = new vscode.EventEmitter<AgentItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<AgentItem | undefined | void> = this._onDidChangeTreeData.event;

    private showOnlyRecent: boolean = true;

    constructor(private apiClient: AgentChatBusApiClient) {
        apiClient.onSseEvent.event((e) => {
            if (shouldRefreshAgentsForEventType(e.type)) {
                this.refresh();
            }
        });
    }

    toggleRecentFilter(): void {
        this.showOnlyRecent = !this.showOnlyRecent;
        vscode.commands.executeCommand('setContext', 'agentchatbus:agentsFilterActive', this.showOnlyRecent);
        this.refresh();
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
            return filterAndSortAgents(agents, { showOnlyRecent: this.showOnlyRecent }).map(a => new AgentItem(a));
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
        const item = buildAgentItemViewModel(agent);
        super(item.label, vscode.TreeItemCollapsibleState.None);

        this.tooltip = item.tooltip;
        this.description = item.description;
        this.iconPath = new vscode.ThemeIcon(
            item.iconId,
            new vscode.ThemeColor(item.colorId)
        );
        this.contextValue = item.contextValue;
    }
}
