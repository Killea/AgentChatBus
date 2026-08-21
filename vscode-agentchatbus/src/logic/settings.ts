export type SettingDefinition = {
    label: string;
    tooltip: string;
    iconFile: string;
    commandId: string;
};

export function getSettingsDefinitions(): SettingDefinition[] {
    return [
        {
            label: 'MCP Integration Status',
            tooltip: 'Inspect MCP provider registration, transport, and target endpoint',
            iconFile: 'mgmt-mcp-status.svg',
            commandId: 'agentchatbus.showMcpStatus',
        },
        {
            label: 'Configure Agent MCP',
            tooltip: 'Patch MCP config for all known agent clients (Devin, Cursor, Claude, Codex, Gemini) for V2 socket or V1 HTTP',
            iconFile: 'mgmt-cursor-configure.svg',
            commandId: 'agentchatbus.configureAgentMcp',
        },
        {
            label: 'Open Agent MCP Config',
            tooltip: 'Open an agent client\'s MCP config file for inspection',
            iconFile: 'mgmt-cursor-open.svg',
            commandId: 'agentchatbus.openAgentMcpConfig',
        },
        {
            label: 'Open Web Console',
            tooltip: 'Open the AgentChatBus dashboard in your browser',
            iconFile: 'mgmt-web-console.svg',
            commandId: 'agentchatbus.openWebConsole',
        },
        {
            label: 'Server Settings',
            tooltip: 'Configure AgentChatBus server parameters',
            iconFile: 'mgmt-server-settings.svg',
            commandId: 'agentchatbus.serverSettings',
        },
    ];
}
