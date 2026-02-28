(function registerAcbAgentStatusShell() {
  class AcbAgentStatusShell extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <div id="agent-status-bar">
          <div id="agent-status-list"></div>
          <div id="agent-status-info">ℹ️</div>
        </div>`;
    }
  }

  if (!customElements.get('acb-agent-status-shell')) {
    customElements.define('acb-agent-status-shell', AcbAgentStatusShell);
  }
})();
