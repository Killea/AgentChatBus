(function registerAcbConfirmDialog() {
  class AcbConfirmDialog extends HTMLElement {
    constructor() {
      super();
      this._dialog = null;
      this._resolve = null;
      this._boundClick = null;
    }

    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <dialog>
          <h3 class="confirm-title"></h3>
          <p class="confirm-message"></p>
          <menu class="confirm-actions">
            <button type="button" value="cancel" class="btn-secondary">Cancel</button>
            <button type="button" value="confirm" class="btn-primary">Confirm</button>
          </menu>
        </dialog>`;

      this._dialog = this.querySelector('dialog');
      this._boundClick = this._handleClick.bind(this);
      this._dialog.addEventListener('click', this._boundClick);
    }

    disconnectedCallback() {
      if (this._boundClick && this._dialog) {
        this._dialog.removeEventListener('click', this._boundClick);
      }
    }

    _handleClick(e) {
      const btn = e.target.closest('button[value]');
      if (!btn || !this._resolve) return;
      this._dialog.close(btn.value);
    }

    _positionDialog(x, y) {
      if (!x || !y) return;

      const dialogWidth = this._dialog.offsetWidth || 420;
      const dialogHeight = this._dialog.offsetHeight || 200;
      const padding = 16;

      // Compute dialog position, keeping it within the viewport
      let left = x;
      let top = y;

      // If the right edge overflows, shift left
      if (left + dialogWidth > window.innerWidth - padding) {
        left = window.innerWidth - dialogWidth - padding;
      }

      // If the bottom edge overflows, shift up
      if (top + dialogHeight > window.innerHeight - padding) {
        top = window.innerHeight - dialogHeight - padding;
      }

      // Clamp to left and top boundaries
      left = Math.max(padding, left);
      top = Math.max(padding, top);

      this._dialog.style.position = 'fixed';
      this._dialog.style.left = `${left}px`;
      this._dialog.style.top = `${top}px`;
      this._dialog.style.margin = '0';
    }

    /**
     * Show the confirm dialog and return a Promise resolving to the user's choice.
     * @param {Object} options - Configuration options
     * @param {string} options.title - Dialog title
     * @param {string} options.message - Confirm message (supports HTML)
     * @param {string} options.confirmText - Confirm button label
     * @param {string} options.confirmClass - Confirm button CSS class (e.g. btn-destructive)
     * @param {number} options.x - Optional X coordinate for dialog positioning
     * @param {number} options.y - Optional Y coordinate for dialog positioning
     * @returns {Promise<boolean>} Resolves to true if confirmed, false if cancelled
     */
    async show({ title = 'Confirm', message = '', confirmText = 'Confirm', confirmClass = 'btn-primary', x = null, y = null }) {
      if (!this._dialog) return false;

      const titleEl = this.querySelector('.confirm-title');
      const messageEl = this.querySelector('.confirm-message');
      const confirmBtn = this.querySelector('button[value="confirm"]');

      if (titleEl) titleEl.textContent = title;
      if (messageEl) messageEl.innerHTML = message;
      if (confirmBtn) {
        confirmBtn.textContent = confirmText;
        confirmBtn.className = confirmClass;
      }

      // Position dialog near the click if coordinates provided, otherwise center it
      if (x !== null && y !== null) {
        this._positionDialog(x, y);
      } else {
        this._dialog.style.position = '';
        this._dialog.style.left = '';
        this._dialog.style.top = '';
        this._dialog.style.margin = '';
      }

      this._dialog.returnValue = '';
      this._dialog.showModal();

      return new Promise((resolve) => {
        this._resolve = resolve;
        this._dialog.addEventListener('close', () => {
          const confirmed = this._dialog.returnValue === 'confirm';
          this._resolve(confirmed);
          this._resolve = null;
        }, { once: true });
      });
    }

    close() {
      if (this._dialog) {
        this._dialog.close();
      }
    }
  }

  if (!customElements.get('acb-confirm-dialog')) {
    customElements.define('acb-confirm-dialog', AcbConfirmDialog);
  }
})();