#!/usr/bin/env node

import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..');
const extensionRoot = path.join(repoRoot, 'vscode-agentchatbus');
const extensionDistRoot = path.join(extensionRoot, 'dist');
const bundledServerRoot = path.join(extensionRoot, 'resources', 'bundled-server');
const bundledWebUiRoot = path.join(extensionRoot, 'resources', 'web-ui');
const pythonDistRoot = path.join(repoRoot, 'dist');
const bundleWorkRoot = path.join(pythonDistRoot, 'release-bundle');
const tsServerRoot = path.join(repoRoot, 'agentchatbus-ts');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const [flag, inlineValue] = arg.split('=', 2);
    const nextValue = argv[index + 1];
    if (inlineValue !== undefined) {
      args[flag] = inlineValue;
      continue;
    }
    if (nextValue && !nextValue.startsWith('--')) {
      args[flag] = nextValue;
      index += 1;
      continue;
    }
    args[flag] = 'true';
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function ensureDirectory(pathToCreate) {
  await mkdir(pathToCreate, { recursive: true });
}

async function ensureSourceExists(targetPath, label) {
  try {
    await stat(targetPath);
  } catch {
    throw new Error(`${label} is missing: ${targetPath}`);
  }
}

async function copyFile(sourcePath, targetPath) {
  await ensureDirectory(path.dirname(targetPath));
  await cp(sourcePath, targetPath, { force: true });
}

async function copyDirectory(sourcePath, targetPath) {
  await ensureDirectory(path.dirname(targetPath));
  await cp(sourcePath, targetPath, {
    recursive: true,
    force: true,
  });
}

function renderRootReadme({ extensionVersion, bundleDirName }) {
  return `AgentChatBus Release Bundle
===========================

Bundle folder: ${bundleDirName}
Included extension/backend version: ${extensionVersion}

This archive intentionally combines the main desktop deliverables in one place:

1. vscode-extension/
   - Contains the packaged VS Code extension (.vsix).
   - Install it in VS Code or Cursor with the editor's extension install command.

2. standalone-node-server/
   - Contains the standalone CommonJS Node backend plus the web UI assets.
   - This runtime payload is copied from the extension-synced bundled server so it matches the backend shipped with the extension.
   - Use Node.js 20 or newer.

3. LICENSE and LICENSES-vendor.md
   - Project license plus bundled third-party license notes.

Quick start
-----------

VS Code extension:
  Install vscode-extension/agentchatbus-${extensionVersion}.vsix

Standalone Node backend:
  PowerShell: .\\standalone-node-server\\start.ps1
  Bash:       ./standalone-node-server/start.sh

Default backend address:
  http://127.0.0.1:39765

Notes
-----

- Some files are duplicated across the extension and standalone backend on purpose.
- The duplicate payload compresses well in ZIP archives and keeps the bundle easier to understand.
- For detailed standalone backend instructions, read standalone-node-server/README.md and standalone-node-server/EXTERNAL_SERVER_QUICKSTART.md.
`;
}

function renderStandaloneReadme() {
  return `# Standalone Node Server

This folder contains the standalone CommonJS AgentChatBus backend copied from the same runtime payload that the VS Code extension ships internally.

## Contents

- \`dist/cli/index.js\` - bundled Node entry point
- \`package.json\` - CommonJS runtime manifest for the bundled backend
- \`web-ui/\` - browser UI files served by the backend
- \`start.ps1\` - PowerShell launcher
- \`start.sh\` - POSIX shell launcher
- \`EXTERNAL_SERVER_QUICKSTART.md\` - detailed startup and health-check guide

## Requirements

- Node.js 20 or newer

## Quick start

PowerShell:

\`\`\`powershell
.\\start.ps1
\`\`\`

Bash:

\`\`\`bash
./start.sh
\`\`\`

Both launchers default to \`127.0.0.1:39765\`. You can override them with:

- \`AGENTCHATBUS_HOST\`
- \`AGENTCHATBUS_PORT\`

For manual commands, health checks, and VS Code integration guidance, see [EXTERNAL_SERVER_QUICKSTART.md](./EXTERNAL_SERVER_QUICKSTART.md).
`;
}

