import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../../../web-ui/js/shared-split-view.js';

const {
  parseThreadHash,
  writeThreadHash,
  shouldCompareOnShiftClick,
  shouldRefreshCompare,
  isCompareViewportOk,
  saveCompareThread,
  loadCompareThread,
  clearCompareThreadStorage,
  enterCompare,
  exitCompare,
  getCompareThreadId,
  isCompareMode,
} = window.AcbSplitView;

describe('UI-04 Split-view', () => {
  beforeEach(() => {
    history.replaceState(null, '', location.pathname);
    clearCompareThreadStorage();
    document.body.innerHTML = `
      <div id="main"></div>
      <div id="compare-panel" hidden></div>
      <div id="compare-banner" hidden></div>
      <div id="compare-panel-title"></div>
      <div id="compare-messages"></div>
      <div id="compare-sys-prompt-area"></div>
      <div id="compare-messages-scroll"></div>
      <div id="messages"></div>
      <div id="sys-prompt-area"></div>
      <div id="messages-scroll"></div>
    `;
  });

  afterEach(() => {
    history.replaceState(null, '', location.pathname);
    clearCompareThreadStorage();
    vi.restoreAllMocks();
  });

  describe('parseThreadHash / writeThreadHash', () => {
    it('parses thread-only hash', () => {
      expect(parseThreadHash('#thread=abc-123')).toEqual({
        threadId: 'abc-123',
        compareId: '',
      });
    });

    it('parses thread and compare params', () => {
      expect(parseThreadHash('#thread=abc&compare=xyz')).toEqual({
        threadId: 'abc',
        compareId: 'xyz',
      });
    });

    it('parses encoded ids without double-decoding', () => {
      history.replaceState(null, '', '#thread=id%20with%20spaces&compare=other%2Bid');
      expect(parseThreadHash()).toEqual({
        threadId: 'id with spaces',
        compareId: 'other+id',
      });
    });

    it('returns empty ids for empty hash', () => {
      expect(parseThreadHash('')).toEqual({ threadId: '', compareId: '' });
      expect(parseThreadHash('#')).toEqual({ threadId: '', compareId: '' });
    });

    it('writes thread-only hash', () => {
      writeThreadHash({ threadId: 'abc-123', compareId: null });
      expect(location.hash).toBe('#thread=abc-123');
    });

    it('writes thread and compare hash', () => {
      writeThreadHash({ threadId: 'abc', compareId: 'xyz' });
      expect(location.hash).toBe('#thread=abc&compare=xyz');
    });

    it('clears hash when both ids are empty', () => {
      history.replaceState(null, '', '#thread=old');
      writeThreadHash({ threadId: null, compareId: null });
      expect(location.hash).toBe('');
    });

    it('does not throw on malformed percent sequences', () => {
      expect(() => parseThreadHash('#thread=abc%')).not.toThrow();
    });
  });

  describe('compare localStorage', () => {
    it('saves and loads compare thread', () => {
      saveCompareThread('thread-b', 'Topic B');
      expect(loadCompareThread()).toEqual({ id: 'thread-b', topic: 'Topic B' });
    });

    it('clears compare thread storage', () => {
      saveCompareThread('thread-b', 'Topic B');
      clearCompareThreadStorage();
      expect(loadCompareThread()).toBeNull();
    });
  });

  describe('enterCompare guards', () => {
    it('rejects compare when id matches active thread', async () => {
      const result = await enterCompare('same-id', {
        activeThreadId: 'same-id',
        onLoadTranscript: vi.fn(),
      });
      expect(result).toBe(false);
      expect(isCompareMode()).toBe(false);
    });

    it('enters compare for distinct ids when viewport is wide enough', async () => {
      vi.spyOn(window.AcbSplitView, 'isCompareViewportOk').mockReturnValue(true);
      const onLoadTranscript = vi.fn().mockResolvedValue(undefined);
      const result = await enterCompare('compare-id', {
        activeThreadId: 'primary-id',
        topic: 'Compare topic',
        onLoadTranscript,
      });
      expect(result).toBe(true);
      expect(getCompareThreadId()).toBe('compare-id');
      expect(onLoadTranscript).toHaveBeenCalledWith('compare-id');
      expect(location.hash).toBe('#thread=primary-id&compare=compare-id');
    });
  });

  describe('exitCompare', () => {
    it('clears compare state and hash compare param', async () => {
      vi.spyOn(window.AcbSplitView, 'isCompareViewportOk').mockReturnValue(true);
      await enterCompare('compare-id', {
        activeThreadId: 'primary-id',
        onLoadTranscript: vi.fn().mockResolvedValue(undefined),
      });
      await exitCompare({ activeThreadId: 'primary-id' });
      expect(isCompareMode()).toBe(false);
      expect(location.hash).toBe('#thread=primary-id');
      expect(loadCompareThread()).toBeNull();
    });
  });

  describe('shift-click routing helper', () => {
    it('returns true only for shift-click on a different active thread', () => {
      expect(shouldCompareOnShiftClick('a', 'b', true)).toBe(true);
      expect(shouldCompareOnShiftClick('a', 'a', true)).toBe(false);
      expect(shouldCompareOnShiftClick('a', 'b', false)).toBe(false);
      expect(shouldCompareOnShiftClick('', 'b', true)).toBe(false);
    });
  });

  describe('shouldRefreshCompare', () => {
    it('matches compare thread id only', () => {
      expect(shouldRefreshCompare('compare-1', 'compare-1')).toBe(true);
      expect(shouldRefreshCompare('other', 'compare-1')).toBe(false);
      expect(shouldRefreshCompare('compare-1', '')).toBe(false);
    });
  });

  describe('viewport guard', () => {
    it('reports narrow viewport as blocked', () => {
      const originalInnerWidth = window.innerWidth;
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 800,
      });
      expect(isCompareViewportOk()).toBe(false);
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth,
      });
    });
  });
});
