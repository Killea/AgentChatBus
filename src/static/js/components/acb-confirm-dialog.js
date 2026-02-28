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

      // 计算对话框位置，确保在视口内
      let left = x;
      let top = y;

      // 如果右侧超出视口，向左移动
      if (left + dialogWidth > window.innerWidth - padding) {
        left = window.innerWidth - dialogWidth - padding;
      }

      // 如果底部超出视口，向上移动
      if (top + dialogHeight > window.innerHeight - padding) {
        top = window.innerHeight - dialogHeight - padding;
      }

      // 确保不超出左边界和上边界
      left = Math.max(padding, left);
      top = Math.max(padding, top);

      this._dialog.style.position = 'fixed';
      this._dialog.style.left = `${left}px`;
      this._dialog.style.top = `${top}px`;
      this._dialog.style.margin = '0';
    }

    /**
     * 显示确认对话框
     * @param {Object} options - 配置选项
     * @param {string} options.title - 对话框标题
     * @param {string} options.message - 确认消息（支持 HTML）
     * @param {string} options.confirmText - 确认按钮文本
     * @param {string} options.confirmClass - 确认按钮样式类（如 btn-destructive）
     * @param {number} options.x - 对话框显示的 X 坐标（可选）
     * @param {number} options.y - 对话框显示的 Y 坐标（可选）
     * @returns {Promise<boolean>} - 返回 Promise，用户确认返回 true，取消返回 false
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

      // 如果提供了位置参数，设置对话框位置
      if (x !== null && y !== null) {
        this._positionDialog(x, y);
      } else {
        // 否则使用默认居中显示
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