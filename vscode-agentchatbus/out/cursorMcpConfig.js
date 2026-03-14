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
exports.CursorMcpConfigManager = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
class CursorMcpConfigManager {
    static SERVER_NAME = 'agentchatbus';
    getGlobalConfigPath() {
        return path.join(os.homedir(), '.cursor', 'mcp.json');
    }
    async configureGlobalAgentChatBus(serverUrl) {
        const configPath = this.getGlobalConfigPath();
        const normalizedServerUrl = serverUrl.replace(/\/+$/, '');
        const sseUrl = `${normalizedServerUrl}/mcp/sse`;
        const currentConfig = await this.readConfig(configPath);
        const nextConfig = {
            ...currentConfig,
            mcpServers: {
                ...(currentConfig.mcpServers || {}),
                [CursorMcpConfigManager.SERVER_NAME]: {
                    url: sseUrl,
                    type: 'sse'
                }
            }
        };
        const changed = JSON.stringify(currentConfig) !== JSON.stringify(nextConfig);
        if (changed) {
            await fs.mkdir(path.dirname(configPath), { recursive: true });
            await fs.writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
        }
        return {
            path: configPath,
            changed,
            serverName: CursorMcpConfigManager.SERVER_NAME,
            sseUrl
        };
    }
    async openGlobalConfig() {
        const configPath = this.getGlobalConfigPath();
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        try {
            await fs.access(configPath);
        }
        catch {
            await fs.writeFile(configPath, '{\n  "mcpServers": {}\n}\n', 'utf8');
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
        await vscode.window.showTextDocument(doc);
    }
    async readConfig(configPath) {
        try {
            const raw = await fs.readFile(configPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
            throw new Error('Cursor MCP config must be a JSON object.');
        }
        catch (error) {
            const nodeError = error;
            if (nodeError.code === 'ENOENT') {
                return { mcpServers: {} };
            }
            if (error instanceof SyntaxError) {
                throw new Error(`Cursor MCP config is not valid JSON: ${configPath}`);
            }
            throw error;
        }
    }
}
exports.CursorMcpConfigManager = CursorMcpConfigManager;
//# sourceMappingURL=cursorMcpConfig.js.map