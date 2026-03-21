const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCursorMcpConfig,
  getCursorMcpUrl,
  normalizeServerUrl,
} = require('../out/logic/testExports');

test('normalizeServerUrl trims trailing slashes and getCursorMcpUrl appends /mcp/sse', () => {
  assert.equal(normalizeServerUrl('http://127.0.0.1:39765///'), 'http://127.0.0.1:39765');
  assert.equal(getCursorMcpUrl('http://127.0.0.1:39765/'), 'http://127.0.0.1:39765/mcp/sse');
});

test('buildCursorMcpConfig preserves unrelated config and adds agentchatbus server', () => {
  const currentConfig = {
    theme: 'dark',
    mcpServers: {
      existing: {
        url: 'http://example.test/mcp',
        type: 'streamable-http',
      },
    },
  };

  const result = buildCursorMcpConfig(currentConfig, 'http://127.0.0.1:39765/');
  assert.equal(result.changed, true);
  assert.equal(result.serverName, 'agentchatbus');
  assert.equal(result.serverUrl, 'http://127.0.0.1:39765/mcp/sse');
  assert.equal(result.nextConfig.theme, 'dark');
  assert.deepEqual(result.nextConfig.mcpServers.existing, currentConfig.mcpServers.existing);
  assert.deepEqual(result.nextConfig.mcpServers.agentchatbus, {
    url: 'http://127.0.0.1:39765/mcp/sse',
    type: 'sse',
  });
});

test('buildCursorMcpConfig reports unchanged when config is already up to date', () => {
  const currentConfig = {
    mcpServers: {
      agentchatbus: {
        url: 'http://127.0.0.1:39765/mcp/sse',
        type: 'sse',
      },
    },
  };

  const result = buildCursorMcpConfig(currentConfig, 'http://127.0.0.1:39765');
  assert.equal(result.changed, false);
  assert.deepEqual(result.nextConfig, currentConfig);
});
