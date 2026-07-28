import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../../../web-ui/js/shared-split-view.js';

const { parseThreadHash, writeThreadHash } = window.AcbSplitView;

function makeDeeplinkHelpers({ api, selectThread, enterCompare }) {
  async function restoreFromHash() {
    const { threadId, compareId } = parseThreadHash();
    if (!threadId) {
      return;
    }
    try {
      const response = await api('/api/threads?include_archived=1&limit=500');
      const thread = (response.threads || []).find((item) => item.id === threadId);
      if (!thread) {
        writeThreadHash({ threadId: null, compareId: compareId || null });
        return;
      }
      await selectThread(thread.id, thread.topic, thread.status);
      const normalizedCompareId = String(compareId || '').trim();
      if (
        normalizedCompareId &&
        normalizedCompareId !== thread.id &&
        typeof enterCompare === 'function'
      ) {
        const compareThread = (response.threads || []).find((item) => item.id === normalizedCompareId);
        if (compareThread) {
          await enterCompare(compareThread.id, compareThread.topic);
        }
      }
    } catch {
      writeThreadHash({ threadId: null, compareId: null });
    }
  }

  function attachHashChangeListener() {
    window.addEventListener('hashchange', () => {
      void restoreFromHash();
    });
  }

  return { restoreFromHash, attachHashChangeListener, writeHashOnSelect: writeThreadHash };
}

describe('UI-11/UI-04 Thread Deeplinks', () => {
  let apiMock;
  let selectThreadMock;
  let enterCompareMock;
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
    selectThreadMock = vi.fn().mockResolvedValue(undefined);
    enterCompareMock = vi.fn().mockResolvedValue(undefined);
    helpers = makeDeeplinkHelpers({
      api: apiMock,
      selectThread: selectThreadMock,
      enterCompare: enterCompareMock,
    });
    history.replaceState(null, '', location.pathname);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    history.replaceState(null, '', location.pathname);
  });

  describe('writeHashOnSelect', () => {
    it('sets location.hash to #thread=<id>', () => {
      helpers.writeHashOnSelect({ threadId: 'abc-123', compareId: null });
      expect(location.hash).toBe('#thread=abc-123');
    });

    it('encodes special characters in the id', () => {
      helpers.writeHashOnSelect({ threadId: 'id with spaces', compareId: null });
      expect(location.hash).toBe('#thread=id+with+spaces');
    });

    it('writes compare param when provided', () => {
      helpers.writeHashOnSelect({ threadId: 'abc', compareId: 'xyz' });
      expect(location.hash).toBe('#thread=abc&compare=xyz');
    });
  });

  describe('restoreFromHash', () => {
    it('calls api and selectThread when hash contains a valid thread id', async () => {
      apiMock.mockResolvedValue(THREAD_LIST);
      history.replaceState(null, '', '#thread=abc-123');

      await helpers.restoreFromHash();

      expect(apiMock).toHaveBeenCalledWith('/api/threads?include_archived=1&limit=500');
      expect(selectThreadMock).toHaveBeenCalledWith('abc-123', 'My Thread', 'active');
      expect(enterCompareMock).not.toHaveBeenCalled();
    });

    it('restores compare thread when hash includes compare param', async () => {
      apiMock.mockResolvedValue(THREAD_LIST);
      history.replaceState(null, '', '#thread=abc-123&compare=xyz-456');

      await helpers.restoreFromHash();

      expect(selectThreadMock).toHaveBeenCalledWith('abc-123', 'My Thread', 'active');
      expect(enterCompareMock).toHaveBeenCalledWith('xyz-456', 'Another Thread');
    });

    it('does not treat compare param as part of thread id', async () => {
      apiMock.mockResolvedValue(THREAD_LIST);
      history.replaceState(null, '', '#thread=abc-123&compare=xyz-456');

      await helpers.restoreFromHash();

      expect(selectThreadMock).not.toHaveBeenCalledWith('abc-123&compare=xyz-456', expect.anything(), expect.anything());
    });

    it('does nothing when hash is absent', async () => {
      await helpers.restoreFromHash();
      expect(apiMock).not.toHaveBeenCalled();
      expect(selectThreadMock).not.toHaveBeenCalled();
    });

    it('clears primary hash when thread id is not found', async () => {
      apiMock.mockResolvedValue({ threads: [], total: 0, has_more: false, next_cursor: null });
      history.replaceState(null, '', '#thread=unknown-id&compare=xyz-456');

      await helpers.restoreFromHash();

      expect(selectThreadMock).not.toHaveBeenCalled();
      expect(location.hash).toBe('#compare=xyz-456');
    });
  });

  describe('hashchange listener', () => {
    it('calls api and selectThread when hashchange fires with a valid thread hash', async () => {
      apiMock.mockResolvedValue(THREAD_LIST);
      helpers.attachHashChangeListener();

      history.replaceState(null, '', '#thread=xyz-456');
      window.dispatchEvent(new HashChangeEvent('hashchange'));

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(apiMock).toHaveBeenCalledWith('/api/threads?include_archived=1&limit=500');
      expect(selectThreadMock).toHaveBeenCalledWith('xyz-456', 'Another Thread', 'closed');
    });

    it('restores compare when hash updated with compare param', async () => {
      apiMock.mockResolvedValue(THREAD_LIST);
      helpers.attachHashChangeListener();

      history.replaceState(null, '', '#thread=abc-123&compare=xyz-456');
      window.dispatchEvent(new HashChangeEvent('hashchange'));

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(enterCompareMock).toHaveBeenCalledWith('xyz-456', 'Another Thread');
    });
  });
});
