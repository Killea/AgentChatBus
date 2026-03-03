import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../../../src/static/js/shared-utils.js';
import '../../../src/static/js/shared-message-renderer.js';

/**
 * Reproduces the appendBubble() logic for system messages (seq=0 path)
 * as implemented in src/static/index.html.
 * Kept in sync with the implementation — if appendBubble changes, update here too.
 */
function appendSystemPromptBubble(box, m) {
  // Deduplication: skip if already in DOM
  const seq = String(m.seq);
  const existing = box.querySelector(`[data-seq="${seq}"]`);
  if (existing) return;

  if (m.role === 'system' && m.author === 'system') {
    if (m.seq === 0) {
      const wrapper = document.createElement('div');
      wrapper.className = 'msg-sys-prompt';
      wrapper.setAttribute('data-seq', '0');

      const promptHeader = document.createElement('button');
      promptHeader.type = 'button';
      promptHeader.className = 'msg-sys-prompt-header';
          promptHeader.setAttribute('aria-expanded', 'true');
          promptHeader.classList.add('is-expanded');
          promptHeader.innerHTML = `<span class="msg-sys-prompt-label">Thread Instructions (system)</span><span class="msg-sys-prompt-chevron">&#9650;</span>`;

      const promptBody = document.createElement('div');
      promptBody.className = 'msg-sys-prompt-body bubble-v2';
      window.AcbMessageRenderer.renderMessageContent(promptBody, m.content, null);

          promptHeader.addEventListener('click', () => {
            const expanded = promptHeader.getAttribute('aria-expanded') === 'true';
            promptHeader.setAttribute('aria-expanded', String(!expanded));
            promptHeader.classList.toggle('is-expanded', !expanded);
            promptBody.classList.toggle('collapsed', expanded);
            promptHeader.querySelector('.msg-sys-prompt-chevron').innerHTML = expanded ? '&#9660;' : '&#9650;';
            promptHeader.querySelector('.msg-sys-prompt-label').textContent = expanded
              ? 'Thread Instructions (system) — click to expand'
              : 'Thread Instructions (system)';
          });

      wrapper.appendChild(promptHeader);
      wrapper.appendChild(promptBody);
      box.appendChild(wrapper);
    } else {
      const pill = document.createElement('div');
      pill.className = 'msg-sys-event';
      pill.textContent = m.content;
      box.appendChild(pill);
    }
    return;
  }
}

describe('system prompt bubble rendering (UI-06)', () => {
  let box;

  beforeEach(() => {
    box = document.createElement('div');
    box.id = 'messages';
    document.body.appendChild(box);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const makeSystemPromptMsg = (content = '## Section\n\nHello **world**.') => ({
    id: 'sys-thread-1',
    seq: 0,
    role: 'system',
    author: 'system',
    content,
    created_at: '2026-03-02T10:00:00Z',
  });

  it('renders system prompt (seq=0) as collapsable bubble, not a pill', () => {
    appendSystemPromptBubble(box, makeSystemPromptMsg());

    expect(box.querySelector('.msg-sys-prompt')).not.toBeNull();
    expect(box.querySelector('.msg-sys-event')).toBeNull();
  });

  it('renders Markdown in system prompt body via renderMessageContent', () => {
    appendSystemPromptBubble(box, makeSystemPromptMsg('## Section Title\n\nHello **world**.'));

    const body = box.querySelector('.msg-sys-prompt-body');
    expect(body).not.toBeNull();
    // Markdown heading should be rendered as <h2>
    expect(body.querySelector('h2')).not.toBeNull();
    expect(body.querySelector('h2').textContent).toBe('Section Title');
    // Bold should be rendered as <strong>
    expect(body.querySelector('strong')).not.toBeNull();
  });

  it('is expanded by default (aria-expanded=true, is-expanded class, body not collapsed)', () => {
    appendSystemPromptBubble(box, makeSystemPromptMsg());

    const header = box.querySelector('.msg-sys-prompt-header');
    const body = box.querySelector('.msg-sys-prompt-body');

    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(header.classList.contains('is-expanded')).toBe(true);
    expect(body.classList.contains('collapsed')).toBe(false);
  });

  it('collapses on header click: aria-expanded=false, is-expanded removed, body collapsed, label updated', () => {
    appendSystemPromptBubble(box, makeSystemPromptMsg());

    const header = box.querySelector('.msg-sys-prompt-header');
    const body = box.querySelector('.msg-sys-prompt-body');
    const label = header.querySelector('.msg-sys-prompt-label');

    header.click();

    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.classList.contains('is-expanded')).toBe(false);
    expect(body.classList.contains('collapsed')).toBe(true);
    expect(label.textContent).toBe('Thread Instructions (system) \u2014 click to expand');
  });

  it('expands again on second click: is-expanded restored, label restored to default', () => {
    appendSystemPromptBubble(box, makeSystemPromptMsg());

    const header = box.querySelector('.msg-sys-prompt-header');
    const body = box.querySelector('.msg-sys-prompt-body');
    const label = header.querySelector('.msg-sys-prompt-label');

    header.click(); // collapse
    header.click(); // expand

    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(header.classList.contains('is-expanded')).toBe(true);
    expect(body.classList.contains('collapsed')).toBe(false);
    expect(label.textContent).toBe('Thread Instructions (system)');
  });

  it('renders non-zero-seq system event as centered pill (unchanged behaviour)', () => {
    const sysEvent = {
      id: 'sys-event-1',
      seq: 5,
      role: 'system',
      author: 'system',
      content: 'Thread status changed to: done',
      created_at: '2026-03-02T10:01:00Z',
    };

    appendSystemPromptBubble(box, sysEvent);

    expect(box.querySelector('.msg-sys-event')).not.toBeNull();
    expect(box.querySelector('.msg-sys-prompt')).toBeNull();
    expect(box.querySelector('.msg-sys-event').textContent).toBe('Thread status changed to: done');
  });

  it('deduplication: ignores second system prompt with same seq=0', () => {
    const msg = makeSystemPromptMsg();

    appendSystemPromptBubble(box, msg);
    appendSystemPromptBubble(box, msg); // second call — should be ignored

    const prompts = box.querySelectorAll('.msg-sys-prompt');
    expect(prompts.length).toBe(1);
  });
});
