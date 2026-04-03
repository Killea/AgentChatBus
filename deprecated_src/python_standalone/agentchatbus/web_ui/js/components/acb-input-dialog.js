(function registerAcbInputDialog() {
  class AcbInputDialog extends HTMLElement {
    constructor() {
      super();
      this._dialog = null;
      this._resolve = null;
      this._boundClick = null;
      this._boundKeydown = null;
    }

    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <dialog>
          <h3 class="input-title"></h3>
          <p class="input-message"></p>
          <input type="text" class="input-field" placeholder="">
          <menu class="input-actions">
            <button type="button" value="cancel" class="btn-secondary">Cancel</button>
            <button type="button" value="confirm" class="btn-primary">Confirm</button>
          </menu>
        </dialog>`;

      this._dialog = this.querySelector('dialog');
      this._boundClick = this._handleClick.bind(this);
      this._boundKeydown = this._handleKeydown.bind(this);
      this._dialog.addEventListener('click', this._boundClick);
      this._dialog.addEventListener('keydown', this._boundKeydown);
    }

    disconnectedCallback() {
      if (this._boundClick && this._dialog) {
        this._dialog.removeEventListener('click', this._boundClick);
      }
      if (this._boundKeydown && this._dialog) {
        this._dialog.removeEventListener('keydown', this._boundKeydown);
      }
    }

    _handleClick(e) {
      const btn = e.target.closest('button[value]');
      if (!btn) return;
      if (btn.value === 'confirm') {
        this._dialog.close('confirm');
      } else {
        this._dialog.close('cancel');
      }
    }

    _handleKeydown(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._dialog.close('confirm');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this._dialog.close('cancel');
      }
    }

    _positionDialog(x, y) {
      const dialogWidth = this._dialog.offsetWidth || 420;
      const dialogHeight = this._dialog.offsetHeight || 200;
      if (window.AcbModals && typeof window.AcbModals.positionDialogNearClick === 'function') {
        window.AcbModals.positionDialogNearClick(this._dialog, x, y, dialogWidth, dialogHeight);
      }
    }

    /**
     * Show the input dialog and return a Promise resolving to the input value or null if cancelled.
     * @param {Object} options - Configuration options
     * @param {string} options.title - Dialog title
     * @param {string} options.message - Dialog message
     * @param {string} options.placeholder - Input field placeholder
     * @param {string} options.value - Initial input value
     * @param {string} options.confirmText - Confirm button label
     * @param {number} options.x - Optional X coordinate for dialog positioning
     * @param {number} options.y - Optional Y coordinate for dialog positioning
     * @returns {Promise<string|null>} Resolves to the input value if confirmed, null if cancelled
     */
    async show({ title = 'Input', message = '', placeholder = '', value = '', confirmText = 'Confirm', x = null, y = null }) {
      if (!this._dialog) return null;

      const titleEl = this.querySelector('.input-title');
      const messageEl = this.querySelector('.input-message');
      const inputField = this.querySelector('.input-field');
      const confirmBtn = this.querySelector('button[value="confirm"]');

      if (titleEl) titleEl.textContent = title;
      if (messageEl) messageEl.textContent = message;
      if (inputField) {
        inputField.placeholder = placeholder;
        inputField.value = value;
      }
      if (confirmBtn) confirmBtn.textContent = confirmText;

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

        const onClose = () => {
          if (this._dialog.returnValue === 'confirm') {
            const inputValue = inputField ? inputField.value : null;
            this._resolve(inputValue);
          } else {
            this._resolve(null);
          }
          this._resolve = null;
        };

        this._dialog.addEventListener('close', onClose, { once: true });
        this._dialog.showModal();
        
        // Auto-focus the input field
        if (inputField) {
          setTimeout(() => inputField.focus(), 0);
        }
      });
    }

    close() {
      if (this._dialog) {
        this._dialog.close();
      }
    }
  }

  if (!customElements.get('acb-input-dialog')) {
    customElements.define('acb-input-dialog', AcbInputDialog);
  }
})();
