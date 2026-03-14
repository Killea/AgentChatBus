import * as vscode from 'vscode';

export class McpLogProvider implements vscode.TreeDataProvider<LogLineItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<LogLineItem | undefined | void> = new vscode.EventEmitter<LogLineItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<LogLineItem | undefined | void> = this._onDidChangeTreeData.event;

    private logs: string[] = [];
    private maxLogs: number = 500;
    private isManaged: boolean = false;

    setIsManaged(managed: boolean): void {
        this.isManaged = managed;
        this.refresh();
    }

    getLogs(): string[] {
        return this.logs;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    addLog(data: string): void {
        this.setIsManaged(true);
        const lines = data.split(/\r?\n/).filter(line => line.trim().length > 0);
        for (const line of lines) {
            this.logs.push(line);
            if (this.logs.length > this.maxLogs) {
                this.logs.shift();
            }
        }
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
        
        if (!this.isManaged && this.logs.length === 0) {
            return [new LogLineItem("Ready (Managed Externally)", -1)];
        }
        
        if (this.logs.length === 0) {
            return [new LogLineItem("Waiting for logs...", -2)];
        }
        
        return this.logs.map((log, index) => new LogLineItem(log, index));
    }
}

class LogLineItem extends vscode.TreeItem {
    constructor(
        public readonly message: string,
        public readonly index: number
    ) {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.tooltip = message;
        
        if (index === -1) {
            this.description = "Extension cannot capture logs for external processes.";
            this.iconPath = new vscode.ThemeIcon('info', new vscode.ThemeColor('descriptionForeground'));
            return;
        }

        if (index === -2) {
            this.iconPath = new vscode.ThemeIcon('sync~spin');
            return;
        }

        if (message.includes('ERROR') || message.includes('Exception') || message.includes('failed')) {
            this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        } else if (message.includes('WARNING')) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        } else if (message.includes('Exec:') || message.includes('Starting')) {
            this.iconPath = new vscode.ThemeIcon('terminal');
        }
    }
}
