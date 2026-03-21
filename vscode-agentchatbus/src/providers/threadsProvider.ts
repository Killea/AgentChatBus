import * as vscode from 'vscode';
import type { AgentChatBusApiClient } from '../api/client';
import type { Thread } from '../api/types';
import { getTreeIcon } from '../ui/treeIcons';
import {
    buildThreadItemViewModel,
    filterAndSortThreads,
    shouldIncludeArchivedThreadStatus,
    shouldRefreshThreadsForEventType,
} from '../logic/threads';

export class ThreadsTreeProvider implements vscode.TreeDataProvider<ThreadItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ThreadItem | undefined | void> = new vscode.EventEmitter<ThreadItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<ThreadItem | undefined | void> = this._onDidChangeTreeData.event;
    private _statusFilter: Set<string> = new Set(['discuss', 'implement', 'review', 'done', 'closed']);

    constructor(private apiClient: AgentChatBusApiClient) {
        apiClient.onSseEvent.event((e) => {
            if (shouldRefreshThreadsForEventType(e.type)) {
                this.refresh();
            }
        });
    }

    setStatusFilter(statuses: string[]) {
        this._statusFilter = new Set(statuses);
        this.refresh();
    }

    getStatusFilter(): string[] {
        return Array.from(this._statusFilter);
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
            const includeArchived = shouldIncludeArchivedThreadStatus(this._statusFilter);
            const threads = filterAndSortThreads(await this.apiClient.getThreads(includeArchived), this._statusFilter);
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
        const item = buildThreadItemViewModel(thread);
        super(item.label, vscode.TreeItemCollapsibleState.None);

        this.tooltip = item.tooltip;
        this.description = item.description;
        this.iconPath = getTreeIcon(item.iconFile);
        this.contextValue = item.contextValue;
        this.command = {
            command: item.commandId,
            title: 'Open Thread',
            arguments: item.commandArguments
        };
    }
}
