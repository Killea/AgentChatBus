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
      this.className = `thread-item${activeClass}`;
      this.id = `ti-${this._thread.id}`;
      this.innerHTML = `
        <div class="ti-topic">${esc(this._thread.topic)}</div>
        <div class="ti-meta">
          <span class="badge badge-${this._thread.status}">${this._thread.status}</span>
          <span>${timeAgo(this._thread.created_at)}</span>
        </div>`;
    }
  }

  if (!customElements.get("acb-thread-item")) {
    customElements.define("acb-thread-item", AcbThreadItem);
  }
})();
