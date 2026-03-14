"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SetupProvider = void 0;
const vscode = __importStar(require("vscode"));
class SetupProvider {
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    steps = [];
    startTime = 0;
    timer;
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
    addLog(message, icon, description) {
        console.log(`[SetupProvider] Log: ${message}`);
        const step = new SetupStep(message, vscode.TreeItemCollapsibleState.None, icon);
        step.description = description;
        this.steps.push(step);
        this.refresh();
    }
    setSteps(stepLabels) {
        this.steps = stepLabels.map(s => {
            const step = new SetupStep(s.label, vscode.TreeItemCollapsibleState.None, s.icon);
            step.description = s.description;
            return step;
        });
        this.refresh();
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        element.updateLabel(this.startTime);
        return element;
    }
    getChildren(element) {
        return [...this.steps];
    }
    dispose() {
        if (this.timer) {
            clearInterval(this.timer);
        }
    }
}
exports.SetupProvider = SetupProvider;
class SetupStep extends vscode.TreeItem {
    originalLabel;
    collapsibleState;
    icon;
    constructor(originalLabel, collapsibleState, icon) {
        super(originalLabel, collapsibleState);
        this.originalLabel = originalLabel;
        this.collapsibleState = collapsibleState;
        this.icon = icon;
        if (icon) {
            this.iconPath = new vscode.ThemeIcon(icon);
        }
    }
    updateLabel(startTime) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        this.label = `[${elapsed}s] ${this.originalLabel}`;
    }
}
//# sourceMappingURL=setupProvider.js.map