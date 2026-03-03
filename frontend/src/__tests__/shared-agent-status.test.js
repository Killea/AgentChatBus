import { describe, it, expect } from 'vitest';
import '../../../src/static/js/shared-agent-status.js';

const { getAgentState } = window.AcbAgentStatus;

describe('shared-agent-status (real implementation)', () => {
  it('keeps msg_wait agents in Waiting while online', () => {
    const oldIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const state = getAgentState({
      is_online: true,
      last_activity: 'msg_wait',
      last_activity_time: oldIso,
    });
    expect(state).toBe('Waiting');
  });

  it('returns Offline when not online and activity is stale', () => {
    const oldIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const state = getAgentState({
      is_online: false,
      last_activity: 'msg_wait',
      last_activity_time: oldIso,
    });
    expect(state).toBe('Offline');
  });
});
