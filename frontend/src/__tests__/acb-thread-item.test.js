import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../../../web-ui/js/components/acb-thread-item.js';

describe('acb-thread-item', () => {
  let element;

  beforeEach(() => {
    element = document.createElement('acb-thread-item');
    document.body.appendChild(element);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a visible pin icon for pinned threads', () => {
    element.setData({
      thread: {
        id: 'thread-1',
        topic: 'Pinned thread',
        status: 'discuss',
        created_at: new Date().toISOString(),
        isPinned: true,
        waiting_agents: [],
      },
      active: false,
      timeAgo: () => 'just now',
      esc: (value) => String(value ?? ''),
    });

    const pinBtn = element.querySelector('.ti-pin-btn');
    expect(pinBtn).not.toBeNull();
    expect(pinBtn.textContent).toBe('📌');
  });

  it('renders numeric waiting-agent badges instead of emoji', () => {
    element.setData({
      thread: {
        id: 'thread-2',
        topic: 'Busy thread',
        status: 'implement',
        created_at: new Date().toISOString(),
        isPinned: false,
        waiting_agents: [
          { id: 'a1', display_name: 'Alpha', emoji: '🤖' },
          { id: 'a2', display_name: 'Beta', emoji: '🧠' },
          { id: 'a3', display_name: 'Gamma', emoji: '🛠️' },
          { id: 'a4', display_name: 'Delta', emoji: '📦' },
        ],
      },
      active: false,
      timeAgo: () => 'just now',
      esc: (value) => String(value ?? ''),
    });

    const badges = Array.from(element.querySelectorAll('.ti-waiting-agent')).map((node) => node.textContent.trim());
    expect(badges).toEqual(['1', '2', '3', '+1']);
    expect(element.innerHTML).not.toContain('🤖');
    expect(element.innerHTML).not.toContain('🧠');
  });

  it('renders tag chips for tagged threads', () => {
    element.setData({
      thread: {
        id: 'thread-3',
        topic: 'Tagged thread',
        status: 'discuss',
        created_at: new Date().toISOString(),
        isPinned: false,
        waiting_agents: [],
        tags: ['feature-alpha', 'docs'],
      },
      active: false,
      timeAgo: () => 'just now',
      esc: (value) => String(value ?? ''),
      activeTagFilter: 'docs',
    });

    const tags = Array.from(element.querySelectorAll('.ti-tag')).map((node) => node.getAttribute('data-tag'));
    expect(tags).toEqual(['feature-alpha', 'docs']);
    expect(element.querySelector('.ti-tag.is-active')?.getAttribute('data-tag')).toBe('docs');
  });
});
