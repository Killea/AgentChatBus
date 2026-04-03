(function registerAcbFilterRow() {
  function escAttr(v) {
    return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  class AcbFilterRow extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      const status = this.getAttribute('status') || '';
      const checked = this.hasAttribute('checked');

      this.innerHTML = `
        <label class="filter-row">
          <input type="checkbox" data-status="${escAttr(status)}" ${checked ? 'checked' : ''} onchange="onThreadFilterChange()"/>
          ${escAttr(status)}
        </label>`;
    }
  }

  if (!customElements.get('acb-filter-row')) {
    customElements.define('acb-filter-row', AcbFilterRow);
  }
})();
