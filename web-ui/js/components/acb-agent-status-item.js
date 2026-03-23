(function () {
  class AcbAgentStatusItem extends HTMLElement {
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
      if (!this._data) return;

      const {
        avatarEmoji,
        label,
        state,
        isAdministrator,
        offlineDisplay,
        isLongOffline,
        compressedChar,
        escapeHtml,
        skills,
        stateEmoji,
        isStdio,
        tooltipText,
      } = this._data;

      const esc = typeof escapeHtml === "function" ? escapeHtml : (v) => String(v ?? "");
      const stateLower = String(state ?? "").trim().toLowerCase();

      const isDarkTheme = document.body.getAttribute('data-theme') !== 'light';
      const styles = window.AcbUtils ? window.AcbUtils.getEmojiStyledBackground(avatarEmoji, isDarkTheme) : { bg: 'transparent', border: 'transparent' };
      const avatarBg = styles.bg;
      const avatarBorder = styles.border;

      this.className = "agent-status-item";
      this.dataset.state = stateLower;

      // Long-offline compact mode (>1hr offline)
      if (isLongOffline) {
        const compactTitle = compressedChar === "∞"
          ? "Offline since unknown time"
          : `Offline ${offlineDisplay || compressedChar}`;
        this.innerHTML = `
          <div class="agent-status-item agent-status-item--compact" title="${esc(compactTitle)}">
            <div class="asi-avatar-wrap asi-avatar-wrap--compact">
              <div class="asi-avatar asi-avatar--sm" style="background:${avatarBg}; border: 1px solid ${avatarBorder};">${avatarEmoji}</div>
              ${isAdministrator ? '<span class="asi-admin-badge" aria-label="Administrator">👑</span>' : ''}
            </div>
            <span class="asi-state-emoji">${stateEmoji}</span>
          </div>
        `;
        return;
      }

      // Normal card: 48x48 avatar on left, 24x48 status panel on right
      const isOffline = stateLower === "offline";
      const transportIcon = isOffline
        ? `<span class="asi-transport-emoji">❔</span>`
        : isStdio
          ? `<span class="asi-transport-emoji">✡️</span>`
          : `<span class="asi-transport-emoji">🌟</span>`;

      this.innerHTML = `
        <div class="asi-avatar-wrap">
          <div class="asi-avatar" style="background:${avatarBg}; border: 1px solid ${avatarBorder};" data-tooltip="${esc(tooltipText || state)}">${avatarEmoji}</div>
          ${isAdministrator ? '<span class="asi-admin-badge" aria-label="Administrator">👑</span>' : ''}
        </div>
        <div class="asi-status-panel">
          <div class="asi-status-box" data-tooltip="${esc(state || 'unknown')}">${stateEmoji}</div>
          <div class="asi-transport-box" data-tooltip="${isOffline ? 'Connection unknown' : isStdio ? 'Stdio connection' : 'SSE connection'}">${transportIcon}</div>
        </div>
      `;

      // Remove all tooltip attributes from the card element itself so closest()
      // doesn't short-circuit to the card before reaching the child boxes.
      this.removeAttribute("title");
      this.removeAttribute("data-tooltip");
      this.removeAttribute("data-acb-tooltip");
    }
  }

  if (!customElements.get("acb-agent-status-item")) {
    customElements.define("acb-agent-status-item", AcbAgentStatusItem);
  }
})();
