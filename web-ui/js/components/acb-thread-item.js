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
      this._boundPinClick = null;
      this._boundTagClick = null;
    }

    connectedCallback() {
      this.style.display = "block";
      if (!this._boundClick) {
        this._boundClick = (e) => {
          if (!this._thread) return;
          this.dispatchEvent(
            new CustomEvent("thread-select", {
              bubbles: true,
              detail: {
                id: this._thread.id,
                topic: this._thread.topic,
                status: this._thread.status,
                shiftKey: Boolean(e.shiftKey),
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
      if (!this._boundPinClick) {
        this._boundPinClick = (e) => {
          const pinBtn = e.target.closest(".ti-pin-btn");
          if (!pinBtn || !this._thread) return;
          e.preventDefault();
          e.stopPropagation();
          if (typeof pinBtn.blur === "function") {
            pinBtn.blur();
          }
          this.dispatchEvent(
            new CustomEvent("thread-pin-toggle", {
              bubbles: true,
              detail: {
                id: this._thread.id,
                pinned: !Boolean(this._thread.isPinned),
              },
            })
          );
        };
      }

      if (!this._boundTagClick) {
        this._boundTagClick = (e) => {
          const removeBtn = e.target.closest(".ti-tag-remove");
          if (removeBtn) {
            e.preventDefault();
            e.stopPropagation();
            if (!this._thread) return;
            this.dispatchEvent(
              new CustomEvent("thread-tag-remove", {
                bubbles: true,
                detail: {
                  id: this._thread.id,
                  tag: removeBtn.getAttribute("data-tag") || "",
                },
              })
            );
            return;
          }
          const tagBtn = e.target.closest(".ti-tag");
          if (!tagBtn || !this._thread) return;
          e.preventDefault();
          e.stopPropagation();
          this.dispatchEvent(
            new CustomEvent("thread-tag-filter", {
              bubbles: true,
              detail: {
                tag: tagBtn.getAttribute("data-tag") || "",
              },
            })
          );
        };
      }

      this.addEventListener("click", this._boundClick);
      this.addEventListener("contextmenu", this._boundContextMenu);
      this.addEventListener("click", this._boundPinClick);
      this.addEventListener("click", this._boundTagClick);
      this._render();
    }

    disconnectedCallback() {
      if (this._boundClick) this.removeEventListener("click", this._boundClick);
      if (this._boundContextMenu) this.removeEventListener("contextmenu", this._boundContextMenu);
      if (this._boundPinClick) this.removeEventListener("click", this._boundPinClick);
      if (this._boundTagClick) this.removeEventListener("click", this._boundTagClick);
    }

    setData({ thread, active, timeAgo, esc, activeTagFilter = null }) {
      this._thread = thread || null;
      this._active = Boolean(active);
      this._timeAgo = typeof timeAgo === "function" ? timeAgo : null;
      this._esc = typeof esc === "function" ? esc : null;
      this._activeTagFilter = activeTagFilter ? String(activeTagFilter) : null;
      this._render();
    }

    _render() {
      if (!this._thread) return;
      const esc = this._esc || ((v) => String(v ?? ""));
      const timeAgo = this._timeAgo || (() => "");
      const activeClass = this._active ? " active" : "";
      const pinned = Boolean(this._thread.isPinned);
      const waitingAgents = Array.isArray(this._thread.waiting_agents) ? this._thread.waiting_agents : [];
      const visibleAgents = waitingAgents.slice(0, 3);
      const overflowCount = Math.max(0, waitingAgents.length - visibleAgents.length);
      const waitingBadgeHtml = visibleAgents.length
        ? `
        <div class="ti-waiting-agents" aria-label="${esc(`${waitingAgents.length} waiting agents`)}">
          ${visibleAgents
            .map((agent, index) => {
              const label = esc(String(agent.display_name || agent.id || "Unknown"));
              return `<span class="ti-waiting-agent" title="${label}" aria-label="${label}">${index + 1}</span>`;
            })
            .join("")}
          ${overflowCount > 0 ? `<span class="ti-waiting-agent ti-waiting-agent--count" title="${esc(`${overflowCount} more waiting agents`)}">+${overflowCount}</span>` : ""}
        </div>`
        : "";
      const tags = Array.isArray(this._thread.tags) ? this._thread.tags : [];
      const tagsHtml = tags.length
        ? `<div class="ti-tags" aria-label="Thread tags">${tags
            .map((tag) => {
              const label = esc(String(tag || ""));
              const activeClass = this._activeTagFilter === label ? " is-active" : "";
              return `<button type="button" class="ti-tag${activeClass}" data-tag="${label}" title="Filter by ${label}">${label}<span class="ti-tag-remove" data-tag="${label}" aria-label="Remove tag ${label}" title="Remove tag">×</span></button>`;
            })
            .join("")}</div>`
        : "";
      this.className = `thread-item${activeClass}`;
      this.id = `ti-${this._thread.id}`;
      this.setAttribute('data-thread-id', String(this._thread.id));
      this.setAttribute('role', 'listitem');
      this.setAttribute('aria-current', this._active ? 'true' : 'false');
      this.title = 'Shift+click to compare with current thread';
      this.innerHTML = `
        <button class="ti-pin-btn${pinned ? " is-pinned" : ""}" type="button" aria-label="${pinned ? "Unpin thread" : "Pin thread"}" title="${pinned ? "Unpin thread" : "Pin thread"}">📌</button>
        ${waitingBadgeHtml}
        <div class="ti-topic">${esc(this._thread.topic)}</div>
        <div class="ti-meta">
          <span class="badge badge-${esc(this._thread.status)}">${esc(this._thread.status)}</span>
          <span>${esc(timeAgo(this._thread.created_at))}</span>
        </div>
        ${tagsHtml}`;
    }
  }

  if (!customElements.get("acb-thread-item")) {
    customElements.define("acb-thread-item", AcbThreadItem);
  }
})();
