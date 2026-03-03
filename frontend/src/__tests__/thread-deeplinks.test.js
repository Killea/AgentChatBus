import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * UI-11 - Thread Deeplinks (hash-based)
 *
 * Tests for the three behaviours added to index.html:
 *   1. selectThread writes #thread=<id> to location.hash
 *   2. restoreThreadFromHash reads hash at boot and calls selectThread via GET /api/threads list
 *   3. hashchange listener calls selectThread when hash changes
 *
 * NOTE: GET /api/threads/{id} does not exist in the ACB API.
 * Restoration uses GET /api/threads?include_archived=1&limit=500 and filters by id client-side.
 */

// ---------------------------------------------------------------------------
// Helpers extracted from index.html (same logic, testable in isolation)
// ---------------------------------------------------------------------------

function makeDeeplinkHelpers({ api, selectThread }) {
  function writeHashOnSelect(id) {
    history.replaceState(null, '', '#thread=' + encodeURIComponent(id));
  }

  async function restoreThreadFromHash() {
    const m = location.hash.match(/^#thread=(.+)$/);
    if (!m) return;
    const id = decodeURIComponent(m[1]);
    try {
      const response = await api(`/api/threads?include_archived=1&limit=500`);
      const t = (response.threads || []).find((th) => th.id === id);
      if (t) selectThread(t.id, t.topic, t.status);
      else history.replaceState(null, '', location.pathname);
    } catch (_) {
      history.replaceState(null, '', location.pathname);
    }
  }

  function attachHashChangeListener() {
    window.addEventListener('hashchange', async () => {
      const m = location.hash.match(/^#thread=(.+)$/);
      if (!m) return;
      const id = decodeURIComponent(m[1]);
      try {
        const response = await api(`/api/threads?include_archived=1&limit=500`);
        const t = (response.threads || []).find((th) => th.id === id);
        if (t) selectThread(t.id, t.topic, t.status);
        else history.replaceState(null, '', location.pathname);
      } catch (_) {
        history.replaceState(null, '', location.pathname);
      }
    });
  }

  return { writeHashOnSelect, restoreThreadFromHash, attachHashChangeListener };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UI-11 Thread Deeplinks', () => {
  let apiMock;
  let selectThreadMock;
  let helpers;

  const THREAD_LIST = {
    threads: [
      { id: 'abc-123', topic: 'My Thread', status: 'active' },
      { id: 'xyz-456', topic: 'Another Thread', status: 'closed' },
    ],
    total: 2,
    has_more: false,
    next_cursor: null,
  };

  beforeEach(() => {
    apiMock = vi.fn();
    selectThreadMock = vi.fn();
    helpers = makeDeeplinkHelpers({ api: apiMock, selectThread: selectThreadMock });

    // Reset hash before each test
    history.replaceState(null, '', location.pathname);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    history.replaceState(null, '', location.pathname);
  });

  // -------------------------------------------------------------------------
  // 1. writeHashOnSelect
  // -------------------------------------------------------------------------
  describe('writeHashOnSelect()', () => {
    it('sets location.hash to #thread=<id>', () => {
      helpers.writeHashOnSelect('abc-123');
      expect(location.hash).toBe('#thread=abc-123');
    });

    it('encodes special characters in the id', () => {
      helpers.writeHashOnSelect('id with spaces');
      expect(location.hash).toBe('#thread=id%20with%20spaces');
    });
  });

  // -------------------------------------------------------------------------
  // 2. restoreThreadFromHash — uses GET /api/threads list
  // -------------------------------------------------------------------------
  describe('restoreThreadFromHash()', () => {
    it('calls api with list endpoint and selectThread when hash contains a valid thread id', async () => {
      apiMock.mockResolvedValue(THREAD_LIST);
      history.replaceState(null, '', '#thread=abc-123');

      await helpers.restoreThreadFromHash();

      expect(apiMock).toHaveBeenCalledWith('/api/threads?include_archived=1&limit=500');
      expect(selectThreadMock).toHaveBeenCalledWith('abc-123', 'My Thread', 'active');
    });

    it('does nothing when hash is absent', async () => {
      await helpers.restoreThreadFromHash();

      expect(apiMock).not.toHaveBeenCalled();
      expect(selectThreadMock).not.toHaveBeenCalled();
    });

    it('does nothing when hash has a different format', async () => {
      history.replaceState(null, '', '#something-else');

      await helpers.restoreThreadFromHash();

      expect(apiMock).not.toHaveBeenCalled();
      expect(selectThreadMock).not.toHaveBeenCalled();
    });

    it('clears hash silently when thread id is not found in list', async () => {
      apiMock.mockResolvedValue({ threads: [], total: 0, has_more: false, next_cursor: null });
      history.replaceState(null, '', '#thread=unknown-id');

      await helpers.restoreThreadFromHash();

      expect(selectThreadMock).not.toHaveBeenCalled();
      expect(location.hash).toBe('');
    });

    it('clears hash silently when api throws', async () => {
      apiMock.mockRejectedValue(new Error('Network error'));
      history.replaceState(null, '', '#thread=abc-123');

      await helpers.restoreThreadFromHash();

      expect(selectThreadMock).not.toHaveBeenCalled();
      expect(location.hash).toBe('');
    });

    it('handles missing threads array in api response gracefully', async () => {
      apiMock.mockResolvedValue({});
      history.replaceState(null, '', '#thread=abc-123');

      await helpers.restoreThreadFromHash();

      expect(selectThreadMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 3. hashchange listener
  // -------------------------------------------------------------------------
  describe('hashchange listener', () => {
    it('calls api and selectThread when hashchange fires with a valid thread hash', async () => {
      apiMock.mockResolvedValue(THREAD_LIST);
      helpers.attachHashChangeListener();

      history.replaceState(null, '', '#thread=xyz-456');
      window.dispatchEvent(new HashChangeEvent('hashchange'));

      // Wait for the async handler to settle
      await new Promise((r) => setTimeout(r, 0));

      expect(apiMock).toHaveBeenCalledWith('/api/threads?include_archived=1&limit=500');
      expect(selectThreadMock).toHaveBeenCalledWith('xyz-456', 'Another Thread', 'closed');
    });

    it('clears hash when thread not found during hashchange', async () => {
      apiMock.mockResolvedValue({ threads: [] });
      helpers.attachHashChangeListener();

      history.replaceState(null, '', '#thread=bad-id');
      window.dispatchEvent(new HashChangeEvent('hashchange'));

      await new Promise((r) => setTimeout(r, 0));

      expect(selectThreadMock).not.toHaveBeenCalled();
      expect(location.hash).toBe('');
    });

    it('clears hash when api throws during hashchange', async () => {
      apiMock.mockRejectedValue(new Error('404'));
      helpers.attachHashChangeListener();

      history.replaceState(null, '', '#thread=bad-id');
      window.dispatchEvent(new HashChangeEvent('hashchange'));

      await new Promise((r) => setTimeout(r, 0));

      expect(selectThreadMock).not.toHaveBeenCalled();
      expect(location.hash).toBe('');
    });
  });
});
