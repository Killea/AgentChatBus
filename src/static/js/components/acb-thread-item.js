(function () {
  class AcbThreadItem extends HTMLElement {
    constructor() {
      super();
      this._thread = null;
      this._active = false;
      this._timeAgo = null;
      this._esc = null;
      this._boundClick = null;
      this._boundContextMenu = null;
    }

    connectedCallback() {
      this.style.display = "block";
      if (!this._boundClick) {
        this._boundClick = () => {
          if (!this._thread) return;
          this.dispatchEvent(
            new CustomEvent("thread-select", {
              bubbles: true,
              detail: {
                id: this._thread.id,
                topic: this._thread.topic,
                status: this._thread.status,
              },
            })
          );
        };
      }
      if (!this._boundContextMenu) {
        this._boundContextMenu = (e) => {
          if (!this._thread) return;
          e.preventDefault();
          this.dispatchEvent(
            new CustomEvent("thread-context", {
              bubbles: true,
              detail: {
                event: e,
                thread: this._thread,
              },
            })
          );
        };
      }

      this.addEventListener("click", this._boundClick);
      this.addEventListener("contextmenu", this._boundContextMenu);
      this._render();
    }

    disconnectedCallback() {
      if (this._boundClick) this.removeEventListener("click", this._boundClick);
      if (this._boundContextMenu) this.removeEventListener("contextmenu", this._boundContextMenu);
    }

    setData({ thread, active, timeAgo, esc }) {
      this._thread = thread || null;
      this._active = Boolean(active);
      this._timeAgo = typeof timeAgo === "function" ? timeAgo : null;
      this._esc = typeof esc === "function" ? esc : null;
      this._render();
    }

    _render() {
      if (!this._thread) return;
      const esc = this._esc || ((v) => String(v ?? ""));
      const timeAgo = this._timeAgo || (() => "");
      const activeClass = this._active ? " active" : "";
      const waitingAgents = Array.isArray(this._thread.waiting_agents) ? this._thread.waiting_agents : [];
      const visibleAgents = waitingAgents.slice(0, 3);
      const overflowCount = Math.max(0, waitingAgents.length - visibleAgents.length);
      const waitingBadgeHtml = visibleAgents.length
        ? `
        <div class="ti-waiting-agents" aria-label="${esc(`${waitingAgents.length} waiting agents`)}">
          ${visibleAgents
            .map((agent) => {
              const label = esc(String(agent.display_name || agent.id || "Unknown"));
              const emoji = esc(String(agent.emoji || "").trim() || "🤖");
              return `<span class="ti-waiting-agent" title="${label}" aria-label="${label}">${emoji}</span>`;
            })
            .join("")}
          ${overflowCount > 0 ? `<span class="ti-waiting-agent ti-waiting-agent--count" title="${esc(`${overflowCount} more waiting agents`)}">+${overflowCount}</span>` : ""}
        </div>`
        : "";
      this.className = `thread-item${activeClass}`;
      this.id = `ti-${this._thread.id}`;
      this.setAttribute('data-thread-id', String(this._thread.id));
      this.setAttribute('role', 'listitem');
      this.setAttribute('aria-current', this._active ? 'true' : 'false');
      this.innerHTML = `
        ${waitingBadgeHtml}
        <div class="ti-topic">${esc(this._thread.topic)}</div>
        <div class="ti-meta">
          <span class="badge badge-${esc(this._thread.status)}">${esc(this._thread.status)}</span>
          <span>${esc(timeAgo(this._thread.created_at))}</span>
        </div>`;
    }
  }

  if (!customElements.get("acb-thread-item")) {
    customElements.define("acb-thread-item", AcbThreadItem);
  }
})();
