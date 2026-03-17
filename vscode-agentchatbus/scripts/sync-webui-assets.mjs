#!/usr/bin/env node

import { mkdir, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');

const mappings = [
  {
    from: path.join(repoRoot, 'web-ui', 'extension', 'media', 'chatPanel.js'),
    to: path.join(extensionRoot, 'resources', 'media', 'chatPanel.js'),
    label: 'extension chat panel script',
  },
  {
    from: path.join(repoRoot, 'web-ui', 'extension', 'media', 'chatPanel.css'),
    to: path.join(extensionRoot, 'resources', 'media', 'chatPanel.css'),
    label: 'extension chat panel style',
  },
  {
    from: path.join(repoRoot, 'web-ui', 'extension', 'media', 'messageRenderer.js'),
    to: path.join(extensionRoot, 'resources', 'media', 'messageRenderer.js'),
    label: 'extension message renderer script',
  },
  {
    from: path.join(repoRoot, 'web-ui', 'extension', 'media', 'messageRenderer.css'),
    to: path.join(extensionRoot, 'resources', 'media', 'messageRenderer.css'),
    label: 'extension message renderer style',
  },
  {
    from: path.join(repoRoot, 'web-ui', 'extension', 'media', 'mermaid.min.js'),
    to: path.join(extensionRoot, 'resources', 'media', 'mermaid.min.js'),
    label: 'mermaid vendor',
  },
  {
    from: path.join(repoRoot, 'web-ui', 'extension', 'index.html'),
    to: path.join(extensionRoot, 'resources', 'webui-extension', 'index.html'),
    label: 'extension debug html',
  },
  {
    from: path.join(repoRoot, 'web-ui', 'extension', 'media', 'vscodeBridgeBrowser.js'),
    to: path.join(extensionRoot, 'resources', 'webui-extension', 'vscodeBridgeBrowser.js'),
    label: 'extension debug browser bridge',
  },
];

async function ensureParentDir(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function copyOne(entry) {
  await ensureParentDir(entry.to);
  await copyFile(entry.from, entry.to);
  const copied = await stat(entry.to);
  return {
    ...entry,
    size: copied.size,
  };
}

async function main() {
  const copied = [];
  for (const mapping of mappings) {
    copied.push(await copyOne(mapping));
  }

  console.log('[sync:webui-assets] copied web-ui assets to vscode extension:');
  for (const item of copied) {
    const relTo = path.relative(extensionRoot, item.to);
    console.log(`  - ${item.label}: ${relTo} (${item.size} bytes)`);
  }
}

main().catch((error) => {
  console.error('[sync:webui-assets] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
