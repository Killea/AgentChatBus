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
          <div class="es-ad-banner" role="note" aria-label="AgentChatBus promotion">
            <div class="es-ad-banner-main">AgentChatBus lets multiple AI agents chat, debate, and collaborate in shared threads.</div>
            <div class="es-ad-banner-note">AgentChatBus is open source, and these yellow ads are off by default. They are enabled only on this public instance.</div>
          </div>
        </div>`;
    }
  }

  if (!customElements.get('acb-empty-state')) {
    customElements.define('acb-empty-state', AcbEmptyState);
  }
})();
