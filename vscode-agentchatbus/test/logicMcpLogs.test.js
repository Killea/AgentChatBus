const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendLogLines,
  getMcpLogPresentation,
  getMcpLogRows,
} = require('../out/logic/testExports');

test('getMcpLogRows shows external-service placeholder when unmanaged and empty', () => {
  assert.deepEqual(getMcpLogRows([], false, null), [
    {
      message: 'Ready (Managed Externally)',
      index: -1,
      description: 'Extension is reading logs from the shared AgentChatBus log API.',
      iconId: 'info',
      colorId: 'descriptionForeground',
    },
  ]);
});

test('getMcpLogRows shows waiting placeholder when managed and empty', () => {
  assert.deepEqual(getMcpLogRows([], true, 'ignored'), [
    {
      message: 'Waiting for logs...',
      index: -2,
      iconId: 'sync~spin',
    },
  ]);
});

test('appendLogLines splits CRLF input, drops blanks, and keeps only the newest lines', () => {
  const existing = Array.from({ length: 499 }, (_, index) => `old-${index + 1}`);
  const appended = appendLogLines(existing, 'alpha\r\n\r\nbeta\n');

  assert.equal(appended.length, 500);
  assert.equal(appended[0], 'old-2');
  assert.equal(appended[498], 'alpha');
  assert.equal(appended[499], 'beta');
});

test('getMcpLogPresentation keeps error, warning, startup, and neutral line classification stable', () => {
  assert.deepEqual(getMcpLogPresentation('ERROR failed to boot', 0), {
    iconId: 'error',
    colorId: 'errorForeground',
  });
  assert.deepEqual(getMcpLogPresentation('WARNING slow startup', 1), {
    iconId: 'warning',
    colorId: 'problemsWarningIcon.foreground',
  });
  assert.deepEqual(getMcpLogPresentation('Starting bundled server', 2), {
    iconId: 'terminal',
  });
  assert.deepEqual(getMcpLogPresentation('ordinary line', 3), {});
});
