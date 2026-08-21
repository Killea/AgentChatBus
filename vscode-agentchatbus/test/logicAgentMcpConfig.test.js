const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AGENT_MCP_CLIENTS,
  buildAgentMcpEntry,
  patchAgentMcpConfigContent,
  patchJsonMcpConfig,
  patchTomlMcpConfig,
} = require('../out/logic/testExports');

test('AGENT_MCP_CLIENTS includes Devin, Cursor, Claude, Codex, Gemini', () => {
  const names = AGENT_MCP_CLIENTS.map((c) => c.name);
  assert.ok(names.includes('Devin CLI'));
  assert.ok(names.includes('Cursor'));
  assert.ok(names.includes('Claude Code'));
  assert.ok(names.includes('Codex CLI'));
  assert.ok(names.includes('Gemini CLI'));
});

test('AGENT_MCP_CLIENTS includes VS Code, Windsurf, Cline, Roo Code, Claude Desktop', () => {
  const names = AGENT_MCP_CLIENTS.map((c) => c.name);
  assert.ok(names.includes('VS Code (Copilot)'));
  assert.ok(names.includes('Windsurf'));
  assert.ok(names.includes('Cline'));
  assert.ok(names.includes('Roo Code'));
  assert.ok(names.includes('Claude Desktop'));
});

test('VS Code client uses servers key instead of mcpServers', () => {
  const vscode = AGENT_MCP_CLIENTS.find((c) => c.name === 'VS Code (Copilot)');
  assert.ok(vscode);
  assert.equal(vscode.serverKey, 'servers');
  assert.equal(vscode.format, 'json');
});

test('Claude Desktop has platform-specific config paths', () => {
  const claude = AGENT_MCP_CLIENTS.find((c) => c.name === 'Claude Desktop');
  assert.ok(claude);
  assert.ok(claude.configPathDarwin);
  assert.ok(claude.configPathWin32);
  assert.ok(claude.configPathDarwin.includes('Library/Application Support/Claude'));
  assert.ok(claude.configPathWin32.includes('AppData/Roaming/Claude'));
});

test('buildAgentMcpEntry returns stdio command for v2-socket', () => {
  const entry = buildAgentMcpEntry({
    transport: 'v2-socket',
    proxyScriptPath: '/home/user/.agentchatbus/proxy.mjs',
    socketPath: '/home/user/.agentchatbus/agent.sock',
    nodeExecutable: '/usr/bin/node',
  });
  assert.equal(entry.command, '/usr/bin/node');
  assert.deepEqual(entry.args, ['/home/user/.agentchatbus/proxy.mjs']);
  assert.equal(entry.env.AGENTCHATBUS_SOCKET_PATH, '/home/user/.agentchatbus/agent.sock');
  // Plain node should NOT set ELECTRON_RUN_AS_NODE
  assert.equal(entry.env.ELECTRON_RUN_AS_NODE, undefined);
});

