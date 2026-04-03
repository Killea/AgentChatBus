/**
 * shared-search.js — UI-02: Full-text search for AgentChatBus
 *
 * Exposes window.AcbSearch with:
 *   init()     — call once after DOM ready
 *   toggle()   — open/close search bar
 *   open()     — open search bar
 *   close()    — close and clear search
 *   rebuild()  — rebuild Fuse.js index from current #messages DOM (call after new messages load)
 *
 * Scopes:
 *   "current"  — client-side Fuse.js search on loaded messages
 *   "all"      — backend FTS5 via GET /api/search
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  let _isOpen = false;
  let _fuseIndex = null;
  let _fuseItems = [];     // [{seq, author, content, el}]
  let _matchEls = [];      // matching .msg-row elements (current-thread mode)
  let _allResults = [];    // backend results (all-threads mode)
  let _currentIdx = 0;
  let _scope = 'current';  // 'current' | 'all'
  let _fields = new Set(['content']); // active pill fields
  let _debounceTimer = null;

  // ── DOM refs (resolved after init) ────────────────────────────────────────
  let _bar, _input, _counter, _prevBtn, _nextBtn, _closeBtn;
  let _pillContent, _pillAuthor, _pillMeta, _scopeCurrent, _scopeAll;
  let _allResultsPanel;

  // ── Public API ─────────────────────────────────────────────────────────────
  window.AcbSearch = {
    init,
    toggle,
    open,
    close,
    rebuild,
  };

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    _bar = document.getElementById('search-bar');
    _input = document.getElementById('search-input');
    _counter = document.getElementById('search-counter');
    _prevBtn = document.getElementById('search-prev');
    _nextBtn = document.getElementById('search-next');
    _closeBtn = document.getElementById('search-close');
    _pillContent = document.getElementById('pill-content');
    _pillAuthor = document.getElementById('pill-author');
    _pillMeta = document.getElementById('pill-meta');
    _scopeCurrent = document.getElementById('scope-current');
    _scopeAll = document.getElementById('scope-all');
    _allResultsPanel = document.getElementById('search-all-results');

    if (!_bar || !_input) return;

    _input.addEventListener('input', _onInput);
    _closeBtn && _closeBtn.addEventListener('click', close);
    _prevBtn && _prevBtn.addEventListener('click', _prevMatch);
    _nextBtn && _nextBtn.addEventListener('click', _nextMatch);

    _pillContent && _pillContent.addEventListener('click', () => _togglePill('content', _pillContent));
    _pillAuthor && _pillAuthor.addEventListener('click', () => _togglePill('author', _pillAuthor));
    _pillMeta && _pillMeta.addEventListener('click', () => _togglePill('metadata', _pillMeta));

    _scopeCurrent && _scopeCurrent.addEventListener('click', () => _setScope('current'));
    _scopeAll && _scopeAll.addEventListener('click', () => _setScope('all'));

    // Ctrl+F / Cmd+F — attempt to intercept (best-effort, some browsers block this)
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        toggle();
      }
      if (e.key === 'Escape' && _isOpen) {
        close();
      }
    });
  }

  // ── Toggle / open / close ─────────────────────────────────────────────────
  function toggle() {
    _isOpen ? close() : open();
  }

  function open() {
    if (!_bar) return;
    _isOpen = true;
    _bar.classList.add('visible');
    // Mark search button as active
    const btn = document.getElementById('search-toggle-btn');
    if (btn) btn.classList.add('active');
    setTimeout(() => _input && _input.focus(), 50);
    rebuild();
  }

  function close() {
    if (!_bar) return;
    _isOpen = false;
    _bar.classList.remove('visible');
    const btn = document.getElementById('search-toggle-btn');
    if (btn) btn.classList.remove('active');
    _clearHighlights();
    _clearAllResults();
    if (_input) _input.value = '';
    _setCounter(0, 0);
  }

  // ── Index rebuild ─────────────────────────────────────────────────────────
  function rebuild() {
    if (typeof Fuse === 'undefined') return;

    const messages = document.querySelectorAll('#messages .msg-row');
    _fuseItems = [];

    messages.forEach((el) => {
      const authorEl = el.querySelector('.msg-author-label');
      const bubbleEl = el.querySelector('.bubble-v2');
      const metaEl = el.querySelector('acb-message-tail-meta');

      _fuseItems.push({
        seq: el.dataset.seq || '',
        author: authorEl ? authorEl.textContent.trim() : '',
        content: bubbleEl ? bubbleEl.textContent.trim() : '',
        metadata: metaEl ? metaEl.textContent.trim() : '',
        el,
      });
    });

    _buildFuseIndex();
  }

  function _buildFuseIndex() {
    if (typeof Fuse === 'undefined' || _fuseItems.length === 0) return;

    const keys = _getActiveKeys();
    _fuseIndex = new Fuse(_fuseItems, {
      keys,
      threshold: 0.3,
      includeMatches: true,
      ignoreLocation: true,
      minMatchCharLength: 2,
    });
  }

  function _getActiveKeys() {
    const keys = [];
    if (_fields.has('content')) keys.push('content');
    if (_fields.has('author')) keys.push('author');
    if (_fields.has('metadata')) keys.push('metadata');
    return keys.length > 0 ? keys : ['content'];
  }

  // ── Input handler (debounced) ─────────────────────────────────────────────
  function _onInput() {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(_runSearch, 300);
  }

  function _runSearch() {
    const q = _input ? _input.value.trim() : '';
    _clearHighlights();
    _clearAllResults();
    _currentIdx = 0;

    if (!q) {
      _setCounter(0, 0);
      return;
    }

    if (_scope === 'all') {
      _runBackendSearch(q);
    } else {
      _runClientSearch(q);
    }
  }

  // ── Client-side search (Fuse.js) ──────────────────────────────────────────
  function _runClientSearch(q) {
    if (!_fuseIndex) {
      rebuild();
      if (!_fuseIndex) return;
    }

    const results = _fuseIndex.search(q);
    _matchEls = results.map((r) => r.item.el);

    _applyHighlights(results, q);
    _setCounter(_matchEls.length > 0 ? 1 : 0, _matchEls.length);

    if (_matchEls.length > 0) {
      _currentIdx = 0;
      _scrollToMatch(0);
    }
  }

  // ── Backend search (FTS5) ─────────────────────────────────────────────────
  async function _runBackendSearch(q) {
    try {
      const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=50`);
      if (!resp.ok) return;
      const data = await resp.json();
      _allResults = data.results || [];
      _showAllResults(_allResults, q);
      _setCounter(_allResults.length > 0 ? 1 : 0, _allResults.length);
    } catch (e) {
      console.warn('[AcbSearch] Backend search failed:', e);
    }
  }

  // ── Highlight (current-thread mode) ───────────────────────────────────────
  function _applyHighlights(fuseResults, q) {
    const matchedEls = new Set(fuseResults.map((r) => r.item.el));

    document.querySelectorAll('#messages .msg-row').forEach((el) => {
      if (matchedEls.has(el)) {
        el.classList.add('search-highlight');
        el.classList.remove('search-dim');
        _markText(el, q);
      } else {
        el.classList.add('search-dim');
        el.classList.remove('search-highlight');
      }
    });

    // Mark first match as active
    if (_matchEls.length > 0) {
      _matchEls[0].classList.add('search-match-active');
    }
  }

  function _markText(el, q) {
    const bubble = el.querySelector('.bubble-v2');
    if (!bubble) return;

    // Only highlight text nodes to avoid breaking HTML structure
    const terms = q.split(/\s+/).filter(Boolean);
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);

    nodes.forEach((textNode) => {
      let text = textNode.textContent;
      let matched = false;
      terms.forEach((term) => {
        const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        if (re.test(text)) matched = true;
        text = text.replace(re, '<mark class="search-match">$1</mark>');
      });
      if (matched) {
        const span = document.createElement('span');
        span.innerHTML = text;
        textNode.parentNode.replaceChild(span, textNode);
      }
    });
  }

  function _clearHighlights() {
    document.querySelectorAll('#messages .msg-row').forEach((el) => {
      el.classList.remove('search-highlight', 'search-dim', 'search-match-active');
    });
    // Remove <mark> wrappers by restoring text
    document.querySelectorAll('#messages .search-match').forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      }
    });
    // Remove the span wrappers added by _markText (normalize parent elements)
    document.querySelectorAll('#messages .bubble-v2 span').forEach((span) => {
      if (span.querySelector('.search-match') === null && span.className === '') {
        const parent = span.parentNode;
        if (parent) {
          while (span.firstChild) parent.insertBefore(span.firstChild, span);
          parent.removeChild(span);
          parent.normalize();
        }
      }
    });
    _matchEls = [];
  }

  // ── Navigation prev/next ──────────────────────────────────────────────────
  function _prevMatch() {
    if (_scope === 'all') {
      _navigateAllResults(-1);
      return;
    }
    if (_matchEls.length === 0) return;
    _matchEls[_currentIdx].classList.remove('search-match-active');
    _currentIdx = (_currentIdx - 1 + _matchEls.length) % _matchEls.length;
    _matchEls[_currentIdx].classList.add('search-match-active');
    _scrollToMatch(_currentIdx);
    _setCounter(_currentIdx + 1, _matchEls.length);
  }

  function _nextMatch() {
    if (_scope === 'all') {
      _navigateAllResults(1);
      return;
    }
    if (_matchEls.length === 0) return;
    _matchEls[_currentIdx].classList.remove('search-match-active');
    _currentIdx = (_currentIdx + 1) % _matchEls.length;
    _matchEls[_currentIdx].classList.add('search-match-active');
    _scrollToMatch(_currentIdx);
    _setCounter(_currentIdx + 1, _matchEls.length);
  }

  function _scrollToMatch(idx) {
    if (_matchEls[idx]) {
      _matchEls[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ── All-threads results panel ─────────────────────────────────────────────
  function _showAllResults(results, q) {
    if (!_allResultsPanel) return;
    _allResultsPanel.innerHTML = '';

    if (results.length === 0) {
      _allResultsPanel.innerHTML = '<div class="search-no-results">No results found</div>';
      _allResultsPanel.classList.add('visible');
      return;
    }

    results.forEach((r, idx) => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      if (idx === 0) item.classList.add('search-result-active');
      item.innerHTML = `
        <div class="search-result-topic">${_escapeHtml(r.thread_topic)}</div>
        <div class="search-result-meta">${_escapeHtml(r.author)} · seq ${r.seq}</div>
        <div class="search-result-snippet">${r.snippet}</div>
      `;
      item.addEventListener('click', () => _navigateToResult(r));
      _allResultsPanel.appendChild(item);
    });

    _allResultsPanel.classList.add('visible');
  }

  function _navigateAllResults(delta) {
    if (_allResults.length === 0) return;
    const items = _allResultsPanel.querySelectorAll('.search-result-item');
    items[_currentIdx] && items[_currentIdx].classList.remove('search-result-active');
    _currentIdx = (_currentIdx + delta + _allResults.length) % _allResults.length;
    items[_currentIdx] && items[_currentIdx].classList.add('search-result-active');
    items[_currentIdx] && items[_currentIdx].scrollIntoView({ block: 'nearest' });
    _setCounter(_currentIdx + 1, _allResults.length);
  }

  function _navigateToResult(r) {
    close();
    _clearAllResults();

    // Use the global selectThread function exposed by index.html
    if (typeof window.selectThread === 'function') {
      window.selectThread(r.thread_id, r.thread_topic || '', 'active').then(() => {
        // After the thread loads, scroll to the matched message
        _pendingScrollSeq = r.seq;
        _trySrollToPendingSeq();
      }).catch(() => {});
      return;
    }

    // Fallback: click the thread item in the sidebar if visible
    const pane = document.getElementById('thread-pane');
    if (!pane) return;
    const threadItem = pane.querySelector(`[data-thread-id="${r.thread_id}"]`);
    if (threadItem) {
      _pendingScrollSeq = r.seq;
      threadItem.click();
    }
  }

  let _pendingScrollSeq = null;

  function _trySrollToPendingSeq() {
    if (_pendingScrollSeq == null) return;
    const seq = _pendingScrollSeq;
    // Poll for message element up to 2s
    let attempts = 0;
    const poll = setInterval(() => {
      const el = document.querySelector(`[data-seq="${seq}"]`);
      if (el) {
        clearInterval(poll);
        _pendingScrollSeq = null;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.closest('.msg-row')?.classList.add('search-match-active');
        setTimeout(() => el.closest('.msg-row')?.classList.remove('search-match-active'), 2000);
      } else if (++attempts > 20) {
        clearInterval(poll);
        _pendingScrollSeq = null;
      }
    }, 100);
  }

  function _clearAllResults() {
    if (_allResultsPanel) {
      _allResultsPanel.innerHTML = '';
      _allResultsPanel.classList.remove('visible');
    }
    _allResults = [];
    _currentIdx = 0;
  }

  // ── Pills & scope ─────────────────────────────────────────────────────────
  function _togglePill(field, btn) {
    if (_fields.has(field)) {
      // Always keep at least one field active
      if (_fields.size === 1) return;
      _fields.delete(field);
      btn.classList.remove('active');
    } else {
      _fields.add(field);
      btn.classList.add('active');
    }
    _buildFuseIndex();
    _runSearch();
  }

  function _setScope(scope) {
    _scope = scope;
    if (_scopeCurrent) _scopeCurrent.classList.toggle('active', scope === 'current');
    if (_scopeAll) _scopeAll.classList.toggle('active', scope === 'all');
    _clearHighlights();
    _clearAllResults();
    _runSearch();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _setCounter(current, total) {
    if (!_counter) return;
    if (total === 0) {
      _counter.textContent = _input && _input.value.trim() ? '0 results' : '';
    } else {
      _counter.textContent = `${current}/${total}`;
    }
  }

  function _escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
