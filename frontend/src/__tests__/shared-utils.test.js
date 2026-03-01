import { describe, it, expect } from 'vitest';
import '../../../src/static/js/shared-utils.js';

const { escapeHtml, esc, fmtTime, timeAgo, authorColor, getAgentAvatarEmoji } = window.AcbUtils;

describe('shared-utils (real implementation)', () => {
  it('escapeHtml escapes special characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
    expect(escapeHtml("Tom & Jerry")).toBe('Tom &amp; Jerry');
  });

  it('esc escapes minimal HTML and normalizes nullish input', () => {
    expect(esc('<b>A & B</b>')).toBe('&lt;b&gt;A &amp; B&lt;/b&gt;');
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('fmtTime formats ISO timestamp and handles empty input', () => {
    expect(fmtTime('')).toBe('');
    expect(fmtTime(null)).toBe('');

    const result = fmtTime('2026-02-28T09:05:00.000Z');
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });

  it('timeAgo returns relative string for recent timestamps', () => {
    const justNowIso = new Date(Date.now() - 20 * 1000).toISOString();
    const twoMinutesAgoIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    expect(timeAgo(justNowIso)).toBe('just now');
    expect(timeAgo(twoMinutesAgoIso)).toBe('2m ago');
  });

  it('authorColor is deterministic and preserves reserved colors', () => {
    expect(authorColor('human')).toBe('#fb923c');
    expect(authorColor('system')).toBe('#fbbf24');
    expect(authorColor('agent-a')).toBe(authorColor('agent-a'));
  });

  it('getAgentAvatarEmoji is deterministic and handles reserved identities', () => {
    expect(getAgentAvatarEmoji('human')).toBe('👤');
    expect(getAgentAvatarEmoji('system')).toBe('⚙️');

    const avatar1 = getAgentAvatarEmoji('agent-a');
    const avatar2 = getAgentAvatarEmoji({ id: 'agent-a' });
    expect(avatar1).toBeTruthy();
    expect(avatar2).toBeTruthy();
  });
});
