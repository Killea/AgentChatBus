import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../../../src/static/js/components/acb-agent-status-item.js';

describe('acb-agent-status-item', () => {
  let element;

  beforeEach(() => {
    element = document.createElement('acb-agent-status-item');
    document.body.appendChild(element);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('should display agent status indicator', () => {
    const testData = {
      avatarEmoji: '😊',
      stateEmoji: '🟢',
      label: 'Agent A',
      state: 'online',
      offlineDisplay: '',
      isLongOffline: false,
      escapeHtml: (v) => String(v ?? ""),
    };

    element.setData(testData);

    expect(element.innerHTML).toContain('😊');
    expect(element.innerHTML).toContain('🟢');
    expect(element.innerHTML).toContain('online');
  });

  it('should display compressed character when offline for long time', () => {
    const testData = {
      avatarEmoji: '😊',
      stateEmoji: '⚪',
      label: 'Agent A',
      state: 'offline',
      isLongOffline: true,
      compressedChar: 'A',
      escapeHtml: (v) => String(v ?? ""),
    };

    element.setData(testData);

    expect(element.innerHTML).toContain('A');
    expect(element.innerHTML).not.toContain('online');
  });

  it('should include vertical line separator', () => {
    const testData = {
      avatarEmoji: '😊',
      stateEmoji: '🟢',
      label: 'Agent A',
      state: 'online',
      offlineDisplay: '',
      isLongOffline: false,
      escapeHtml: (v) => String(v ?? ""),
    };

    element.setData(testData);

    expect(element.innerHTML).toContain('|');
  });
});
