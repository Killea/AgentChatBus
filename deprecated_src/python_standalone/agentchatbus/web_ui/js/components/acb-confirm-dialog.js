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
      const dialogWidth = this._dialog.offsetWidth || 420;
      const dialogHeight = this._dialog.offsetHeight || 200;
      if (window.AcbModals && typeof window.AcbModals.positionDialogNearClick === 'function') {
        window.AcbModals.positionDialogNearClick(this._dialog, x, y, dialogWidth, dialogHeight);
      }
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

      return new Promise((resolve) => {
        this._resolve = resolve;
        
        // Add close listener BEFORE showModal to ensure we catch the event
        const onClose = () => {
          const confirmed = this._dialog.returnValue === 'confirm';
          this._resolve(confirmed);
          this._resolve = null;
        };
        
        this._dialog.addEventListener('close', onClose, { once: true });
        this._dialog.showModal();
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