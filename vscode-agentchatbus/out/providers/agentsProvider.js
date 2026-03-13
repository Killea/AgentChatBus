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
exports.AgentItem = exports.AgentsTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
class AgentsTreeProvider {
    apiClient;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    constructor(apiClient) {
        this.apiClient = apiClient;
        apiClient.onSseEvent.event((e) => {
            if (e.event_type && e.event_type.startsWith('agent.')) {
                this.refresh();
            }
        });
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        if (element)
            return [];
        try {
            const agents = await this.apiClient.getAgents();
            return agents.map(a => new AgentItem(a));
        }
        catch (error) {
            console.error('Failed to fetch agents:', error);
            return [];
        }
    }
}
exports.AgentsTreeProvider = AgentsTreeProvider;
class AgentItem extends vscode.TreeItem {
    agent;
    constructor(agent) {
        const displayName = agent.display_name || agent.name || agent.id;
        super(displayName, vscode.TreeItemCollapsibleState.None);
        this.agent = agent;
        this.tooltip = `IDE: ${agent.ide || 'N/A'}\nModel: ${agent.model || 'N/A'}`;
        this.description = agent.is_online ? 'Online' : 'Offline';
        this.iconPath = new vscode.ThemeIcon(agent.is_online ? 'circle-filled' : 'circle-outline', agent.is_online ? new vscode.ThemeColor('testing.iconPassed') : new vscode.ThemeColor('testing.iconUntested'));
    }
}
exports.AgentItem = AgentItem;
//# sourceMappingURL=agentsProvider.js.map