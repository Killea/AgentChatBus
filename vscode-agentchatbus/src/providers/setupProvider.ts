import * as vscode from 'vscode';

export class SetupProvider implements vscode.TreeDataProvider<SetupStep> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SetupStep | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private steps: SetupStep[] = [];

    constructor() {
        this.reset();
    }

    reset() {
        this.steps = [
            new SetupStep('Status: Initializing...', vscode.TreeItemCollapsibleState.None, 'sync~spin')
        ];
        this.refresh();
    }

    setSteps(stepLabels: { label: string, icon?: string, description?: string }[]) {
        this.steps = stepLabels.map(s => {
            const step = new SetupStep(s.label, vscode.TreeItemCollapsibleState.None, s.icon);
            step.description = s.description;
            return step;
        });
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SetupStep): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SetupStep): vscode.ProviderResult<SetupStep[]> {
        return this.steps;
    }
}

class SetupStep extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly icon?: string
    ) {
        super(label, collapsibleState);
        if (icon) {
            this.iconPath = new vscode.ThemeIcon(icon);
        }
    }
}
