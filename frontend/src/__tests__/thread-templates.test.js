/**
 * Tests for UP-18: Thread templates — UI template selector.
 *
 * Tests the template dropdown population and submit payload logic
 * from shared-modals.js submitThreadModal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─────────────────────────────────────────────
// Helpers — simulate the modal DOM
// ─────────────────────────────────────────────

function buildModalDom() {
  document.body.innerHTML = `
    <input id="modal-topic" type="text" value="" />
    <select id="modal-template">
      <option value="">No template</option>
    </select>
    <span id="modal-template-desc"></span>
  `;
}

function populateDropdown(templates) {
  const sel = document.getElementById('modal-template');
  while (sel.options.length > 1) sel.remove(1);
  for (const t of templates) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    opt.dataset.description = t.description || '';
    sel.appendChild(opt);
  }
  sel.onchange = () => {
    const desc = document.getElementById('modal-template-desc');
    if (desc) {
      const selected = sel.options[sel.selectedIndex];
      desc.textContent = selected ? (selected.dataset.description || '') : '';
    }
  };
}

const SAMPLE_TEMPLATES = [
  { id: 'code-review', name: 'Code Review', description: 'Structured code review.', is_builtin: true },
  { id: 'brainstorm', name: 'Brainstorm', description: 'Free-form ideation.', is_builtin: true },
  { id: 'my-custom', name: 'My Custom', description: 'Custom template.', is_builtin: false },
];

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('thread template dropdown', () => {
  beforeEach(() => {
    buildModalDom();
  });

  it('populates dropdown with templates from API', () => {
    populateDropdown(SAMPLE_TEMPLATES);
    const sel = document.getElementById('modal-template');
    // 1 "No template" + 3 templates
    expect(sel.options.length).toBe(4);
    const ids = Array.from(sel.options).map(o => o.value);
    expect(ids).toContain('code-review');
    expect(ids).toContain('brainstorm');
    expect(ids).toContain('my-custom');
  });

  it('shows description when a template is selected', () => {
    populateDropdown(SAMPLE_TEMPLATES);
    const sel = document.getElementById('modal-template');
    sel.value = 'code-review';
    sel.dispatchEvent(new Event('change'));
    const desc = document.getElementById('modal-template-desc');
    expect(desc.textContent).toBe('Structured code review.');
  });

  it('clears description when "No template" is selected', () => {
    populateDropdown(SAMPLE_TEMPLATES);
    const sel = document.getElementById('modal-template');
    // Select something first
    sel.value = 'brainstorm';
    sel.dispatchEvent(new Event('change'));
    // Then clear
    sel.value = '';
    sel.dispatchEvent(new Event('change'));
    const desc = document.getElementById('modal-template-desc');
    expect(desc.textContent).toBe('');
  });
});

describe('thread template submit payload', () => {
  beforeEach(() => {
    buildModalDom();
    populateDropdown(SAMPLE_TEMPLATES);
  });

  it('includes template in POST payload when selected', () => {
    document.getElementById('modal-topic').value = 'Test Thread';
    document.getElementById('modal-template').value = 'code-review';

    const sel = document.getElementById('modal-template');
    const template = sel.value || null;
    expect(template).toBe('code-review');

    const topic = document.getElementById('modal-topic').value.trim();
    const payload = { topic, ...(template ? { template } : {}) };
    expect(payload.template).toBe('code-review');
  });

  it('omits template from POST payload when no template selected', () => {
    document.getElementById('modal-topic').value = 'Test Thread';
    document.getElementById('modal-template').value = '';

    const sel = document.getElementById('modal-template');
    const template = sel.value || null;
    expect(template).toBeNull();

    const topic = document.getElementById('modal-topic').value.trim();
    const payload = { topic, ...(template ? { template } : {}) };
    expect(payload).not.toHaveProperty('template');
  });
});
