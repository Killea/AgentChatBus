/**
 * Unified agent MCP config auto-configuration.
 *
 * Patches the `agentchatbus` MCP server entry in config files for various
 * IDE/CLI agent clients (Devin CLI, Cursor, Claude Code, Codex, Gemini CLI).
 *
 * In V2 mode (default): writes a stdio command entry that launches the v2
 * socket proxy. The agent spawns the proxy as a child process; the proxy
 * connects to the daemon's Unix socket / Windows named pipe. No IP or port
 * is exposed to the agent.
 *
 * In V1 mode (legacy): writes a URL entry pointing to the HTTP MCP endpoint.
 */

export type AgentTransportMode = 'v2-socket' | 'v1-http';

export type AgentMcpTargetEntry =
    | { command: string; args: string[]; env?: Record<string, string> }
    | { url: string; type?: string };

export interface AgentMcpClientSpec {
    /** Human-readable name shown in UI. */
    name: string;
    /** Config file path relative to $HOME (or platform-specific override). */
    configPath: string;
    /** Config file format. */
    format: 'json' | 'toml';
    /** Description shown in UI. */
    description: string;
    /** Whether this client supports stdio command entries. */
    supportsStdio: boolean;
    /** Top-level JSON key for MCP servers (default: 'mcpServers'). VS Code uses 'servers'. */
    serverKey?: string;
    /** Platform-specific config path override (relative to $HOME). */
    configPathDarwin?: string;
    configPathWin32?: string;
}

/**
 * Known MCP client config files.
 * Paths are relative to $HOME unless overridden by platform-specific fields.
 */
export const AGENT_MCP_CLIENTS: AgentMcpClientSpec[] = [
    {
        name: 'Devin CLI',
        configPath: '.config/devin/mcp_config.json',
        format: 'json',
        description: 'Devin CLI coding agent by Cognition',
        supportsStdio: true,
    },
    {
        name: 'Cursor',
        configPath: '.cursor/mcp.json',
        format: 'json',
        description: 'Cursor IDE global MCP config',
        supportsStdio: true,
    },
    {
        name: 'Claude Code',
        configPath: '.claude.json',
        format: 'json',
        description: 'Anthropic Claude Code CLI (global mcpServers)',
        supportsStdio: true,
    },
    {
        name: 'Codex CLI',
        configPath: '.codex/config.toml',
        format: 'toml',
        description: 'OpenAI Codex CLI (TOML [mcp_servers.X])',
        supportsStdio: true,
    },
    {
        name: 'Gemini CLI',
        configPath: '.gemini/config/mcp_config.json',
        format: 'json',
        description: 'Google Gemini CLI',
        supportsStdio: true,
    },
    {
        name: 'VS Code (Copilot)',
        configPath: '.vscode/mcp.json',
        format: 'json',
        description: 'VS Code with GitHub Copilot (workspace .vscode/mcp.json)',
        supportsStdio: true,
        serverKey: 'servers',
    },
    {
        name: 'Windsurf',
        configPath: '.codeium/windsurf/mcp_config.json',
        format: 'json',
        description: 'Windsurf IDE (Codeium) global MCP config',
        supportsStdio: true,
    },
    {
        name: 'Cline',
        configPath: '.cline/data/settings/cline_mcp_settings.json',
        format: 'json',
        description: 'Cline AI coding assistant (VS Code extension)',
        supportsStdio: true,
    },
    {
        name: 'Roo Code',
        configPath: '.roo/mcp.json',
        format: 'json',
        description: 'Roo Code (VS Code extension) project MCP config',
        supportsStdio: true,
    },
    {
        name: 'Claude Desktop',
        configPath: '.config/Claude/claude_desktop_config.json',
        configPathDarwin: 'Library/Application Support/Claude/claude_desktop_config.json',
        configPathWin32: 'AppData/Roaming/Claude/claude_desktop_config.json',
        format: 'json',
        description: 'Claude Desktop app (platform-specific config path)',
        supportsStdio: true,
    },
];

export interface AgentMcpPatchInput {
    transport: AgentTransportMode;
    /** Path to the v2 proxy script (required for v2-socket). */
    proxyScriptPath?: string;
    /** Socket path for v2 mode. */
    socketPath?: string;
    /** Server URL for v1 mode (e.g. http://127.0.0.1:39765). */
    serverUrl?: string;
    /** Node.js executable to run the proxy (defaults to process.execPath). */
    nodeExecutable?: string;
}

export interface AgentMcpPatchResult {
    client: AgentMcpClientSpec;
    changed: boolean;
    error?: string;
}

/**
 * Build the target MCP server entry for a given transport mode.
 */
