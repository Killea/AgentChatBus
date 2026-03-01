import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../../../src/static/js/shared-chat.js';

describe('shared-chat (real implementation)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('handleKey', () => {
    it('sends message on Enter without Shift', () => {
      const sendMessageFn = vi.fn();
      const preventDefault = vi.fn();
      const e = { key: 'Enter', shiftKey: false, preventDefault };

      window.AcbChat.handleKey(e, sendMessageFn);

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(sendMessageFn).toHaveBeenCalledTimes(1);
    });

    it('does not send message on Shift+Enter', () => {
      const sendMessageFn = vi.fn();
      const preventDefault = vi.fn();
      const e = { key: 'Enter', shiftKey: true, preventDefault };

      window.AcbChat.handleKey(e, sendMessageFn);

      expect(preventDefault).not.toHaveBeenCalled();
      expect(sendMessageFn).not.toHaveBeenCalled();
    });
  });

  describe('loadNewMessages', () => {
    it('loads new messages and updates activity + cursor', async () => {
      const appendBubble = vi.fn();
      const updateOnlinePresence = vi.fn();
      const updateStatusBar = vi.fn(async () => {});
      const scrollBottom = vi.fn();
      const recordThreadAgentActivity = vi.fn();

      let lastSeq = 5;
      const setLastSeq = vi.fn((updater) => {
        if (typeof updater === 'function') {
          lastSeq = updater(lastSeq);
        } else {
          lastSeq = updater;
        }
      });

      const messages = [
        { id: 'm6', seq: 6, author: 'agent-a', created_at: '2026-02-28T12:00:00.000Z' },
        { id: 'm7', seq: 7, author: 'agent-b', created_at: '2026-02-28T12:01:00.000Z' },
      ];

      const api = vi.fn(async () => messages);

      await window.AcbChat.loadNewMessages({
        getActiveThreadId: () => 'thread-a',
        getLastSeq: () => lastSeq,
        api,
        getAgentPresenceKey: (m) => m.author,
        getAgentDisplayName: (m) => m.author,
        recordThreadAgentActivity,
        appendBubble,
        updateOnlinePresence,
        updateStatusBar,
        setLastSeq,
        scrollBottom,
      });

      expect(api).toHaveBeenCalledWith('/api/threads/thread-a/messages?after_seq=5&limit=100');
      expect(recordThreadAgentActivity).toHaveBeenCalledTimes(2);
      expect(appendBubble).toHaveBeenCalledTimes(2);
      expect(updateOnlinePresence).toHaveBeenCalledTimes(1);
      expect(updateStatusBar).toHaveBeenCalledTimes(1);
      expect(lastSeq).toBe(7);
      expect(scrollBottom).toHaveBeenCalledWith(true);
    });

    it('returns early when there is no active thread', async () => {
      const api = vi.fn();

      await window.AcbChat.loadNewMessages({
        getActiveThreadId: () => '',
        getLastSeq: () => 0,
        api,
        getAgentPresenceKey: () => null,
        getAgentDisplayName: () => '',
        recordThreadAgentActivity: vi.fn(),
        appendBubble: vi.fn(),
        updateOnlinePresence: vi.fn(),
        updateStatusBar: vi.fn(async () => {}),
        setLastSeq: vi.fn(),
        scrollBottom: vi.fn(),
      });

      expect(api).not.toHaveBeenCalled();
    });
  });

  describe('selectThread', () => {
    it('loads history and updates active thread UI state', async () => {
      document.body.innerHTML = `
        <div id="ti-thread-a" class="thread-item"></div>
        <div id="ti-thread-b" class="thread-item active"></div>
        <div id="thread-header" style="display:none"></div>
        <div id="thread-title"></div>
        <div id="compose"></div>
        <div id="messages"></div>
      `;

      const setActiveThread = vi.fn();
      const clearThreadParticipants = vi.fn();
      const rebuildActiveThreadParticipants = vi.fn();
      const appendBubble = vi.fn();
      const updateOnlinePresence = vi.fn();
      const updateStatusBar = vi.fn(async () => {});
      const scrollBottom = vi.fn();

      const setLastSeq = vi.fn();
      const api = vi.fn(async () => [
        { id: 'm1', seq: 1, content: 'hello' },
        { id: 'm2', seq: 2, content: 'world' },
      ]);

      await window.AcbChat.selectThread({
        id: 'thread-a',
        topic: 'Topic A',
        status: 'discuss',
        setActiveThread,
        clearThreadParticipants,
        api,
        rebuildActiveThreadParticipants,
        appendBubble,
        updateOnlinePresence,
        updateStatusBar,
        setLastSeq,
        scrollBottom,
      });

      expect(setActiveThread).toHaveBeenCalledWith('thread-a', 'discuss');
      expect(setLastSeq).toHaveBeenCalledWith(0);
      expect(setLastSeq).toHaveBeenCalledWith(2);
      expect(clearThreadParticipants).toHaveBeenCalledTimes(1);
      expect(rebuildActiveThreadParticipants).toHaveBeenCalledTimes(1);
      expect(appendBubble).toHaveBeenCalledTimes(2);
      expect(updateOnlinePresence).toHaveBeenCalledTimes(1);
      expect(updateStatusBar).toHaveBeenCalledTimes(1);
      expect(scrollBottom).toHaveBeenCalledWith(false);

      expect(document.getElementById('ti-thread-a')?.classList.contains('active')).toBe(true);
      expect(document.getElementById('thread-header')?.style.display).toBe('flex');
      expect(document.getElementById('thread-title')?.textContent).toBe('Topic A');
      expect(document.getElementById('compose')?.classList.contains('visible')).toBe(true);
      expect(document.getElementById('messages')?.classList.contains('loading-history')).toBe(false);
    });
  });
});
