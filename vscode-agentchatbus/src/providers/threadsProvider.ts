import * as vscode from 'vscode';
import type { AgentChatBusApiClient } from '../api/client';
import type { Thread } from '../api/types';

export class ThreadsTreeProvider implements vscode.TreeDataProvider<ThreadItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ThreadItem | undefined | void> = new vscode.EventEmitter<ThreadItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<ThreadItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private apiClient: AgentChatBusApiClient) {
        apiClient.onSseEvent.event((e) => {
            if (e.event_type && e.event_type.startsWith('thread.')) {
                this.refresh();
            } else if (e.event_type === 'msg.posted') {
                 this.refresh();
            }
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ThreadItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ThreadItem): Promise<ThreadItem[]> {
        if (element) {
            return [];
        }

        try {
            let threads = await this.apiClient.getThreads();
            
            // Sort by created_at desc as a proxy for activity
            threads.sort((a,b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

            return threads.map(t => new ThreadItem(t));
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to fetch AgentChatBus threads: ${error.message}`);
            return [];
        }
    }
}

export class ThreadItem extends vscode.TreeItem {
    constructor(
        public readonly thread: Thread
    ) {
        super(thread.topic || 'Untitled Thread', vscode.TreeItemCollapsibleState.None);
        
        let icon = 'comment';
        if (thread.status === 'done' || thread.status === 'closed') icon = 'check';
        if (thread.status === 'archived') icon = 'archive';
        
        this.tooltip = `Status: ${thread.status}`;
        this.description = thread.status;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.command = {
            command: 'agentchatbus.openThread',
            title: 'Open Thread',
            arguments: [thread]
        };
    }
}
