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
    showOnlyRecent = true;
    constructor(apiClient) {
        this.apiClient = apiClient;
        apiClient.onSseEvent.event((e) => {
            if (e.type && (e.type.startsWith('agent.') || e.type === 'msg.new')) {
                this.refresh();
            }
        });
    }
    toggleRecentFilter() {
        this.showOnlyRecent = !this.showOnlyRecent;
        vscode.commands.executeCommand('setContext', 'agentchatbus:agentsFilterActive', this.showOnlyRecent);
        this.refresh();
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
            let agents = await this.apiClient.getAgents();
            if (this.showOnlyRecent) {
                const oneHourAgo = Date.now() - 60 * 60 * 1000;
                agents = agents.filter(a => {
                    const activityTime = a.last_activity_time ? new Date(a.last_activity_time).getTime() :
                        a.last_heartbeat ? new Date(a.last_heartbeat).getTime() : 0;
                    return activityTime > oneHourAgo || a.is_online;
                });
            }
            // Sort by online status first, then by last activity time
            agents.sort((a, b) => {
                if (a.is_online !== b.is_online)
                    return a.is_online ? -1 : 1;
                const timeA = a.last_activity_time ? new Date(a.last_activity_time).getTime() : new Date(a.last_heartbeat).getTime();
                const timeB = b.last_activity_time ? new Date(b.last_activity_time).getTime() : new Date(b.last_heartbeat).getTime();
                return timeB - timeA;
            });
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
        const lastSeen = agent.last_activity_time || agent.last_heartbeat;
        const relativeTime = lastSeen ? getRelativeTimeString(new Date(lastSeen)) : 'Never';
        this.tooltip = `IDE: ${agent.ide || 'N/A'}\nModel: ${agent.model || 'N/A'}\nLast Seen: ${relativeTime}\nActivity: ${agent.last_activity || 'None'}`;
        this.description = agent.is_online ? 'Online' : `Last seen ${relativeTime}`;
        this.iconPath = new vscode.ThemeIcon(agent.is_online ? 'circle-filled' : 'circle-outline', agent.is_online ? new vscode.ThemeColor('testing.iconPassed') : new vscode.ThemeColor('testing.iconUntested'));
        this.contextValue = 'agent';
    }
}
exports.AgentItem = AgentItem;
function getRelativeTimeString(date) {
    const delta = Math.round((Date.now() - date.getTime()) / 1000);
    if (delta < 60)
        return 'just now';
    if (delta < 3600)
        return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400)
        return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
}
//# sourceMappingURL=agentsProvider.js.map