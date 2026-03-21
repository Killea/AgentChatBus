type CursorMcpServerDefinition = {
    url: string;
    type: 'streamable-http' | 'sse';
};

export type CursorMcpConfig = {
    mcpServers?: Record<string, CursorMcpServerDefinition | unknown>;
    [key: string]: unknown;
};

export type CursorMcpConfigBuildResult = {
    nextConfig: CursorMcpConfig;
    changed: boolean;
    serverName: string;
    serverUrl: string;
};

export function normalizeServerUrl(serverUrl: string): string {
    return String(serverUrl || '').replace(/\/+$/, '');
}

export function getCursorMcpUrl(serverUrl: string): string {
    return `${normalizeServerUrl(serverUrl)}/mcp/sse`;
}

export function buildCursorMcpConfig(
    currentConfig: CursorMcpConfig,
    serverUrl: string,
    serverName = 'agentchatbus'
): CursorMcpConfigBuildResult {
    const mcpUrl = getCursorMcpUrl(serverUrl);

    const nextConfig: CursorMcpConfig = {
        ...currentConfig,
        mcpServers: {
            ...(currentConfig.mcpServers || {}),
            [serverName]: {
                url: mcpUrl,
                type: 'sse'
            }
        }
    };

    return {
        nextConfig,
        changed: JSON.stringify(currentConfig) !== JSON.stringify(nextConfig),
        serverName,
        serverUrl: mcpUrl
    };
}
