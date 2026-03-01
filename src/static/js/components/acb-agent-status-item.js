(function () {
  class AcbAgentStatusItem extends HTMLElement {
    constructor() {
      super();
      this._data = null;
    }

    connectedCallback() {
      this.style.display = "block";
      this._render();
    }

    setData(data) {
      this._data = data || null;
      this._render();
    }

    _render() {
      if (!this._data) return;

      const {
        avatarEmoji,
        stateEmoji,
        label,
        state,
        offlineDisplay,
        isLongOffline,
        compressedChar,
        escapeHtml,
      } = this._data;

      const esc = typeof escapeHtml === "function" ? escapeHtml : (v) => String(v ?? "");

      this.className = "agent-status-item";
      this.dataset.state = String(state ?? "").trim().toLowerCase();

      if (isLongOffline) {
        this.innerHTML = `
          <div class="agent-status-emoji">${avatarEmoji}</div>
          <div class="agent-status-text-compact">${compressedChar}</div>
          <div class="agent-status-state-emoji" title="${esc(state)}">${stateEmoji}</div>
        `;
        return;
      }

      this.innerHTML = `
        <div class="agent-status-emoji-row">
          <div class="agent-status-emoji">${avatarEmoji}</div>
          <span class="agent-status-separator-short">|</span>
          <div class="agent-status-state-emoji" title="${esc(state)}">${stateEmoji}</div>
        </div>
        <div class="agent-state">${state}${offlineDisplay}</div>
      `;
    }
  }

  if (!customElements.get("acb-agent-status-item")) {
    customElements.define("acb-agent-status-item", AcbAgentStatusItem);
  }
})();
