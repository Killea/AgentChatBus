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
            label: 'Configure Cursor MCP',
            tooltip: 'Update Cursor\'s global mcp.json with an AgentChatBus SSE entry',
            iconFile: 'mgmt-cursor-configure.svg',
            commandId: 'agentchatbus.configureCursorMcp',
        },
        {
            label: 'Open Cursor MCP Config',
            tooltip: 'Open Cursor\'s global mcp.json for inspection',
            iconFile: 'mgmt-cursor-open.svg',
            commandId: 'agentchatbus.openCursorMcpConfig',
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
