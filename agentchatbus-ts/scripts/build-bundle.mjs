#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');

async function prepareDistDir() {
  if (existsSync(distDir)) {
    await rm(distDir, { recursive: true, force: true });
  }
  await mkdir(path.join(distDir, 'cli'), { recursive: true });
}

async function main() {
  await prepareDistDir();

  await build({
    absWorkingDir: projectRoot,
    entryPoints: ['src/cli/index.ts'],
    outfile: 'dist/cli/index.js',
    bundle: true,
    external: ['node-pty'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    minify: true,
    legalComments: 'none',
    logLevel: 'info',
    charset: 'utf8',
    banner: {
      js: '#!/usr/bin/env node',
    },
  });

  console.log('[build:bundle] bundled agentchatbus-ts runtime to dist/cli/index.js');
}

main().catch((error) => {
  console.error('[build:bundle] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
