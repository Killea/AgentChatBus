const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyServerUrlChange,
  buildEventsUrl,
  parseSseEventData,
  parseUiAgentRegistrationPayload,
} = require('../out/logic/testExports');

test('applyServerUrlChange clears cached auth and reconnects when the server URL changes', () => {
  const currentAuth = { agent_id: 'agent-1', token: 'token-1' };

  assert.deepEqual(
    applyServerUrlChange('http://127.0.0.1:39765', 'http://127.0.0.1:39766', currentAuth),
    {
      baseUrl: 'http://127.0.0.1:39766',
      uiAgentAuth: null,
      shouldReconnectSse: true,
    },
  );
});

test('applyServerUrlChange keeps cached auth when the base URL is unchanged', () => {
  const currentAuth = { agent_id: 'agent-1', token: 'token-1' };

  assert.deepEqual(
    applyServerUrlChange('http://127.0.0.1:39765', 'http://127.0.0.1:39765', currentAuth),
    {
      baseUrl: 'http://127.0.0.1:39765',
      uiAgentAuth: currentAuth,
      shouldReconnectSse: false,
    },
  );
});

test('parseUiAgentRegistrationPayload validates and normalizes registration payloads', () => {
  assert.deepEqual(parseUiAgentRegistrationPayload({ agent_id: 123, token: 'abc' }), {
    agent_id: '123',
    token: 'abc',
  });
  assert.throws(
    () => parseUiAgentRegistrationPayload({ token: 'abc' }),
    /Invalid UI agent registration payload/,
  );
});

test('buildEventsUrl and parseSseEventData keep SSE contracts narrow and predictable', () => {
  assert.equal(buildEventsUrl('http://127.0.0.1:39765'), 'http://127.0.0.1:39765/events');
  assert.deepEqual(parseSseEventData('{"type":"msg.new","seq":7}'), {
    ok: true,
    data: { type: 'msg.new', seq: 7 },
  });
  assert.equal(parseSseEventData('not-json').ok, false);
});