test('buildAgentMcpEntry sets ELECTRON_RUN_AS_NODE for Electron-based executables', () => {
  const entry = buildAgentMcpEntry({
    transport: 'v2-socket',
    proxyScriptPath: '/home/user/.agentchatbus/proxy.mjs',
    socketPath: '/home/user/.agentchatbus/agent.sock',
    nodeExecutable: '/home/hank/Documents/Devin/devin-desktop',
  });
  assert.equal(entry.command, '/home/hank/Documents/Devin/devin-desktop');
  assert.equal(entry.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(entry.env.AGENTCHATBUS_SOCKET_PATH, '/home/user/.agentchatbus/agent.sock');
});

test('buildAgentMcpEntry returns URL for v1-http', () => {
  const entry = buildAgentMcpEntry({
    transport: 'v1-http',
    serverUrl: 'http://127.0.0.1:39765/',
  });
  assert.equal(entry.url, 'http://127.0.0.1:39765/mcp');
});

test('patchJsonMcpConfig adds agentchatbus entry to empty config', () => {
  const content = '{\n  "mcpServers": {}\n}\n';
  const result = patchJsonMcpConfig(content, { url: 'http://127.0.0.1:39765/mcp' });
  assert.equal(result.changed, true);
  const parsed = JSON.parse(result.nextContent);
  assert.equal(parsed.mcpServers.agentchatbus.url, 'http://127.0.0.1:39765/mcp');
});

test('patchJsonMcpConfig preserves other servers', () => {
  const content = JSON.stringify({
    mcpServers: {
      playwright: { command: 'npx', args: ['@playwright/mcp'] },
    },
  });
  const result = patchJsonMcpConfig(content, {
    command: 'node',
    args: ['/proxy.mjs'],
    env: { AGENTCHATBUS_SOCKET_PATH: '/tmp/agent.sock' },
  });
  assert.equal(result.changed, true);
  const parsed = JSON.parse(result.nextContent);
  assert.equal(parsed.mcpServers.playwright.command, 'npx');
  assert.equal(parsed.mcpServers.agentchatbus.command, 'node');
  assert.equal(parsed.mcpServers.agentchatbus.env.AGENTCHATBUS_SOCKET_PATH, '/tmp/agent.sock');
});

test('patchJsonMcpConfig reports unchanged when already correct', () => {
  const content = JSON.stringify({
    mcpServers: {
      agentchatbus: { url: 'http://127.0.0.1:39765/mcp' },
    },
  });
  const result = patchJsonMcpConfig(content, { url: 'http://127.0.0.1:39765/mcp' });
  assert.equal(result.changed, false);
});

test('patchJsonMcpConfig supports custom serverKey (VS Code uses "servers")', () => {
  const content = '{\n  "servers": {}\n}\n';
  const result = patchJsonMcpConfig(
    content,
    { url: 'http://127.0.0.1:39765/mcp' },
    'agentchatbus',
    'servers',
  );
  assert.equal(result.changed, true);
  const parsed = JSON.parse(result.nextContent);
  assert.ok(parsed.servers);
  assert.equal(parsed.servers.agentchatbus.url, 'http://127.0.0.1:39765/mcp');
  // Should NOT create mcpServers key
  assert.equal(parsed.mcpServers, undefined);
});

test('patchAgentMcpConfigContent uses servers key for VS Code client', () => {
  const vscodeClient = AGENT_MCP_CLIENTS.find((c) => c.name === 'VS Code (Copilot)');
  const result = patchAgentMcpConfigContent(
    vscodeClient,
    '{\n  "servers": {}\n}\n',
    { transport: 'v1-http', serverUrl: 'http://127.0.0.1:39765' },
  );
  assert.equal(result.changed, true);
  const parsed = JSON.parse(result.nextContent);
  assert.ok(parsed.servers.agentchatbus);
  assert.equal(parsed.mcpServers, undefined);
});

test('patchTomlMcpConfig adds agentchatbus section', () => {
  const content = `[mcp_servers.playwright]\ncommand = "playwright-mcp"\nargs = []\n`;
  const result = patchTomlMcpConfig(content, {
    command: 'node',
    args: ['/home/user/.agentchatbus/proxy.mjs'],
    env: {
      AGENTCHATBUS_SOCKET_PATH: '/home/user/.agentchatbus/agent.sock',
      ELECTRON_RUN_AS_NODE: '1',
    },
  });
  assert.equal(result.changed, true);
  assert.ok(result.nextContent.includes('[mcp_servers.agentchatbus]'));
  assert.ok(result.nextContent.includes('command = "node"'));
  assert.ok(result.nextContent.includes('/home/user/.agentchatbus/proxy.mjs'));
  assert.ok(result.nextContent.includes('[mcp_servers.agentchatbus.env]'));
  assert.ok(result.nextContent.includes('AGENTCHATBUS_SOCKET_PATH'));
  assert.ok(result.nextContent.includes('ELECTRON_RUN_AS_NODE'));
  // Preserves existing section
  assert.ok(result.nextContent.includes('[mcp_servers.playwright]'));
});

test('patchTomlMcpConfig replaces existing agentchatbus section', () => {
  const content = `[mcp_servers.agentchatbus]\nurl = "http://old-url/mcp"\n`;
  const result = patchTomlMcpConfig(content, {
    command: 'node',
    args: ['/proxy.mjs'],
    env: { AGENTCHATBUS_SOCKET_PATH: '/tmp/sock' },
  });
  assert.equal(result.changed, true);
  assert.ok(result.nextContent.includes('command = "node"'));
  assert.ok(!result.nextContent.includes('old-url'));
});

test('patchAgentMcpConfigContent dispatches to JSON or TOML based on client format', () => {
  const jsonClient = AGENT_MCP_CLIENTS.find((c) => c.name === 'Devin CLI');
  const tomlClient = AGENT_MCP_CLIENTS.find((c) => c.name === 'Codex CLI');
  const jsonResult = patchAgentMcpConfigContent(
    jsonClient,
    '{\n  "mcpServers": {}\n}\n',
    { transport: 'v1-http', serverUrl: 'http://127.0.0.1:39765' },
  );
  assert.equal(jsonResult.changed, true);
  assert.ok(JSON.parse(jsonResult.nextContent).mcpServers.agentchatbus);

  const tomlResult = patchAgentMcpConfigContent(
    tomlClient,
    '',
    { transport: 'v1-http', serverUrl: 'http://127.0.0.1:39765' },
  );
  assert.equal(tomlResult.changed, true);
  assert.ok(tomlResult.nextContent.includes('[mcp_servers.agentchatbus]'));
});
