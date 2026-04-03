(function registerAcbThreadHeader() {
  class AcbThreadHeader extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <div id="thread-header" style="display:none">
          <div class="thread-header__title-stack">
            <h2 id="thread-title"></h2>
            <div id="thread-admin-label" class="thread-header__admin" hidden></div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <button id="search-toggle-btn" type="button" title="Search messages (Ctrl+F)" aria-label="Search messages" onclick="window.AcbSearch && window.AcbSearch.toggle()">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </button>
            <button id="thread-agent-panel-toggle" class="thread-header-cta" type="button" title="Show agent panel" aria-label="Show agent panel" onclick="window.AcbCliSessions && window.AcbCliSessions.toggleTerminalVisibility()">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2"/>
                <path d="M9 4v16"/>
              </svg>
              <span class="thread-agent-panel-toggle__label">Show Agent Panel</span>
            </button>
            <button id="thread-add-agent-btn" class="thread-header-cta" type="button" title="Add agent to this thread" aria-label="Add agent to this thread" onclick="window.openAddAgentModal && window.openAddAgentModal()">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 5v14"/>
                <path d="M5 12h14"/>
              </svg>
              <span>Add Agent</span>
            </button>
            <button id="thread-restart-btn" class="thread-header-cta" type="button" title="Restart this thread" aria-label="Restart this thread" onclick="window.openRestartThreadModal && window.openRestartThreadModal()">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M23 4v6h-6"/>
                <path d="M20.49 15A9 9 0 1 1 23 10"/>
              </svg>
              <span>Restart Thread</span>
            </button>
            <button id="export-thread-btn" type="button" title="Export as Markdown" aria-label="Export thread as Markdown" onclick="exportFromHeader()">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 1v9M4.5 6.5 8 10l3.5-3.5M2 11v2.5A1.5 1.5 0 0 0 3.5 15h9A1.5 1.5 0 0 0 14 13.5V11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button id="thread-settings-btn" type="button" title="Thread Settings" aria-label="Thread settings" onclick="openThreadSettingsModal()">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          </div>
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
