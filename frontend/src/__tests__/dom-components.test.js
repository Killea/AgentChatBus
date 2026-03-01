import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../../../src/static/js/components/acb-modal-shell.js';

describe('Web Component: acb-modal-shell', () => {
  let element;

  beforeEach(() => {
    element = document.createElement('acb-modal-shell');
    document.body.appendChild(element);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('registers custom element', () => {
    expect(customElements.get('acb-modal-shell')).toBeTruthy();
    expect(element.tagName).toBe('ACB-MODAL-SHELL');
  });

  it('renders create thread modal structure on connect', () => {
    const overlay = element.querySelector('#modal-overlay');
    const modal = element.querySelector('#modal');
    const topicInput = element.querySelector('#modal-topic');

    expect(overlay).toBeTruthy();
    expect(modal).toBeTruthy();
    expect(topicInput?.getAttribute('placeholder')).toBe('Thread topic...');
    expect(modal?.querySelector('h3')?.textContent).toContain('Create New Thread');
  });

  it('renders settings modal hidden by default', () => {
    const settingsOverlay = element.querySelector('#settings-modal-overlay');
    const hostInput = element.querySelector('#setting-host');
    const portInput = element.querySelector('#setting-port');

    expect(settingsOverlay).toBeTruthy();
    expect(settingsOverlay?.getAttribute('style')).toContain('display:none');
    expect(hostInput).toBeTruthy();
    expect(portInput?.getAttribute('type')).toBe('number');
  });

  it('keeps existing DOM when connectedCallback runs again', () => {
    const htmlBefore = element.innerHTML;

    // connectedCallback should no-op once content already exists.
    element.connectedCallback();

    expect(element.innerHTML).toBe(htmlBefore);
  });
});
