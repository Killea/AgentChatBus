const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');
const bundledServerRoot = path.join(extensionRoot, 'resources', 'bundled-server');
const bundledServerEntryDir = path.join(bundledServerRoot, 'dist', 'cli');

test('bundled server ships its runtime dependencies inside extension resources', () => {
  const requiredArtifacts = [
    path.join(bundledServerRoot, 'node_modules', 'node-pty', 'package.json'),
    path.join(bundledServerRoot, 'node_modules', 'node-pty', 'lib', 'index.js'),
    path.join(bundledServerRoot, 'node_modules', 'node-pty', 'prebuilds'),
    path.join(bundledServerRoot, 'node_modules', 'node-addon-api', 'package.json'),
    path.join(bundledServerRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
    path.join(bundledServerRoot, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'),
    path.join(bundledServerRoot, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
  ];

  for (const artifact of requiredArtifacts) {
    assert.ok(fs.existsSync(artifact), `Missing bundled runtime artifact: ${artifact}`);
  }
});

test('bundled server entry can resolve node-pty from bundled resources', () => {
  const resolved = require.resolve('node-pty', { paths: [bundledServerEntryDir] });
  const normalizedResolved = resolved.replaceAll('\\', '/');
  const expectedRoot = bundledServerRoot.replaceAll('\\', '/');

  assert.match(normalizedResolved, /resources\/bundled-server\/node_modules\/node-pty\//);
  assert.ok(
    normalizedResolved.startsWith(expectedRoot),
    `node-pty should resolve from bundled resources, got: ${resolved}`
  );
});
