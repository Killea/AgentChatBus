import * as vscode from 'vscode';
import type { AgentChatBusApiClient } from '../api/client';
import type { Agent } from '../api/types';

export class AgentsTreeProvider implements vscode.TreeDataProvider<AgentItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<AgentItem | undefined | void> = new vscode.EventEmitter<AgentItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<AgentItem | undefined | void> = this._onDidChangeTreeData.event;

    private showOnlyRecent: boolean = true;

    constructor(private apiClient: AgentChatBusApiClient) {
        apiClient.onSseEvent.event((e) => {
            if (e.type && (e.type.startsWith('agent.') || e.type === 'msg.new')) {
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
            let agents = await this.apiClient.getAgents();
            
            if (this.showOnlyRecent) {
                const oneHourAgo = Date.now() - 60 * 60 * 1000;
                agents = agents.filter(a => {
                    const activityTime = a.last_activity_time ? new Date(a.last_activity_time).getTime() : 
                                       a.last_heartbeat ? new Date(a.last_heartbeat).getTime() : 0;
                    return activityTime > oneHourAgo || a.is_online;
                });
            }

            // Sort by online status first, then by last activity time
            agents.sort((a, b) => {
                if (a.is_online !== b.is_online) return a.is_online ? -1 : 1;
                const timeA = a.last_activity_time ? new Date(a.last_activity_time).getTime() : new Date(a.last_heartbeat).getTime();
                const timeB = b.last_activity_time ? new Date(b.last_activity_time).getTime() : new Date(b.last_heartbeat).getTime();
                return timeB - timeA;
            });

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
        
        const lastSeen = agent.last_activity_time || agent.last_heartbeat;
        const relativeTime = lastSeen ? getRelativeTimeString(new Date(lastSeen)) : 'Never';
        
        this.tooltip = `IDE: ${agent.ide || 'N/A'}\nModel: ${agent.model || 'N/A'}\nLast Seen: ${relativeTime}\nActivity: ${agent.last_activity || 'None'}`;
        this.description = agent.is_online ? 'Online' : `Last seen ${relativeTime}`;
        this.iconPath = new vscode.ThemeIcon(
            agent.is_online ? 'circle-filled' : 'circle-outline', 
            agent.is_online ? new vscode.ThemeColor('testing.iconPassed') : new vscode.ThemeColor('testing.iconUntested')
        );
        this.contextValue = 'agent';
    }
}

function getRelativeTimeString(date: Date): string {
    const delta = Math.round((Date.now() - date.getTime()) / 1000);
    if (delta < 60) return 'just now';
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
}
