import * as vscode from 'vscode';

export class SetupProvider implements vscode.TreeDataProvider<SetupStep> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SetupStep | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private steps: SetupStep[] = [];
    private startTime: number = 0;
    private timer: NodeJS.Timeout | undefined;

    constructor() {
        this.reset();
        // Force refresh every 500ms to update the elapsed time shown in labels
        this.timer = setInterval(() => this.refresh(), 500);
    }

    reset() {
        this.startTime = Date.now();
        this.steps = [
            new SetupStep('Starting AgentChatBus...', vscode.TreeItemCollapsibleState.None, 'play')
        ];
        this.refresh();
    }

    addLog(message: string, icon?: string, description?: string) {
        console.log(`[SetupProvider] Log: ${message}`);
        const step = new SetupStep(message, vscode.TreeItemCollapsibleState.None, icon);
        step.description = description;
        this.steps.push(step);
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
        element.updateLabel(this.startTime);
        return element;
    }

    getChildren(element?: SetupStep): vscode.ProviderResult<SetupStep[]> {
        return [...this.steps];
    }

    dispose() {
        if (this.timer) {
            clearInterval(this.timer);
        }
    }
}

class SetupStep extends vscode.TreeItem {
    constructor(
        public readonly originalLabel: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly icon?: string
    ) {
        super(originalLabel, collapsibleState);
        if (icon) {
            this.iconPath = new vscode.ThemeIcon(icon);
        }
    }

    updateLabel(startTime: number) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        this.label = `[${elapsed}s] ${this.originalLabel}`;
    }
}
