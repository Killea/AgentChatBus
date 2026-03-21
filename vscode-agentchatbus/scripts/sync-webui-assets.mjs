#!/usr/bin/env node

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const tsServerRoot = path.join(repoRoot, 'agentchatbus-ts');
const bundledServerRoot = path.join(extensionRoot, 'resources', 'bundled-server');
const bundledWebUiRoot = path.join(extensionRoot, 'resources', 'web-ui');
const bundledServerNodeModulesRoot = path.join(bundledServerRoot, 'node_modules');

const legacyMediaArtifacts = [
  path.join(extensionRoot, 'resources', 'media', 'chatPanel.js'),
  path.join(extensionRoot, 'resources', 'media', 'chatPanel.css'),
  path.join(extensionRoot, 'resources', 'media', 'messageRenderer.js'),
  path.join(extensionRoot, 'resources', 'media', 'messageRenderer.css'),
  path.join(extensionRoot, 'resources', 'media', 'mermaid.min.js'),
];

const bundledServerRuntimeDependencies = [
  {
    from: path.join(tsServerRoot, 'node_modules', 'node-pty'),
    to: path.join(bundledServerNodeModulesRoot, 'node-pty'),
    label: 'bundled TS server runtime dependency node-pty',
  },
  {
    from: path.join(tsServerRoot, 'node_modules', 'node-addon-api'),
    to: path.join(bundledServerNodeModulesRoot, 'node-addon-api'),
    label: 'bundled TS server runtime dependency node-addon-api',
  },
  {
    from: path.join(tsServerRoot, 'node_modules', '@xterm', 'xterm'),
    to: path.join(bundledServerNodeModulesRoot, '@xterm', 'xterm'),
    label: 'bundled TS server runtime dependency @xterm/xterm',
  },
  {
    from: path.join(tsServerRoot, 'node_modules', '@xterm', 'addon-fit'),
    to: path.join(bundledServerNodeModulesRoot, '@xterm', 'addon-fit'),
    label: 'bundled TS server runtime dependency @xterm/addon-fit',
  },
];

async function runTsServerBuild() {
  await new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd: tsServerRoot,
      shell: process.platform === 'win32',
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`agentchatbus-ts build failed with exit code ${code ?? -1}`));
    });
  });
}

async function removeDirectory(targetPath) {
  await rm(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}

async function syncDirectory(from, to, label) {
  await removeDirectory(to);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, {
    recursive: true,
    force: true,
    filter: (source) => {
      const baseName = path.basename(source);
      return baseName !== 'README.md';
    },
  });
  return { label, from, to };
}

async function writeBundledServerPackageJson() {
  await mkdir(bundledServerRoot, { recursive: true });
  const packageJsonPath = path.join(bundledServerRoot, 'package.json');
  const packageJson = {
    private: true,
    type: 'commonjs',
  };
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  return packageJsonPath;
}

async function main() {
  console.log('[sync:webui-assets] building agentchatbus-ts...');
  await runTsServerBuild();

  await Promise.all(legacyMediaArtifacts.map((filePath) => rm(filePath, { force: true })));

  const syncedDirectories = [];
  syncedDirectories.push(await syncDirectory(path.join(tsServerRoot, 'dist'), path.join(bundledServerRoot, 'dist'), 'bundled TS server dist'));
  await removeDirectory(bundledServerNodeModulesRoot);
  for (const dependency of bundledServerRuntimeDependencies) {
    syncedDirectories.push(await syncDirectory(dependency.from, dependency.to, dependency.label));
  }
  syncedDirectories.push(await syncDirectory(path.join(repoRoot, 'web-ui'), bundledWebUiRoot, 'bundled web-ui runtime'));
  const bundledServerPackageJson = await writeBundledServerPackageJson();

  console.log('[sync:webui-assets] synchronized runtime directories:');
  for (const entry of syncedDirectories) {
    const relTo = path.relative(extensionRoot, entry.to);
    console.log(`  - ${entry.label}: ${relTo}`);
  }
  console.log(`  - bundled server package manifest: ${path.relative(extensionRoot, bundledServerPackageJson)}`);
}

main().catch((error) => {
  console.error('[sync:webui-assets] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
