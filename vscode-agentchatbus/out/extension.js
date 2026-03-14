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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const client_1 = require("./api/client");
const threadsProvider_1 = require("./providers/threadsProvider");
const agentsProvider_1 = require("./providers/agentsProvider");
const chatPanel_1 = require("./views/chatPanel");
const busServerManager_1 = require("./busServerManager");
const setupProvider_1 = require("./providers/setupProvider");
let apiClient;
let mainViewsInitialized = false;
async function activate(context) {
    console.log('AgentChatBus extension is now active!');
    const serverManager = new busServerManager_1.BusServerManager();
    const setupProvider = new setupProvider_1.SetupProvider();
    serverManager.setSetupProvider(setupProvider);
    context.subscriptions.push(serverManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('agentchatbus.setup', setupProvider));
    // Initial check/start
    const runSetup = async () => {
        const isReady = await serverManager.ensureServerRunning();
        if (isReady) {
            initializeMainViews(context);
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('agentchatbus.retrySetup', () => {
        setupProvider.reset();
        runSetup();
    }));
    // Register MCP provider (if supported)
    serverManager.registerMcpProvider(context);
    runSetup();
}
function initializeMainViews(context) {
    if (mainViewsInitialized)
        return;
    mainViewsInitialized = true;
    apiClient = new client_1.AgentChatBusApiClient();
    apiClient.connectSSE();
    const threadsProvider = new threadsProvider_1.ThreadsTreeProvider(apiClient);
    const agentsProvider = new agentsProvider_1.AgentsTreeProvider(apiClient);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('agentchatbus.threads', threadsProvider), vscode.window.registerTreeDataProvider('agentchatbus.agents', agentsProvider));
    context.subscriptions.push(vscode.commands.registerCommand('agentchatbus.refreshThreads', () => threadsProvider.refresh()), vscode.commands.registerCommand('agentchatbus.refreshAgents', () => agentsProvider.refresh()), vscode.commands.registerCommand('agentchatbus.filterThreads', async () => {
        const statuses = ['discuss', 'implement', 'review', 'done', 'closed', 'archived'];
        const currentFilter = threadsProvider.getStatusFilter();
        const items = statuses.map(s => ({
            label: s.charAt(0).toUpperCase() + s.slice(1),
            status: s,
            picked: currentFilter.includes(s),
            description: s === 'archived' ? '(archived threads are hidden by default)' : undefined
        }));
        const result = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: 'Select thread statuses to display',
            ignoreFocusOut: true
        });
        if (result) {
            const selectedStatuses = result.map(i => i.status);
            threadsProvider.setStatusFilter(selectedStatuses);
        }
    }), vscode.commands.registerCommand('agentchatbus.openThread', (thread) => {
        if (thread && apiClient) {
            chatPanel_1.ChatPanel.createOrShow(thread, apiClient);
        }
    }));
    context.subscriptions.push({
        dispose: () => apiClient?.disconnectSSE()
    });
}
function deactivate() {
    if (apiClient) {
        apiClient.disconnectSSE();
    }
}
//# sourceMappingURL=extension.js.map