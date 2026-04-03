(function registerAcbFilterActions() {
  class AcbFilterActions extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <div class="filter-actions">
          <button type="button" onclick="selectAllThreadStatuses()">Select all</button>
          <button type="button" onclick="selectNormalThreadStatuses()">Normal only</button>
        </div>`;
    }
  }

  if (!customElements.get('acb-filter-actions')) {
    customElements.define('acb-filter-actions', AcbFilterActions);
  }
})();
