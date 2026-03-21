import * as vscode from 'vscode';
import {
    appendSetupLogStep,
    createInitialSetupSteps,
    formatSetupStepLabel,
    replaceSetupSteps,
    type SetupStepDefinition,
} from '../logic/setup';

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
        this.steps = createInitialSetupSteps().map(step => new SetupStep(step));
        this.refresh();
    }

    addLog(message: string, icon?: string, description?: string) {
        console.log(`[SetupProvider] Log: ${message}`);
        this.steps = appendSetupLogStep(
            this.steps.map(step => step.toDefinition()),
            message,
            icon,
            description
        ).map(step => new SetupStep(step));
        this.refresh();
    }

    setSteps(stepLabels: { label: string, icon?: string, description?: string }[]) {
        this.steps = replaceSetupSteps(stepLabels).map(step => new SetupStep(step));
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
        public readonly step: SetupStepDefinition
    ) {
        super(step.label, vscode.TreeItemCollapsibleState.None);
        this.description = step.description;
        if (step.icon) {
            this.iconPath = new vscode.ThemeIcon(step.icon);
        }
    }

    updateLabel(startTime: number) {
        this.label = formatSetupStepLabel(this.step.label, startTime);
    }

    toDefinition(): SetupStepDefinition {
        return {
            label: this.step.label,
            icon: this.step.icon,
            description: this.step.description,
        };
    }
}
