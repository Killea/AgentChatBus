const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const extensionRoot = path.resolve(__dirname, '..');
const bundledServerEntry = path.join(extensionRoot, 'resources', 'bundled-server', 'dist', 'cli', 'index.js');
const bundledServerPackageJson = path.join(extensionRoot, 'resources', 'bundled-server', 'package.json');
const bundledWebUiRoot = path.join(extensionRoot, 'resources', 'web-ui');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForHttpOk(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill();

  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);

  if (child.exitCode === null) {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      await new Promise((resolve) => killer.once('exit', resolve));
    } else {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
}

test('bundled server package metadata, health, and web ui', (_, done) => {
  // Use callback-style test to avoid node:test event loop drain issues
  // that cancel async tests spawning child processes on Linux/Node v22.
  (async () => {
    // Part 1: package metadata
    const packageJson = JSON.parse(await fsp.readFile(bundledServerPackageJson, 'utf8'));
    assert.equal(packageJson.type, 'commonjs');
    assert.equal(packageJson.private, true);

    // Part 2: runtime health + web ui
    assert.ok(fs.existsSync(bundledServerEntry), 'Bundled server entrypoint is missing');
    assert.ok(fs.existsSync(path.join(bundledWebUiRoot, 'index.html')), 'Bundled web-ui runtime is missing');

    const port = await getFreePort();
    const tmpRoot = path.join(extensionRoot, '.tmp-runtime-test');
    const appDir = path.join(tmpRoot, `app-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const dbPath = path.join(appDir, 'bus.db');
    const configPath = path.join(appDir, 'config.json');

    await fsp.mkdir(appDir, { recursive: true });

    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, [bundledServerEntry, 'serve'], {
      cwd: extensionRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AGENTCHATBUS_HOST: '127.0.0.1',
        AGENTCHATBUS_PORT: String(port),
        AGENTCHATBUS_DB: dbPath,
        AGENTCHATBUS_APP_DIR: appDir,
        AGENTCHATBUS_CONFIG_FILE: configPath,
        AGENTCHATBUS_WEB_UI_DIR: bundledWebUiRoot,
        AGENTCHATBUS_BOOTSTRAP_DEFAULT_THREAD: '1',
      },
      windowsHide: true,
    });

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    try {
      const healthResponse = await waitForHttpOk(`http://127.0.0.1:${port}/health`, 8000);
      const healthPayload = await healthResponse.json();
      assert.equal(healthPayload.status, 'ok');

      const staticResponse = await waitForHttpOk(`http://127.0.0.1:${port}/static/index.html`, 4000);
      const staticHtml = await staticResponse.text();
      assert.match(staticHtml, /AgentChatBus/i);

      assert.match(stdout, /serve mode listening on 127\.0\.0\.1:/);
      done();
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await stopChild(child);
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  })().catch(done);
});
