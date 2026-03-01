/**
 * Tests for UP-17: Structured message metadata — handoff badge + stop_reason tag rendering.
 *
 * Tests the CSS class and badge logic that would be applied in index.html
 * when rendering messages with metadata.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────
// Helpers — mirror the logic from index.html renderMessage()
// ─────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseMetadata(raw) {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function buildMetadataBadgesHtml(metaObj) {
  let html = '';
  if (!metaObj) return html;
  if (metaObj.handoff_target) {
    html += `<span class="handoff-badge" title="Handoff to: ${esc(metaObj.handoff_target)}">\u2192 ${esc(metaObj.handoff_target)}</span>`;
  }
  if (metaObj.stop_reason) {
    html += `<span class="stop-tag stop-tag-${esc(metaObj.stop_reason)}" title="Stop reason">${esc(metaObj.stop_reason)}</span>`;
  }
  return html;
}

function renderMessageRow(message) {
  const container = document.createElement('div');
  const metaObj = parseMetadata(message.metadata);
  const badgesHtml = buildMetadataBadgesHtml(metaObj);
  container.innerHTML = `
    <div class="msg-header">
      <span class="msg-author-label">${esc(message.author)}</span>
      <span class="msg-time-label">seq ${message.seq}</span>
      ${badgesHtml}
    </div>
    <div class="bubble-v2">${esc(message.content)}</div>
  `;
  return container;
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('structured metadata — handoff badge', () => {
  it('displays handoff-badge when metadata.handoff_target is set', () => {
    const row = renderMessageRow({
      author: 'agent-a',
      content: 'Handing off',
      seq: 5,
      metadata: JSON.stringify({ handoff_target: 'agent-b' }),
    });
    const badge = row.querySelector('.handoff-badge');
    expect(badge).not.toBeNull();
    expect(badge.textContent.trim()).toContain('agent-b');
  });

  it('does NOT render handoff-badge when no handoff_target', () => {
    const row = renderMessageRow({
      author: 'agent-a',
      content: 'Regular message',
      seq: 3,
      metadata: null,
    });
    expect(row.querySelector('.handoff-badge')).toBeNull();
  });

  it('handoff-badge title attribute contains the target agent ID', () => {
    const row = renderMessageRow({
      author: 'agent-a',
      content: 'Directing you',
      seq: 7,
      metadata: { handoff_target: 'specific-target' },
    });
    const badge = row.querySelector('.handoff-badge');
    expect(badge).not.toBeNull();
    expect(badge.getAttribute('title')).toContain('specific-target');
  });
});

describe('structured metadata — stop reason tag', () => {
  it('displays stop-tag when metadata.stop_reason is set', () => {
    const row = renderMessageRow({
      author: 'agent-a',
      content: 'Done',
      seq: 10,
      metadata: JSON.stringify({ stop_reason: 'convergence' }),
    });
    const tag = row.querySelector('.stop-tag');
    expect(tag).not.toBeNull();
    expect(tag.textContent.trim()).toBe('convergence');
  });

  it('stop-tag has the reason-specific class', () => {
    const reasons = ['convergence', 'timeout', 'error', 'complete', 'impasse'];
    for (const reason of reasons) {
      const row = renderMessageRow({
        author: 'agent-a',
        content: 'Stopping',
        seq: 1,
        metadata: { stop_reason: reason },
      });
      const tag = row.querySelector(`.stop-tag-${reason}`);
      expect(tag).not.toBeNull();
    }
  });

  it('does NOT render stop-tag when no stop_reason', () => {
    const row = renderMessageRow({
      author: 'agent-a',
      content: 'Regular',
      seq: 2,
      metadata: null,
    });
    expect(row.querySelector('.stop-tag')).toBeNull();
  });
});

describe('structured metadata — combined', () => {
  it('shows both handoff-badge and stop-tag when both are set', () => {
    const row = renderMessageRow({
      author: 'agent-a',
      content: 'Done and passing',
      seq: 8,
      metadata: { handoff_target: 'agent-b', stop_reason: 'complete' },
    });
    expect(row.querySelector('.handoff-badge')).not.toBeNull();
    expect(row.querySelector('.stop-tag')).not.toBeNull();
  });

  it('shows no badges when metadata is empty object', () => {
    const row = renderMessageRow({
      author: 'agent-a',
      content: 'Nothing special',
      seq: 9,
      metadata: {},
    });
    expect(row.querySelector('.handoff-badge')).toBeNull();
    expect(row.querySelector('.stop-tag')).toBeNull();
  });
});
