/**
 * Filesystem manager for patching agent MCP config files.
 * Reads/writes the actual config files on disk.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
    AGENT_MCP_CLIENTS,
    AgentMcpClientSpec,
    AgentMcpPatchInput,
    AgentMcpPatchResult,
    patchAgentMcpConfigContent,
} from './logic/agentMcpConfig';

export type { AgentMcpClientSpec, AgentMcpPatchInput, AgentMcpPatchResult } from './logic/agentMcpConfig';

export class AgentMcpConfigManager {
    /**
     * Get the full path for a client config, resolving platform-specific overrides.
     */
    getConfigPath(client: AgentMcpClientSpec): string {
        const platform = process.platform;
        let relativePath = client.configPath;
        if (platform === 'darwin' && client.configPathDarwin) {
            relativePath = client.configPathDarwin;
        } else if (platform === 'win32' && client.configPathWin32) {
            relativePath = client.configPathWin32;
        }
        return path.join(os.homedir(), relativePath);
    }

    /**
     * Patch a single client's MCP config file on disk.
     */
    async patchClient(
        client: AgentMcpClientSpec,
        input: AgentMcpPatchInput,
    ): Promise<AgentMcpPatchResult> {
        const fullPath = this.getConfigPath(client);
        try {
            let currentContent = '';
            try {
                currentContent = await fs.readFile(fullPath, 'utf-8');
            } catch (err: unknown) {
                const nodeErr = err as NodeJS.ErrnoException;
                if (nodeErr.code !== 'ENOENT') {
                    throw err;
                }
                // File doesn't exist — create with minimal content
                const serverKey = client.serverKey || 'mcpServers';
                currentContent = client.format === 'toml'
                    ? ''
                    : `{\n  "${serverKey}": {}\n}\n`;
            }

            const result = patchAgentMcpConfigContent(client, currentContent, input);
            if (result.changed) {
                await fs.mkdir(path.dirname(fullPath), { recursive: true });
                await fs.writeFile(fullPath, result.nextContent, 'utf-8');
            }
            return { client, changed: result.changed };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return { client, changed: false, error: message };
        }
    }

    /**
     * Patch all known agent MCP config files.
     */
    async patchAll(input: AgentMcpPatchInput): Promise<AgentMcpPatchResult[]> {
        const results: AgentMcpPatchResult[] = [];
        for (const client of AGENT_MCP_CLIENTS) {
            results.push(await this.patchClient(client, input));
        }
        return results;
    }

    /**
     * Get the list of known clients.
     */
    getClients(): AgentMcpClientSpec[] {
        return AGENT_MCP_CLIENTS;
    }
}
