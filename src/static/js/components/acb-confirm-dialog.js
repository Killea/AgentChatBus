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

    /**
     * 显示确认对话框
     * @param {Object} options - 配置选项
     * @param {string} options.title - 对话框标题
     * @param {string} options.message - 确认消息（支持 HTML）
     * @param {string} options.confirmText - 确认按钮文本
     * @param {string} options.confirmClass - 确认按钮样式类（如 btn-destructive）
     * @returns {Promise<boolean>} - 返回 Promise，用户确认返回 true，取消返回 false
     */
    async show({ title = 'Confirm', message = '', confirmText = 'Confirm', confirmClass = 'btn-primary' }) {
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