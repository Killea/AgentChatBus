const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterAndSortAgents,
  getAgentActivityTimestamp,
  getRelativeTimeString,
  filterAndSortThreads,
  getThreadStatusIconFileName,
} = require('../out/logic/testExports');

test('filterAndSortAgents keeps online stale agents and sorts online-first by recency', () => {
  const nowMs = Date.parse('2026-03-20T12:00:00Z');
  const agents = [
    {
      id: 'offline-recent',
      is_online: false,
      last_heartbeat: '2026-03-20T11:45:00Z',
    },
    {
      id: 'online-stale',
      is_online: true,
      last_heartbeat: '2026-03-20T08:00:00Z',
    },
    {
      id: 'online-recent',
      is_online: true,
      last_activity_time: '2026-03-20T11:59:00Z',
      last_heartbeat: '2026-03-20T11:58:00Z',
    },
    {
      id: 'offline-stale',
      is_online: false,
      last_heartbeat: '2026-03-20T09:00:00Z',
    },
  ];

  const ordered = filterAndSortAgents(agents, { showOnlyRecent: true, nowMs });
  assert.deepEqual(
    ordered.map((agent) => agent.id),
    ['online-recent', 'online-stale', 'offline-recent'],
  );
});

test('filterAndSortAgents can disable recent filtering and respects last_activity_time precedence', () => {
  const nowMs = Date.parse('2026-03-20T12:00:00Z');
  const agents = [
    {
      id: 'a',
      is_online: false,
      last_activity_time: '2026-03-20T11:30:00Z',
      last_heartbeat: '2026-03-20T10:00:00Z',
    },
    {
      id: 'b',
      is_online: false,
      last_heartbeat: '2026-03-20T11:45:00Z',
    },
  ];

  const ordered = filterAndSortAgents(agents, { showOnlyRecent: false, nowMs });
  assert.deepEqual(ordered.map((agent) => agent.id), ['b', 'a']);
  assert.equal(getAgentActivityTimestamp(agents[0]), Date.parse('2026-03-20T11:30:00Z'));
});

test('getRelativeTimeString formats recent, hourly, and daily ranges', () => {
  const nowMs = Date.parse('2026-03-20T12:00:00Z');
  assert.equal(getRelativeTimeString(new Date('2026-03-20T11:59:40Z'), nowMs), 'just now');
  assert.equal(getRelativeTimeString(new Date('2026-03-20T11:15:00Z'), nowMs), '45m ago');
  assert.equal(getRelativeTimeString(new Date('2026-03-20T09:00:00Z'), nowMs), '3h ago');
  assert.equal(getRelativeTimeString(new Date('2026-03-18T12:00:00Z'), nowMs), '2d ago');
});

test('filterAndSortThreads filters statuses and sorts newest-first', () => {
  const threads = [
    { id: 'older', topic: 'Older', status: 'discuss', created_at: '2026-03-20T10:00:00Z' },
    { id: 'archived', topic: 'Archived', status: 'archived', created_at: '2026-03-20T12:00:00Z' },
    { id: 'newer', topic: 'Newer', status: 'review', created_at: '2026-03-20T11:00:00Z' },
  ];

  const ordered = filterAndSortThreads(threads, ['discuss', 'review']);
  assert.deepEqual(ordered.map((thread) => thread.id), ['newer', 'older']);
});

test('getThreadStatusIconFileName maps known and fallback statuses', () => {
  assert.equal(getThreadStatusIconFileName('implement'), 'thread-implement.svg');
  assert.equal(getThreadStatusIconFileName('archived'), 'thread-archived.svg');
  assert.equal(getThreadStatusIconFileName('unknown'), 'thread-discuss.svg');
});
