(function registerAcbIconButton() {
  function escapeAttr(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  class AcbIconButton extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      const buttonId = this.getAttribute('button-id') || '';
      const label = this.getAttribute('label') || '';
      const title = this.getAttribute('title') || '';
      const ariaLabel = this.getAttribute('aria-label') || '';
      const action = this.getAttribute('action') || '';

      this.innerHTML = `
        <button
          ${buttonId ? `id="${escapeAttr(buttonId)}"` : ''}
          type="button"
          ${title ? `title="${escapeAttr(title)}"` : ''}
          ${ariaLabel ? `aria-label="${escapeAttr(ariaLabel)}"` : ''}
        >${label}</button>`;

      const btn = this.querySelector('button');
      if (!btn || !action) return;

      btn.addEventListener('click', () => {
        const fn = window[action];
        if (typeof fn === 'function') {
          fn();
        }
      });
    }
  }

  if (!customElements.get('acb-icon-button')) {
    customElements.define('acb-icon-button', AcbIconButton);
  }
})();
