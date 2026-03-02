(function () {
  class AcbMessageTailMeta extends HTMLElement {
    constructor() {
      super();
      this._data = null;
    }

    connectedCallback() {
      this._render();
    }

    setData(data) {
      this._data = data || null;
      this._render();
    }

    _render() {
      if (!this._data || !this._data.visible) {
        this.style.display = "none";
        this.innerHTML = "";
        return;
      }

      const esc = typeof window.AcbUtils?.escapeHtml === "function"
        ? window.AcbUtils.escapeHtml
        : (v) => String(v ?? "");

      const emoji = String(this._data.emoji || "").trim() || "🤖";
      const name = String(this._data.name || "").trim() || "unknown";
      const timeLabel = String(this._data.timeLabel || "").trim() || "";

      this.style.display = "inline-flex";
      this.className = "msg-tail-meta";
      this.title = `sent by ${name}${timeLabel ? ` at ${timeLabel}` : ""}`;

      this.innerHTML = `
        <span class="msg-tail-emoji">${esc(emoji)}</span>
        <span class="msg-tail-name">${esc(name)}</span>
        <span class="msg-tail-dot">·</span>
        <span class="msg-tail-time">${esc(timeLabel)}</span>
      `;
    }
  }

  if (!customElements.get("acb-message-tail-meta")) {
    customElements.define("acb-message-tail-meta", AcbMessageTailMeta);
  }
})();
