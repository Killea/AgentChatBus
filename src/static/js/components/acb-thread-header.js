(function registerAcbThreadHeader() {
  class AcbThreadHeader extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <div id="thread-header" style="display:none">
          <h2 id="thread-title"></h2>
          <div id="online-presence" title="">
            <span id="online-count">1</span>
          </div>
        </div>`;
    }
  }

  if (!customElements.get('acb-thread-header')) {
    customElements.define('acb-thread-header', AcbThreadHeader);
  }
})();
