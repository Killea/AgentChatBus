 (function () {
  class AcbSurveyCard extends HTMLElement {
    constructor() {
      super();
      this._data = null;
      this._isSubmitting = false;
    }

    connectedCallback() {
      this._render();
    }

    setData(data) {
      this._data = data || null;
      this._render();
    }

    _esc(v) {
      if (typeof window.AcbUtils?.escapeHtml === 'function') return window.AcbUtils.escapeHtml(v);
      return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    _resolveApi() {
      const apiFn = this._data?.api;
      if (typeof apiFn === 'function') return apiFn;
      if (typeof window.AcbApi?.api === 'function') return window.AcbApi.api;
      return null;
    }

    async _submitAnswer(action, label) {
      if (this._isSubmitting || !this._data) return;
      const threadId = this._data.threadId;
      const message = this._data.message || {};
      const meta = this._data.metadata || {};
      const api = this._resolveApi();
      if (!threadId || !api) return;

      this._isSubmitting = true;
      this.classList.remove('resolved');

      const actionButtons = this.querySelectorAll('[data-action]');
      const status = this.querySelector('.msg-survey-status');
      actionButtons.forEach((btn) => { btn.disabled = true; });
      if (status) status.textContent = 'Submitting answer...';

      // Compose answer message payload (client-side convenience)
      const authorInput = document.getElementById('compose-author');
      const author = authorInput ? (authorInput.value.trim() || 'human') : 'human';
      const content = `Survey response: ${this._esc(String(label || action))}`;
      const payload = {
        author,
        role: 'user',
        content,
        metadata: {
          ui_type: 'survey_answer',
          survey_id: meta.survey_id || meta.survey || null,
          answer: action,
          source_message_id: message.id || null,
        }
      };

      try {
        const res = await api(`/api/threads/${threadId}/messages`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (res) {
          if (status) status.textContent = `Answered: ${label || action}`;
          this.classList.add('resolved');
        } else {
          if (status) status.textContent = 'Failed to submit answer.';
          actionButtons.forEach((btn) => { btn.disabled = false; });
        }
      } catch (err) {
        if (status) status.textContent = 'Failed to submit answer.';
        actionButtons.forEach((btn) => { btn.disabled = false; });
      }

      this._isSubmitting = false;
    }

    _render() {
      if (!this._data) { this.innerHTML = ''; return; }
      const meta = this._data.metadata || {};
      const message = this._data.message || {};
      const title = String(meta.title || meta.question || '').trim() || 'Survey';
      const body = String(message.content || '').trim();
      const uiButtons = Array.isArray(meta.ui_buttons) && meta.ui_buttons.length > 0 ? meta.ui_buttons : (Array.isArray(meta.options) ? meta.options.map(o => ({ action: String(o), label: String(o) })) : []);

      this.className = 'msg-survey-card';
      this.setAttribute('data-seq', String(message.seq ?? ''));

      this.innerHTML = `
        <div class="msg-survey-title">${this._esc(title)}</div>
        <div class="msg-survey-body"></div>
        <div class="msg-survey-actions"></div>
        <div class="msg-survey-status"></div>
      `;

      const bodyEl = this.querySelector('.msg-survey-body');
      if (bodyEl && window.AcbMessageRenderer) {
        window.AcbMessageRenderer.renderMessageContent(bodyEl, body, null);
      } else if (bodyEl) {
        bodyEl.textContent = body;
      }

      const actionsEl = this.querySelector('.msg-survey-actions');
      if (actionsEl) {
        if (uiButtons.length === 0 && meta.choices && Array.isArray(meta.choices)) {
          uiButtons.push(...meta.choices.map(c => ({ action: c, label: c })));
        }
        if (uiButtons.length === 0) {
          // Fallback: parse simple options field like 'A,B,C'
          if (typeof meta.options === 'string' && meta.options.includes(',')) {
            const parts = meta.options.split(',').map(p => p.trim()).filter(Boolean);
            parts.forEach(p => uiButtons.push({ action: p, label: p }));
          }
        }

        uiButtons.forEach((b, idx) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'msg-survey-btn';
          btn.setAttribute('data-action', String(b.action || `opt_${idx}`));
          btn.textContent = String(b.label || b.action || `Option ${idx+1}`);
          btn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            this._submitAnswer(btn.getAttribute('data-action'), btn.textContent);
          });
          actionsEl.appendChild(btn);
        });
      }
    }
  }

  if (!customElements.get('acb-survey-card')) {
    customElements.define('acb-survey-card', AcbSurveyCard);
  }
})();
