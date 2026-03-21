#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionRoot = path.resolve(__dirname, '..');
const outDir = path.join(extensionRoot, 'out');
const watchMode = process.argv.includes('--watch');

const buildOptions = {
  absWorkingDir: extensionRoot,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
  charset: 'utf8',
};

const entryBuilds = [
  {
    ...buildOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
  },
  {
    ...buildOptions,
    entryPoints: ['src/views/chatPanelHtml.ts'],
    outfile: 'out/views/chatPanelHtml.js',
  },
  {
    ...buildOptions,
    entryPoints: ['src/logic/testExports.ts'],
    outfile: 'out/logic/testExports.js',
  },
];

async function prepareOutDir() {
  if (existsSync(outDir)) {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });
}

async function main() {
  await prepareOutDir();

  if (watchMode) {
    for (const options of entryBuilds) {
      const ctx = await context(options);
      await ctx.watch();
    }
    console.log('[build:extension] watching for changes...');
    return;
  }

  for (const options of entryBuilds) {
    await build(options);
  }
  console.log('[build:extension] bundled extension host and test-compatible helpers into out/');
}

main().catch((error) => {
  console.error('[build:extension] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
