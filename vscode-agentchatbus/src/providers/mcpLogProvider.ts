import * as vscode from 'vscode';
import { appendLogLines, getMcpLogPresentation, getMcpLogRows } from '../logic/mcpLogs';

export class McpLogProvider implements vscode.TreeDataProvider<LogLineItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<LogLineItem | undefined | void> = new vscode.EventEmitter<LogLineItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<LogLineItem | undefined | void> = this._onDidChangeTreeData.event;

    private logs: string[] = [];
    private maxLogs: number = 500;
    private isManaged: boolean = false;
    private statusMessage: string | null = null;

    setIsManaged(managed: boolean): void {
        this.isManaged = managed;
        if (managed) {
            this.statusMessage = null;
        }
        this.refresh();
    }

    setStatusMessage(message: string | null): void {
        this.statusMessage = message;
        this.refresh();
    }

    getLogs(): string[] {
        return this.logs;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    addLog(data: string): void {
        this.logs = appendLogLines(this.logs, data, this.maxLogs);
        this.refresh();
    }

    clear(): void {
        this.logs = [];
        this.refresh();
    }

    dispose(): void {
        this.clear();
    }

    getTreeItem(element: LogLineItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: LogLineItem): vscode.ProviderResult<LogLineItem[]> {
        if (element) return [];

        return getMcpLogRows(this.logs, this.isManaged, this.statusMessage).map(
            row => new LogLineItem(row.message, row.index, row.description, row.iconId, row.colorId)
        );
    }
}

class LogLineItem extends vscode.TreeItem {
    constructor(
        public readonly message: string,
        public readonly index: number,
        description?: string,
        iconId?: string,
        colorId?: string
    ) {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.tooltip = message;

        const presentation = getMcpLogPresentation(message, index);
        this.description = description ?? presentation.description;
        const effectiveIconId = iconId ?? presentation.iconId;
        const effectiveColorId = colorId ?? presentation.colorId;
        if (effectiveIconId) {
            this.iconPath = effectiveColorId
                ? new vscode.ThemeIcon(effectiveIconId, new vscode.ThemeColor(effectiveColorId))
                : new vscode.ThemeIcon(effectiveIconId);
        }
    }
}
