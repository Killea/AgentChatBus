const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatLmError,
  getBrowserOpenUrl,
  isLocalServerUrlWithContext,
} = require('../out/logic/testExports');

test('getBrowserOpenUrl rewrites wildcard bind addresses to localhost for browser use', () => {
  assert.equal(getBrowserOpenUrl('http://0.0.0.0:39765'), 'http://127.0.0.1:39765/');
  assert.equal(getBrowserOpenUrl('http://[::]:39765'), 'http://127.0.0.1:39765/');
  assert.equal(getBrowserOpenUrl('not a url'), 'not a url');
});

test('isLocalServerUrlWithContext recognizes localhost, hostname, and local interface IPs', () => {
  const context = {
    localHostName: 'devbox',
    localIps: ['192.168.1.20', 'fe80::1%en0', '::ffff:10.0.0.5'],
  };

  assert.equal(isLocalServerUrlWithContext('http://localhost:39765', context), true);
  assert.equal(isLocalServerUrlWithContext('http://devbox:39765', context), true);
  assert.equal(isLocalServerUrlWithContext('http://192.168.1.20:39765', context), true);
  assert.equal(isLocalServerUrlWithContext('http://10.0.0.5:39765', context), true);
  assert.equal(isLocalServerUrlWithContext('http://203.0.113.99:39765', context), false);
});

test('formatLmError keeps useful codes and messages', () => {
  assert.equal(formatLmError({ code: 'NoConsent', message: 'User denied access' }), 'NoConsent: User denied access');
  assert.equal(formatLmError({ name: 'ProbeError', message: 'No models' }), 'ProbeError: No models');
  assert.equal(formatLmError(new Error('boom')), 'boom');
  assert.equal(formatLmError(null), 'Unknown error');
});
