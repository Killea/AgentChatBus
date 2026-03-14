import * as vscode from 'vscode';

export class SettingsProvider implements vscode.TreeDataProvider<SettingItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SettingItem | undefined | void> = new vscode.EventEmitter<SettingItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<SettingItem | undefined | void> = this._onDidChangeTreeData.event;

    getTreeItem(element: SettingItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SettingItem): vscode.ProviderResult<SettingItem[]> {
        if (element) return [];

        return [
            new SettingItem(
                "Open Web Console", 
                "Open the AgentChatBus dashboard in your browser", 
                "browser", 
                "agentchatbus.openWebConsole"
            ),
            new SettingItem(
                "Server Settings", 
                "Configure AgentChatBus server parameters", 
                "settings-gear", 
                "agentchatbus.serverSettings"
            )
        ];
    }
}

class SettingItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly tooltip: string,
        public readonly icon: string,
        public readonly commandId: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = tooltip;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.command = {
            title: label,
            command: commandId
        };
        this.contextValue = 'setting';
    }
}
