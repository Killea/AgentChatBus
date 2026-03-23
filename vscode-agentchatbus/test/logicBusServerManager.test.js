const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  BUNDLED_RUNTIME_RESOLVED_BY,
  MIN_HOST_NODE_VERSION,
  buildBundledLaunchSpec,
  buildWorkspaceDevLaunchSpec,
  classifyDetectedStartupMode,
  classifyExternalStartupMode,
  createSingleFlightRunner,
  describeStartupProbeFailure,
  ensureSupportedHostNodeVersion,
  extractOwnershipAssignable,
  normalizeHealthString,
  resolveStartupProbeResult,
  WORKSPACE_DEV_RUNTIME_RESOLVED_BY,
} = require('../out/logic/testExports');

test('normalizeHealthString trims strings and rejects non-string or empty values', () => {
  assert.equal(normalizeHealthString('  node  '), 'node');
  assert.equal(normalizeHealthString('   '), undefined);
  assert.equal(normalizeHealthString(42), undefined);
});

test('extractOwnershipAssignable returns booleans when health management exposes them', () => {
  assert.equal(extractOwnershipAssignable({ management: { ownership_assignable: true } }), true);
  assert.equal(extractOwnershipAssignable({ management: { ownership_assignable: false } }), false);
  assert.equal(extractOwnershipAssignable({ management: {} }), null);
  assert.equal(extractOwnershipAssignable(undefined), null);
});

test('classifyExternalStartupMode maps ownership management into startup modes', () => {
  assert.equal(
    classifyExternalStartupMode({ management: { ownership_assignable: true } }),
    'external-service-extension-managed',
  );
  assert.equal(
    classifyExternalStartupMode({ management: { ownership_assignable: false } }),
    'external-service-manual',
  );
  assert.equal(classifyExternalStartupMode({}), 'external-service-unknown');
});

test('classifyDetectedStartupMode preserves explicit startup_mode values', () => {
  assert.equal(
    classifyDetectedStartupMode({ startup_mode: 'workspace-dev-service' }),
    'workspace-dev-service',
  );
  assert.equal(
    classifyDetectedStartupMode({ startup_mode: 'bundled-ts-service' }),
    'bundled-ts-service',
  );
  assert.equal(
    classifyDetectedStartupMode({ startup_mode: 'external-service-manual' }),
    'external-service-manual',
  );
  assert.equal(
    classifyDetectedStartupMode({ management: { ownership_assignable: true } }),
    'external-service-extension-managed',
  );
});

test('ensureSupportedHostNodeVersion enforces bundled runtime minimums', () => {
  assert.deepEqual(ensureSupportedHostNodeVersion('v20.0.0'), {
    ok: true,
    message: `IDE host Node version v20.0.0 satisfies bundled MCP requirement ${MIN_HOST_NODE_VERSION.major}.${MIN_HOST_NODE_VERSION.minor}.${MIN_HOST_NODE_VERSION.patch}+ .`,
  });
  assert.equal(ensureSupportedHostNodeVersion('v18.19.1').ok, false);
  assert.match(
    ensureSupportedHostNodeVersion('definitely-not-a-version').message,
    /Unable to parse IDE host Node version/,
  );
});

test('buildBundledLaunchSpec wires bundled runtime paths and server env', () => {
  const spec = buildBundledLaunchSpec({
    serverEntry: 'C:\\bundle\\dist\\cli\\index.js',
    webUiDir: 'C:\\bundle\\web-ui',
    extensionRoot: 'C:\\bundle',
    globalStoragePath: 'C:\\Users\\me\\AppData\\Roaming\\Code\\AgentChatBus',
    hostNodeExecutable: 'C:\\Program Files\\Microsoft VS Code\\Code.exe-node',
    serverUrl: 'https://127.0.0.1',
    cliWorkspacePath: 'C:\\Users\\me\\src\\project-a',
    msgWaitMinTimeoutMs: 45000,
    enforceMsgWaitMinTimeout: true,
    processEnv: { PATH: 'C:\\Windows\\System32' },
  });

  assert.equal(spec.command, 'C:\\Program Files\\Microsoft VS Code\\Code.exe-node');
  assert.deepEqual(spec.args, ['C:\\bundle\\dist\\cli\\index.js', 'serve']);
  assert.equal(spec.cwd, 'C:\\bundle');
  assert.equal(spec.launchMode, 'bundled-ts-service');
  assert.equal(spec.resolvedBy, BUNDLED_RUNTIME_RESOLVED_BY);
  assert.equal(spec.env.PATH, 'C:\\Windows\\System32');
  assert.equal(spec.env.AGENTCHATBUS_HOST, '127.0.0.1');
  assert.equal(spec.env.AGENTCHATBUS_PORT, '443');
  assert.equal(
    spec.env.AGENTCHATBUS_DB,
    path.join('C:\\Users\\me\\AppData\\Roaming\\Code\\AgentChatBus', 'bus-ts.db'),
  );
  assert.equal(
    spec.env.AGENTCHATBUS_CONFIG_FILE,
    path.join('C:\\Users\\me\\AppData\\Roaming\\Code\\AgentChatBus', 'config.json'),
  );
  assert.equal(spec.env.AGENTCHATBUS_APP_DIR, 'C:\\Users\\me\\AppData\\Roaming\\Code\\AgentChatBus');
  assert.equal(spec.env.AGENTCHATBUS_WEB_UI_DIR, 'C:\\bundle\\web-ui');
  assert.equal(spec.env.AGENTCHATBUS_CLI_WORKSPACE, 'C:\\Users\\me\\src\\project-a');
  assert.equal(spec.env.AGENTCHATBUS_WAIT_MIN_TIMEOUT_MS, '45000');
  assert.equal(spec.env.AGENTCHATBUS_ENFORCE_MSG_WAIT_MIN_TIMEOUT, '1');
});

