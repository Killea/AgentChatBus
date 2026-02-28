(function registerAcbFilterRow() {
  class AcbFilterRow extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      const status = this.getAttribute('status') || '';
      const checked = this.hasAttribute('checked');

      this.innerHTML = `
        <label class="filter-row">
          <input type="checkbox" data-status="${status}" ${checked ? 'checked' : ''} onchange="onThreadFilterChange()"/>
          ${status}
        </label>`;
    }
  }

  if (!customElements.get('acb-filter-row')) {
    customElements.define('acb-filter-row', AcbFilterRow);
  }
})();
