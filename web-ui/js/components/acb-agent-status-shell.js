(function registerAcbAgentStatusShell() {
  class AcbAgentStatusShell extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <div id="agent-status-bar">
          <div id="agent-status-list"></div>
          <div id="agent-status-actions">
            <button id="btn-close-thread-bar" type="button" class="agent-status-action agent-status-action--danger" onclick="closeActiveThreadFromStatusBar()" disabled>Close Thread</button>
            <div id="agent-status-info">ℹ️</div>
          </div>
        </div>`;
    }
  }

  if (!customElements.get('acb-agent-status-shell')) {
    customElements.define('acb-agent-status-shell', AcbAgentStatusShell);
  }
})();
