const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAgentItemViewModel,
  buildThreadItemViewModel,
  getSettingsDefinitions,
  shouldIncludeArchivedThreadStatus,
  shouldRefreshAgentsForEventType,
  shouldRefreshThreadsForEventType,
} = require('../out/logic/testExports');

test('buildAgentItemViewModel prefers display_name, formats tooltip, and marks online agents', () => {
  const item = buildAgentItemViewModel(
    {
      id: 'agent-1',
      name: 'fallback-name',
      display_name: 'Friendly Agent',
      ide: 'VS Code',
      model: 'gpt-5',
      is_online: true,
      last_heartbeat: '2026-03-20T11:58:00Z',
      last_activity_time: '2026-03-20T11:59:00Z',
      last_activity: 'Reviewed changes',
    },
    { nowMs: Date.parse('2026-03-20T12:00:00Z') },
  );

  assert.deepEqual(item, {
    label: 'Friendly Agent',
    tooltip: 'IDE: VS Code\nModel: gpt-5\nLast Seen: 1m ago\nActivity: Reviewed changes',
    description: 'Online',
    iconId: 'circle-filled',
    colorId: 'testing.iconPassed',
    contextValue: 'agent',
  });
});

test('buildAgentItemViewModel falls back to id and offline relative-time description', () => {
  const item = buildAgentItemViewModel(
    {
      id: 'agent-2',
      is_online: false,
      last_heartbeat: '2026-03-20T09:00:00Z',
    },
    { nowMs: Date.parse('2026-03-20T12:00:00Z') },
  );

  assert.equal(item.label, 'agent-2');
  assert.equal(item.description, 'Last seen 3h ago');
  assert.equal(item.iconId, 'circle-outline');
  assert.equal(item.colorId, 'testing.iconUntested');
  assert.match(item.tooltip, /IDE: N\/A/);
  assert.match(item.tooltip, /Model: N\/A/);
  assert.match(item.tooltip, /Activity: None/);
});

test('buildThreadItemViewModel preserves thread command wiring and topic fallback', () => {
  const untitled = buildThreadItemViewModel({
    id: 'thread-1',
    topic: '',
    status: 'review',
    created_at: '2026-03-20T11:00:00Z',
  });

  assert.deepEqual(untitled, {
    label: 'Untitled Thread',
    tooltip: 'ID: thread-1\nStatus: review',
    description: 'review',
    iconFile: 'thread-review.svg',
    contextValue: 'thread:review',
    commandId: 'agentchatbus.openThread',
    commandArguments: [{
      id: 'thread-1',
      topic: '',
      status: 'review',
      created_at: '2026-03-20T11:00:00Z',
    }],
  });
});

test('thread and agent refresh predicates stay narrow and status filters detect archived mode', () => {
  assert.equal(shouldRefreshThreadsForEventType('thread.updated'), true);
  assert.equal(shouldRefreshThreadsForEventType('msg.new'), true);
  assert.equal(shouldRefreshThreadsForEventType('agent.updated'), false);

  assert.equal(shouldRefreshAgentsForEventType('agent.updated'), true);
  assert.equal(shouldRefreshAgentsForEventType('msg.new'), true);
  assert.equal(shouldRefreshAgentsForEventType('thread.updated'), false);

  assert.equal(shouldIncludeArchivedThreadStatus(['discuss', 'archived']), true);
  assert.equal(shouldIncludeArchivedThreadStatus(['discuss', 'review']), false);
});

test('getSettingsDefinitions preserves exact management menu order and commands', () => {
  assert.deepEqual(getSettingsDefinitions(), [
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
  ]);
});
