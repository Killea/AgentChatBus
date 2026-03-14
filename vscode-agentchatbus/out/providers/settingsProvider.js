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
exports.SettingsProvider = void 0;
const vscode = __importStar(require("vscode"));
class SettingsProvider {
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (element)
            return [];
        return [
            new SettingItem("MCP Integration Status", "Inspect MCP provider registration, transport, and target endpoint", "plug", "agentchatbus.showMcpStatus"),
            new SettingItem("Server Status", "View detailed server and environment diagnostics", "info", "agentchatbus.showStatus"),
            new SettingItem("Open Web Console", "Open the AgentChatBus dashboard in your browser", "browser", "agentchatbus.openWebConsole"),
            new SettingItem("Server Settings", "Configure AgentChatBus server parameters", "settings-gear", "agentchatbus.serverSettings")
        ];
    }
}
exports.SettingsProvider = SettingsProvider;
class SettingItem extends vscode.TreeItem {
    label;
    tooltip;
    icon;
    commandId;
    constructor(label, tooltip, icon, commandId) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.label = label;
        this.tooltip = tooltip;
        this.icon = icon;
        this.commandId = commandId;
        this.tooltip = tooltip;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.command = {
            title: label,
            command: commandId
        };
        this.contextValue = 'setting';
    }
}
//# sourceMappingURL=settingsProvider.js.map