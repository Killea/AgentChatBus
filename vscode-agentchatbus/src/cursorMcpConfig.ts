import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

type CursorMcpServerDefinition = {
    url: string;
    type: 'sse';
};

type CursorMcpConfig = {
    mcpServers?: Record<string, CursorMcpServerDefinition | unknown>;
    [key: string]: unknown;
};

export type CursorConfigResult = {
    path: string;
    changed: boolean;
    serverName: string;
    sseUrl: string;
};

export class CursorMcpConfigManager {
    private static readonly SERVER_NAME = 'agentchatbus';

    getGlobalConfigPath(): string {
        return path.join(os.homedir(), '.cursor', 'mcp.json');
    }

    async configureGlobalAgentChatBus(serverUrl: string): Promise<CursorConfigResult> {
        const configPath = this.getGlobalConfigPath();
        const normalizedServerUrl = serverUrl.replace(/\/+$/, '');
        const sseUrl = `${normalizedServerUrl}/mcp/sse`;
        const currentConfig = await this.readConfig(configPath);

        const nextConfig: CursorMcpConfig = {
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

    async openGlobalConfig(): Promise<void> {
        const configPath = this.getGlobalConfigPath();
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        try {
            await fs.access(configPath);
        } catch {
            await fs.writeFile(configPath, '{\n  "mcpServers": {}\n}\n', 'utf8');
        }

        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
        await vscode.window.showTextDocument(doc);
    }

    private async readConfig(configPath: string): Promise<CursorMcpConfig> {
        try {
            const raw = await fs.readFile(configPath, 'utf8');
            const parsed = JSON.parse(raw) as CursorMcpConfig;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
            throw new Error('Cursor MCP config must be a JSON object.');
        } catch (error) {
            const nodeError = error as NodeJS.ErrnoException;
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