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
exports.McpLogProvider = void 0;
const vscode = __importStar(require("vscode"));
class McpLogProvider {
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    logs = [];
    maxLogs = 500;
    isManaged = false;
    setIsManaged(managed) {
        this.isManaged = managed;
        this.refresh();
    }
    getLogs() {
        return this.logs;
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    addLog(data) {
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
    clear() {
        this.logs = [];
        this.refresh();
    }
    dispose() {
        this.clear();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (element)
            return [];
        if (!this.isManaged && this.logs.length === 0) {
            return [new LogLineItem("Ready (Managed Externally)", -1)];
        }
        if (this.logs.length === 0) {
            return [new LogLineItem("Waiting for logs...", -2)];
        }
        return this.logs.map((log, index) => new LogLineItem(log, index));
    }
}
exports.McpLogProvider = McpLogProvider;
class LogLineItem extends vscode.TreeItem {
    message;
    index;
    constructor(message, index) {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.message = message;
        this.index = index;
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
        }
        else if (message.includes('WARNING')) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        }
        else if (message.includes('Exec:') || message.includes('Starting')) {
            this.iconPath = new vscode.ThemeIcon('terminal');
        }
    }
}
//# sourceMappingURL=mcpLogProvider.js.map