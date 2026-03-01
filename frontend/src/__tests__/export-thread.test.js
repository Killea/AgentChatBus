import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../../../src/static/js/shared-threads.js';
import '../../../src/static/js/components/acb-thread-header.js';
import '../../../src/static/js/components/acb-thread-context-menu.js';

const { exportThread } = window.AcbThreads;

// ─────────────────────────────────────────────────────────────────────────────
// DOM / visual-structure tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Web Component: acb-thread-header — export button', () => {
  let element;

  beforeEach(() => {
    element = document.createElement('acb-thread-header');
    document.body.appendChild(element);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders export button in thread header', () => {
    const btn = element.querySelector('#export-thread-btn');
    expect(btn).toBeTruthy();
    expect(btn.tagName).toBe('BUTTON');
  });

  it('export button has correct aria-label', () => {
    const btn = element.querySelector('#export-thread-btn');
    expect(btn?.getAttribute('aria-label')).toBe('Export thread as Markdown');
  });

  it('export button has download SVG icon', () => {
    const btn = element.querySelector('#export-thread-btn');
    const svg = btn?.querySelector('svg');
    expect(svg).toBeTruthy();
  });
});

describe('Web Component: acb-thread-context-menu — Export .md item', () => {
  let element;

  beforeEach(() => {
    element = document.createElement('acb-thread-context-menu');
    document.body.appendChild(element);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders export item in context menu', () => {
    const btn = element.querySelector('#ctx-export');
    expect(btn).toBeTruthy();
    expect(btn.tagName).toBe('BUTTON');
  });

  it('context menu export item has correct text', () => {
    const btn = element.querySelector('#ctx-export');
    expect(btn?.textContent?.trim()).toBe('Export .md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Logic tests — exportThread()
// ─────────────────────────────────────────────────────────────────────────────

describe('exportThread()', () => {
  let fetchMock;
  let createObjectURLMock;
  let revokeObjectURLMock;
  let appendChildSpy;
  let removeChildSpy;
  let clickSpy;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;

    createObjectURLMock = vi.fn(() => 'blob:mock-url');
    revokeObjectURLMock = vi.fn();
    global.URL.createObjectURL = createObjectURLMock;
    global.URL.revokeObjectURL = revokeObjectURLMock;

    clickSpy = vi.fn();
    appendChildSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((el) => {
      if (el.tagName === 'A') {
        el.click = clickSpy;
      }
    });
    removeChildSpy = vi.spyOn(document.body, 'removeChild').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it('exportThread creates Blob and triggers download', async () => {
    const markdownContent = '# My Thread\n\n> **Status:** discuss\n';
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => markdownContent,
    });

    await exportThread({ threadId: 'thread-123', topic: 'My Thread' });

    expect(fetchMock).toHaveBeenCalledWith('/api/threads/thread-123/export');
    expect(createObjectURLMock).toHaveBeenCalledOnce();
    const blobArg = createObjectURLMock.mock.calls[0][0];
    expect(blobArg).toBeInstanceOf(Blob);
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-url');
  });

  it('exportThread uses slugified filename from topic', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => '# My Cool Thread\n',
    });

    let capturedHref = null;
    let capturedDownload = null;
    appendChildSpy.mockImplementation((el) => {
      if (el.tagName === 'A') {
        capturedHref = el.href;
        capturedDownload = el.download;
        el.click = clickSpy;
      }
    });

    await exportThread({ threadId: 'thread-abc', topic: 'My Cool Thread' });

    expect(capturedDownload).toBe('my-cool-thread.md');
  });

  it('exportThread handles fetch error gracefully', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('Network error'));

    await expect(exportThread({ threadId: 'thread-err', topic: 'Error Thread' })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    expect(createObjectURLMock).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
