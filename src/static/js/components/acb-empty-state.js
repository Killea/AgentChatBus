(function registerAcbEmptyState() {
  class AcbEmptyState extends HTMLElement {
    connectedCallback() {
      // Render once; keep content in light DOM so existing CSS selectors still apply.
      if (this.childElementCount > 0) return;
      this.innerHTML = `
        <div id="empty-state">
          <div class="es-icon">💬</div>
          <div class="es-title">No thread selected</div>
          <div class="es-sub">Create or select a thread to start watching the conversation</div>
        </div>`;
    }
  }

  if (!customElements.get('acb-empty-state')) {
    customElements.define('acb-empty-state', AcbEmptyState);
  }
})();
