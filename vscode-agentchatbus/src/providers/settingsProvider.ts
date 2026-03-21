import * as vscode from 'vscode';
import { getTreeIcon } from '../ui/treeIcons';
import { getSettingsDefinitions } from '../logic/settings';

export class SettingsProvider implements vscode.TreeDataProvider<SettingItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SettingItem | undefined | void> = new vscode.EventEmitter<SettingItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<SettingItem | undefined | void> = this._onDidChangeTreeData.event;

    getTreeItem(element: SettingItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SettingItem): vscode.ProviderResult<SettingItem[]> {
        if (element) return [];

        return getSettingsDefinitions().map(
            item => new SettingItem(item.label, item.tooltip, item.iconFile, item.commandId)
        );
    }
}

class SettingItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly tooltip: string,
        public readonly iconFile: string,
        public readonly commandId: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = tooltip;
        this.iconPath = getTreeIcon(iconFile);
        this.command = {
            title: label,
            command: commandId
        };
        this.contextValue = 'setting';
    }
}
