const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendSetupLogStep,
  createInitialSetupSteps,
  formatSetupStepLabel,
  replaceSetupSteps,
} = require('../out/logic/testExports');

test('createInitialSetupSteps seeds the startup step with play icon', () => {
  assert.deepEqual(createInitialSetupSteps(), [
    {
      label: 'Starting AgentChatBus...',
      icon: 'play',
    },
  ]);
});

test('appendSetupLogStep preserves previous steps and adds description/icon metadata', () => {
  const next = appendSetupLogStep(
    createInitialSetupSteps(),
    'Detected bundled runtime',
    'check',
    'Ready to launch',
  );

  assert.deepEqual(next, [
    {
      label: 'Starting AgentChatBus...',
      icon: 'play',
    },
    {
      label: 'Detected bundled runtime',
      icon: 'check',
      description: 'Ready to launch',
    },
  ]);
});

test('replaceSetupSteps copies step metadata without mutating caller-owned objects', () => {
  const steps = [
    { label: 'A', icon: 'a', description: 'first' },
    { label: 'B' },
  ];
  const replaced = replaceSetupSteps(steps);

  assert.deepEqual(replaced, steps);
  assert.notStrictEqual(replaced, steps);
});

test('formatSetupStepLabel keeps the elapsed-time prefix stable', () => {
  assert.equal(
    formatSetupStepLabel('Launching server', 1000, 3456),
    '[2.5s] Launching server',
  );
});