export function buildAgentMcpEntry(input: AgentMcpPatchInput): AgentMcpTargetEntry {
    if (input.transport === 'v2-socket') {
        const proxyPath = input.proxyScriptPath;
        if (!proxyPath) {
            throw new Error('proxyScriptPath is required for v2-socket transport');
        }
        const socketPath = input.socketPath || '';
        const env: Record<string, string> = {};
        if (socketPath) {
            env.AGENTCHATBUS_SOCKET_PATH = socketPath;
        }
        // If the command is an Electron-based binary (e.g. VSCode's process.execPath),
        // we need ELECTRON_RUN_AS_NODE=1 so it behaves as a pure Node.js runtime
        // instead of launching the GUI. This is safe to set even for regular node.
        const cmd = input.nodeExecutable || 'node';
        if (cmd !== 'node' && !cmd.endsWith('/node') && !cmd.endsWith('\\node.exe')) {
            env.ELECTRON_RUN_AS_NODE = '1';
        }
        return {
            command: cmd,
            args: [proxyPath],
            env,
        };
    }
    // v1-http
    const baseUrl = (input.serverUrl || '').replace(/\/+$/, '');
    return { url: `${baseUrl}/mcp` };
}

/**
 * Check if a target entry matches an existing entry in a JSON config.
 */
function entriesMatch(existing: unknown, target: AgentMcpTargetEntry): boolean {
    try {
        return JSON.stringify(existing) === JSON.stringify(target);
    } catch {
        return false;
    }
}

// ── JSON config patching (Devin, Cursor, Claude, Gemini) ────────────────────

export function patchJsonMcpConfig(
    currentContent: string,
    target: AgentMcpTargetEntry,
    serverName = 'agentchatbus',
    serverKey = 'mcpServers',
): { nextContent: string; changed: boolean } {
    let config: Record<string, unknown>;
    try {
        config = JSON.parse(currentContent);
    } catch {
        config = {};
    }
    if (!config[serverKey] || typeof config[serverKey] !== 'object') {
        config[serverKey] = {};
    }
    const servers = config[serverKey] as Record<string, unknown>;
    if (entriesMatch(servers[serverName], target)) {
        return { nextContent: currentContent, changed: false };
    }
    servers[serverName] = target;
    config[serverKey] = servers;
    return {
        nextContent: JSON.stringify(config, null, 2) + '\n',
        changed: true,
    };
}

// ── TOML config patching (Codex) ─────────────────────────────────────────────

/**
 * Patch a Codex-style TOML config that uses [mcp_servers.X] sections.
 * This is a minimal TOML writer — it only handles the mcp_servers.agentchatbus
 * section and preserves the rest of the file verbatim.
 */
export function patchTomlMcpConfig(
    currentContent: string,
    target: AgentMcpTargetEntry,
    serverName = 'agentchatbus',
): { nextContent: string; changed: boolean } {
    const sectionHeader = `[mcp_servers.${serverName}]`;

    // Build the new section text
    let newSection: string;
    if ('command' in target) {
        const lines = [sectionHeader];
        lines.push(`command = "${target.command}"`);
        lines.push(`args = [${target.args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(', ')}]`);
        if (target.env && Object.keys(target.env).length > 0) {
            lines.push(`[mcp_servers.${serverName}.env]`);
            for (const [k, v] of Object.entries(target.env)) {
                lines.push(`${k} = "${v}"`);
            }
        }
        newSection = lines.join('\n');
    } else {
        // URL-based entry
        newSection = `${sectionHeader}\nurl = "${target.url}"`;
    }

    // Find and replace the existing section, or append.
    // A section spans from [mcp_servers.agentchatbus] to the next [section] or EOF.
    const sectionRegex = new RegExp(
        `^\\[mcp_servers\\.${serverName}(?:\\.env)?\\][^\\[]*`,
        'gm',
    );
    const existingMatch = currentContent.match(sectionRegex);
    if (existingMatch) {
        // Check if already correct by comparing the trimmed section
        const currentSection = existingMatch[0].trim();
        // Normalize whitespace for comparison
        const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
        if (normalize(currentSection) === normalize(newSection)) {
            return { nextContent: currentContent, changed: false };
        }
        // Replace the existing section
        const nextContent = currentContent.replace(sectionRegex, '').trimEnd() + '\n\n' + newSection + '\n';
        return { nextContent, changed: true };
    }
    // Append new section
    const nextContent = currentContent.trimEnd() + '\n\n' + newSection + '\n';
    return { nextContent, changed: true };
}

/**
 * Patch a single client's MCP config file in-memory (pure function for testing).
 */
export function patchAgentMcpConfigContent(
    client: AgentMcpClientSpec,
    currentContent: string,
    input: AgentMcpPatchInput,
): { nextContent: string; changed: boolean } {
    const target = buildAgentMcpEntry(input);
    if (client.format === 'toml') {
        return patchTomlMcpConfig(currentContent, target);
    }
    return patchJsonMcpConfig(currentContent, target, 'agentchatbus', client.serverKey || 'mcpServers');
}
