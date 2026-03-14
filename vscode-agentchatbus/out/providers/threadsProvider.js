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
exports.ThreadItem = exports.ThreadsTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
class ThreadsTreeProvider {
    apiClient;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    _statusFilter = new Set(['discuss', 'implement', 'review', 'done', 'closed']);
    constructor(apiClient) {
        this.apiClient = apiClient;
        apiClient.onSseEvent.event((e) => {
            if (e.type && (e.type.startsWith('thread.') || e.type === 'msg.new')) {
                this.refresh();
            }
        });
    }
    setStatusFilter(statuses) {
        this._statusFilter = new Set(statuses);
        this.refresh();
    }
    getStatusFilter() {
        return Array.from(this._statusFilter);
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        if (element) {
            return [];
        }
        try {
            const includeArchived = this._statusFilter.has('archived');
            let threads = await this.apiClient.getThreads(includeArchived);
            // Filter by status
            threads = threads.filter(t => this._statusFilter.has(t.status));
            // Sort by created_at desc as a proxy for activity
            threads.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
            return threads.map(t => new ThreadItem(t));
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to fetch AgentChatBus threads: ${error.message}`);
            return [];
        }
    }
}
exports.ThreadsTreeProvider = ThreadsTreeProvider;
class ThreadItem extends vscode.TreeItem {
    thread;
    constructor(thread) {
        super(thread.topic || 'Untitled Thread', vscode.TreeItemCollapsibleState.None);
        this.thread = thread;
        let icon = 'comment';
        if (thread.status === 'done' || thread.status === 'closed')
            icon = 'check';
        if (thread.status === 'archived')
            icon = 'archive';
        this.tooltip = `Status: ${thread.status}`;
        this.description = thread.status;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.command = {
            command: 'agentchatbus.openThread',
            title: 'Open Thread',
            arguments: [thread]
        };
    }
}
exports.ThreadItem = ThreadItem;
//# sourceMappingURL=threadsProvider.js.map