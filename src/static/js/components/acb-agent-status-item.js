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
        emoji,
        label,
        state,
        offlineDisplay,
        isLongOffline,
        compressedChar,
        escapeHtml,
      } = this._data;

      const esc = typeof escapeHtml === "function" ? escapeHtml : (v) => String(v ?? "");

      this.className = "agent-status-item";

      if (isLongOffline) {
        this.innerHTML = `
          <div class="agent-status-emoji">${emoji}</div>
          <div class="agent-status-text-compact">${compressedChar}</div>
        `;
        return;
      }

      this.innerHTML = `
        <div class="agent-status-emoji">${emoji}</div>
        <div class="agent-status-text">
          <div class="agent-alias">${esc(label)}</div>
          <div class="agent-state">${state}${offlineDisplay}</div>
        </div>
      `;
    }
  }

  if (!customElements.get("acb-agent-status-item")) {
    customElements.define("acb-agent-status-item", AcbAgentStatusItem);
  }
})();
