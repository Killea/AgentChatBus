import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * UI-07 - Message Navigation Sidebar (Emoji Minimap)
 * Scrollable column to the right of the chat area.
 */

const STORAGE_KEY = 'acb-minimap-enabled';

function makeNavSidebar({ document, localStorage }) {
  let _observer = null;

  function isEnabled() {
    const val = localStorage.getItem(STORAGE_KEY);
    return val === null ? true : val === 'true';
  }

  function applyEnabledState() {
    document.body.classList.toggle('minimap-hidden', !isEnabled());
  }

  function setEnabled(enabled) {
    localStorage.setItem(STORAGE_KEY, String(enabled));
    document.body.classList.toggle('minimap-hidden', !enabled);
  }

  function buildSidebar() {
    const sidebar = document.getElementById('nav-sidebar');
    const messagesEl = document.getElementById('messages-scroll');
    const messagesInner = document.getElementById('messages');
    if (!sidebar || !messagesEl || !messagesInner) return;

    if (_observer) { _observer.disconnect(); _observer = null; }
    sidebar.innerHTML = '';

    const rows = messagesInner.querySelectorAll('.msg-row[data-seq]');
    if (rows.length === 0) {
      sidebar.classList.add('nav-sidebar-empty');
      return;
    }
    sidebar.classList.remove('nav-sidebar-empty');

    rows.forEach((row) => {
      const seq = row.getAttribute('data-seq');
      const authorId = row.getAttribute('data-author-id') || 'unknown';
      const avatarEl = row.querySelector('.msg-avatar');
      const emoji = avatarEl ? avatarEl.textContent.trim() : '💬';
      const authorNameEl = row.querySelector('.msg-author-label');
      const authorName = authorNameEl ? authorNameEl.textContent.trim() : authorId;

      const entry = document.createElement('button');
      entry.className = 'nav-entry';
      entry.setAttribute('data-seq', seq);
      entry.setAttribute('data-author-id', authorId);
      entry.setAttribute('title', authorName);
      entry.innerHTML =
        `<span class="nav-entry-emoji">${emoji}</span>` +
        `<span class="nav-entry-meta"><span class="nav-entry-name">${authorName}</span></span>`;

      entry.addEventListener('click', () => {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('nav-highlight');
        setTimeout(() => row.classList.remove('nav-highlight'), 1200);
      });

      sidebar.appendChild(entry);
    });
  }

  return {
    isEnabled, applyEnabledState, setEnabled,
    rebuild: buildSidebar, onNewMessage: buildSidebar,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDOM(document) {
  const messagesWrap = document.createElement('div');
  messagesWrap.id = 'messages-wrap';

  const messagesScroll = document.createElement('div');
  messagesScroll.id = 'messages-scroll';

  const messagesEl = document.createElement('div');
  messagesEl.id = 'messages';
  messagesScroll.appendChild(messagesEl);
  messagesWrap.appendChild(messagesScroll);

  const sidebar = document.createElement('nav');
  sidebar.id = 'nav-sidebar';
  messagesWrap.appendChild(sidebar);

  document.body.appendChild(messagesWrap);
  return { messagesEl, sidebar };
}

function addRow(messagesEl, { seq, authorId, authorName, emoji = '🤖' }) {
  const row = document.createElement('div');
  row.className = 'msg-row';
  row.setAttribute('data-seq', String(seq));
  row.setAttribute('data-author-id', authorId);
  const avatar = document.createElement('span');
  avatar.className = 'msg-avatar';
  avatar.textContent = emoji;
  row.appendChild(avatar);
  const label = document.createElement('span');
  label.className = 'msg-author-label';
  label.textContent = authorName;
  row.appendChild(label);
  messagesEl.appendChild(row);
  return row;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UI-07 — Nav Sidebar (Emoji Minimap)', () => {
  let nav;
  let localStorageMock;

  beforeEach(() => {
    document.body.className = '';
    document.body.innerHTML = '';
    const store = {};
    localStorageMock = {
      getItem: vi.fn((k) => store[k] ?? null),
      setItem: vi.fn((k, v) => { store[k] = v; }),
      _store: store,
    };
    nav = makeNavSidebar({ document, localStorage: localStorageMock });
  });

  afterEach(() => vi.clearAllMocks());

  it('isEnabled() returns true by default', () => {
    expect(nav.isEnabled()).toBe(true);
  });

  it('isEnabled() returns false when localStorage is "false"', () => {
    localStorageMock._store[STORAGE_KEY] = 'false';
    expect(nav.isEnabled()).toBe(false);
  });

  it('applyEnabledState() adds minimap-hidden when disabled', () => {
    localStorageMock._store[STORAGE_KEY] = 'false';
    nav.applyEnabledState();
    expect(document.body.classList.contains('minimap-hidden')).toBe(true);
  });

  it('applyEnabledState() removes minimap-hidden when enabled', () => {
    document.body.classList.add('minimap-hidden');
    localStorageMock._store[STORAGE_KEY] = 'true';
    nav.applyEnabledState();
    expect(document.body.classList.contains('minimap-hidden')).toBe(false);
  });

  it('setEnabled(false) writes localStorage and adds minimap-hidden', () => {
    nav.setEnabled(false);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(STORAGE_KEY, 'false');
    expect(document.body.classList.contains('minimap-hidden')).toBe(true);
  });

  it('setEnabled(true) removes minimap-hidden', () => {
    document.body.classList.add('minimap-hidden');
    nav.setEnabled(true);
    expect(document.body.classList.contains('minimap-hidden')).toBe(false);
  });

  it('rebuild() creates one .nav-entry per .msg-row', () => {
    const { messagesEl } = createDOM(document);
    addRow(messagesEl, { seq: 1, authorId: 'a', authorName: 'Agent A', emoji: '🤖' });
    addRow(messagesEl, { seq: 2, authorId: 'b', authorName: 'Human', emoji: '👤' });
    addRow(messagesEl, { seq: 3, authorId: 'a', authorName: 'Agent A', emoji: '🤖' });
    nav.rebuild();
    expect(document.querySelectorAll('.nav-entry')).toHaveLength(3);
  });

  it('entries carry correct data-seq, data-author-id, and emoji', () => {
    const { messagesEl } = createDOM(document);
    addRow(messagesEl, { seq: 5, authorId: 'x', authorName: 'X', emoji: '🧠' });
    nav.rebuild();
    const entry = document.querySelector('.nav-entry');
    expect(entry.getAttribute('data-seq')).toBe('5');
    expect(entry.getAttribute('data-author-id')).toBe('x');
    expect(entry.querySelector('.nav-entry-emoji').textContent).toBe('🧠');
  });

  it('empty thread adds nav-sidebar-empty class', () => {
    const { sidebar } = createDOM(document);
    nav.rebuild();
    expect(sidebar.classList.contains('nav-sidebar-empty')).toBe(true);
  });

  it('non-empty thread removes nav-sidebar-empty class', () => {
    const { messagesEl, sidebar } = createDOM(document);
    sidebar.classList.add('nav-sidebar-empty');
    addRow(messagesEl, { seq: 1, authorId: 'a', authorName: 'A' });
    nav.rebuild();
    expect(sidebar.classList.contains('nav-sidebar-empty')).toBe(false);
  });

  it('click on entry calls scrollIntoView on the msg-row', () => {
    const { messagesEl } = createDOM(document);
    const row = addRow(messagesEl, { seq: 7, authorId: 'b', authorName: 'B', emoji: '🤖' });
    row.scrollIntoView = vi.fn();
    nav.rebuild();
    document.querySelector('.nav-entry[data-seq="7"]').click();
    expect(row.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('fallback emoji 💬 when no .msg-avatar', () => {
    const { messagesEl } = createDOM(document);
    const row = document.createElement('div');
    row.className = 'msg-row';
    row.setAttribute('data-seq', '1');
    row.setAttribute('data-author-id', 'x');
    messagesEl.appendChild(row);
    nav.rebuild();
    expect(document.querySelector('.nav-entry .nav-entry-emoji').textContent).toBe('💬');
  });

  it('onNewMessage() adds entries for new messages', () => {
    const { messagesEl } = createDOM(document);
    addRow(messagesEl, { seq: 1, authorId: 'a', authorName: 'A' });
    nav.onNewMessage();
    expect(document.querySelectorAll('.nav-entry')).toHaveLength(1);
    addRow(messagesEl, { seq: 2, authorId: 'b', authorName: 'B' });
    nav.onNewMessage();
    expect(document.querySelectorAll('.nav-entry')).toHaveLength(2);
  });

  it('rebuild() clears previous entries before rebuilding', () => {
    const { messagesEl } = createDOM(document);
    addRow(messagesEl, { seq: 1, authorId: 'a', authorName: 'A' });
    nav.rebuild();
    nav.rebuild();
    expect(document.querySelectorAll('.nav-entry')).toHaveLength(1);
  });
});