function renderStartPs1() {
  return `param(
    [string]$ListenHost = $(if ($env:AGENTCHATBUS_HOST) { $env:AGENTCHATBUS_HOST } else { "127.0.0.1" }),
    [int]$Port = $(if ($env:AGENTCHATBUS_PORT) { [int]$env:AGENTCHATBUS_PORT } else { 39765 })
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$EntryPoint = Join-Path $ScriptDir "dist\\cli\\index.js"

node $EntryPoint serve "--host=$ListenHost" "--port=$Port"
exit $LASTEXITCODE
`;
}

function renderStartSh() {
  return `#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
HOST="\${AGENTCHATBUS_HOST:-127.0.0.1}"
PORT="\${AGENTCHATBUS_PORT:-39765}"

exec node "$SCRIPT_DIR/dist/cli/index.js" serve "--host=$HOST" "--port=$PORT"
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const extensionPackageJson = await readJson(path.join(extensionRoot, 'package.json'));
  const extensionVersion = extensionPackageJson.version;
  const bundleVersion = args['--bundle-version'] || extensionVersion;
  const bundleDirName = `AgentChatBus-${bundleVersion}-bundle`;
  const bundleRoot = path.join(bundleWorkRoot, bundleDirName);
  const extensionBundleRoot = path.join(bundleRoot, 'vscode-extension');
  const standaloneRoot = path.join(bundleRoot, 'standalone-node-server');
  const standaloneQuickstartSource = path.join(tsServerRoot, 'EXTERNAL_SERVER_QUICKSTART.md');
  const bundledPackageJson = path.join(bundledServerRoot, 'package.json');
  const bundledDist = path.join(bundledServerRoot, 'dist');
  const vsixPath = path.join(extensionDistRoot, `agentchatbus-${extensionVersion}.vsix`);

  for (const [sourcePath, label] of [
    [vsixPath, 'VSIX artifact'],
    [bundledPackageJson, 'bundled server package.json'],
    [bundledDist, 'bundled server dist directory'],
    [bundledWebUiRoot, 'bundled web-ui directory'],
    [standaloneQuickstartSource, 'standalone quickstart document'],
    [path.join(repoRoot, 'LICENSE'), 'repository LICENSE'],
    [path.join(repoRoot, 'LICENSES-vendor.md'), 'third-party license notes'],
  ]) {
    await ensureSourceExists(sourcePath, label);
  }

  await rm(bundleRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });

  await ensureDirectory(extensionBundleRoot);
  await ensureDirectory(standaloneRoot);

  await copyFile(vsixPath, path.join(extensionBundleRoot, path.basename(vsixPath)));
  await copyFile(path.join(repoRoot, 'LICENSE'), path.join(bundleRoot, 'LICENSE'));
  await copyFile(path.join(repoRoot, 'LICENSES-vendor.md'), path.join(bundleRoot, 'LICENSES-vendor.md'));

  await copyFile(bundledPackageJson, path.join(standaloneRoot, 'package.json'));
  await copyDirectory(bundledDist, path.join(standaloneRoot, 'dist'));
  await copyDirectory(bundledWebUiRoot, path.join(standaloneRoot, 'web-ui'));
  await copyFile(
    standaloneQuickstartSource,
    path.join(standaloneRoot, 'EXTERNAL_SERVER_QUICKSTART.md'),
  );

  await writeFile(
    path.join(bundleRoot, 'README_FIRST.txt'),
    renderRootReadme({ extensionVersion, bundleDirName }),
    'utf8',
  );
  await writeFile(path.join(standaloneRoot, 'README.md'), renderStandaloneReadme(), 'utf8');
  await writeFile(path.join(standaloneRoot, 'start.ps1'), renderStartPs1(), 'utf8');
  await writeFile(path.join(standaloneRoot, 'start.sh'), renderStartSh(), 'utf8');

  if (process.platform !== 'win32') {
    try {
      const startShPath = path.join(standaloneRoot, 'start.sh');
      await chmod(startShPath, 0o755);
    } catch {
      // Best-effort permission adjustment only.
    }
  }

  console.log('[release-bundle] assembled bundle staging directory');
  console.log(`  - bundle root: ${path.relative(repoRoot, bundleRoot)}`);
  console.log(`  - extension VSIX: ${path.relative(repoRoot, vsixPath)}`);
  console.log(`  - standalone runtime: ${path.relative(repoRoot, standaloneRoot)}`);
  console.log(`  - root explainer: ${path.relative(repoRoot, path.join(bundleRoot, 'README_FIRST.txt'))}`);
}

main().catch((error) => {
  console.error(
    '[release-bundle] failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