test('buildWorkspaceDevLaunchSpec wires local tsx watcher and dev env', () => {
  const spec = buildWorkspaceDevLaunchSpec({
    tsxCliEntrypoint: 'C:\\repo\\agentchatbus-ts\\node_modules\\tsx\\dist\\cli.mjs',
    tsServerRoot: 'C:\\repo\\agentchatbus-ts',
    webUiDir: 'C:\\repo\\web-ui',
    globalStoragePath: 'C:\\Users\\me\\AppData\\Roaming\\Code\\AgentChatBus',
    hostNodeExecutable: 'C:\\Program Files\\Microsoft VS Code\\Code.exe-node',
    serverUrl: 'http://127.0.0.1:39766',
    cliWorkspacePath: 'C:\\repo',
    msgWaitMinTimeoutMs: 1500,
    enforceMsgWaitMinTimeout: false,
    processEnv: { PATH: 'C:\\Windows\\System32' },
  });

  assert.equal(spec.command, 'C:\\Program Files\\Microsoft VS Code\\Code.exe-node');
  assert.deepEqual(spec.args, [
    'C:\\repo\\agentchatbus-ts\\node_modules\\tsx\\dist\\cli.mjs',
    'watch',
    'src/cli/index.ts',
    'serve',
  ]);
  assert.equal(spec.cwd, 'C:\\repo\\agentchatbus-ts');
  assert.equal(spec.launchMode, 'workspace-dev-service');
  assert.equal(spec.resolvedBy, WORKSPACE_DEV_RUNTIME_RESOLVED_BY);
  assert.equal(spec.env.PATH, 'C:\\Windows\\System32');
  assert.equal(spec.env.AGENTCHATBUS_HOST, '127.0.0.1');
  assert.equal(spec.env.AGENTCHATBUS_PORT, '39766');
  assert.equal(spec.env.AGENTCHATBUS_WEB_UI_DIR, 'C:\\repo\\web-ui');
  assert.equal(spec.env.AGENTCHATBUS_CLI_WORKSPACE, 'C:\\repo');
  assert.equal(spec.env.AGENTCHATBUS_WAIT_MIN_TIMEOUT_MS, '1500');
  assert.equal(spec.env.AGENTCHATBUS_ENFORCE_MSG_WAIT_MIN_TIMEOUT, '0');
  assert.equal(spec.env.AGENTCHATBUS_RELOAD, '1');
  assert.equal(spec.env.AGENTCHATBUS_WORKSPACE_DEV, '1');
  assert.equal(
    spec.env.AGENTCHATBUS_DB,
    path.join('C:\\Users\\me\\AppData\\Roaming\\Code\\AgentChatBus', 'bus-ts.db'),
  );
});

test('describeStartupProbeFailure reports timeout, HTTP, and generic probe errors', () => {
  assert.equal(
    describeStartupProbeFailure('health', { timedOut: true, timeoutMs: 1000 }),
    'Startup probe /health timed out after 1000ms.',
  );
  assert.equal(
    describeStartupProbeFailure('metrics', { status: 503 }),
    'Startup probe /api/metrics returned HTTP 503.',
  );
  assert.equal(
    describeStartupProbeFailure('health', { error: 'socket hang up' }),
    'Startup probe /health failed: socket hang up.',
  );
});

test('resolveStartupProbeResult prefers /health when both probes succeed', () => {
  const health = { engine: 'node', version: '0.2.14', runtime: 'node v22.22.1' };
  const metrics = { engine: 'node', version: '0.2.14', runtime: 'node v22.22.1' };

  assert.deepEqual(
    resolveStartupProbeResult({
      health: { ok: true, payload: health },
      metrics: { ok: true, payload: metrics },
    }),
    {
      ok: true,
      source: 'health',
      payload: health,
      failureMessages: [],
    },
  );
});

test('resolveStartupProbeResult falls back to /api/metrics when /health is unavailable', () => {
  const metrics = { engine: 'node', version: '0.2.14', runtime: 'node v22.22.1' };

  assert.deepEqual(
    resolveStartupProbeResult({
      health: { ok: false, timedOut: true, timeoutMs: 1000 },
      metrics: { ok: true, payload: metrics },
    }),
    {
      ok: true,
      source: 'metrics',
      payload: metrics,
      failureMessages: ['Startup probe /health timed out after 1000ms.'],
    },
  );
});

test('resolveStartupProbeResult reports both probe failures when no readiness signal is available', () => {
  assert.deepEqual(
    resolveStartupProbeResult({
      health: { ok: false, status: 404 },
      metrics: { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:39765' },
    }),
    {
      ok: false,
      source: null,
      payload: undefined,
      failureMessages: [
        'Startup probe /health returned HTTP 404.',
        'Startup probe /api/metrics failed: connect ECONNREFUSED 127.0.0.1:39765.',
      ],
    },
  );
});

test('createSingleFlightRunner coalesces concurrent calls and resets after completion', async () => {
  let invocations = 0;
  let releaseFirstRun;
  const firstRunReleased = new Promise((resolve) => {
    releaseFirstRun = resolve;
  });

  const runOnce = createSingleFlightRunner(async () => {
    invocations += 1;
    await firstRunReleased;
    return invocations;
  });

  const first = runOnce();
  const second = runOnce();

  assert.equal(invocations, 1);
  assert.strictEqual(first, second);

  releaseFirstRun();

  assert.equal(await first, 1);
  assert.equal(await second, 1);

  const third = runOnce();
  assert.notStrictEqual(third, first);
  assert.equal(await third, 2);
  assert.equal(invocations, 2);
});
