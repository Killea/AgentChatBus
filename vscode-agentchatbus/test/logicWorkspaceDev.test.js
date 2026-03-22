const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  resolveWorkspaceDevContext,
} = require('../out/logic/testExports');

test('resolveWorkspaceDevContext detects AgentChatBus repo roots from required markers', () => {
  const repoRoot = path.join('C:\\', 'repo', 'AgentChatBus');
  const existing = new Set([
    path.join(repoRoot, 'agentchatbus-ts', 'package.json'),
    path.join(repoRoot, 'agentchatbus-ts', 'src', 'cli', 'index.ts'),
    path.join(repoRoot, 'agentchatbus-ts', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(repoRoot, 'web-ui', 'index.html'),
    path.join(repoRoot, 'web-ui', 'extension', 'index.html'),
    path.join(repoRoot, 'vscode-agentchatbus', 'package.json'),
  ]);

  const context = resolveWorkspaceDevContext(
    [path.join('C:\\', 'other'), repoRoot],
    (candidate) => existing.has(candidate),
  );

  assert.ok(context);
  assert.equal(context.repoRoot, repoRoot);
  assert.equal(context.tsServerRoot, path.join(repoRoot, 'agentchatbus-ts'));
  assert.equal(context.webUiRoot, path.join(repoRoot, 'web-ui'));
  assert.equal(context.webUiExtensionRoot, path.join(repoRoot, 'web-ui', 'extension'));
  assert.equal(
    context.tsxCliEntrypoint,
    path.join(repoRoot, 'agentchatbus-ts', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  );
});

test('resolveWorkspaceDevContext returns null when required markers are missing', () => {
  const repoRoot = path.join('C:\\', 'repo', 'AgentChatBus');
  const context = resolveWorkspaceDevContext([repoRoot], () => false);
  assert.equal(context, null);
});
