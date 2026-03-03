(function () {
  class AcbAdminSwitchCard extends HTMLElement {
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
      if (typeof window.AcbUtils?.escapeHtml === "function") {
        return window.AcbUtils.escapeHtml(v);
      }
      return String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    _resolveApi() {
      const apiFn = this._data?.api;
      if (typeof apiFn === "function") return apiFn;
      if (typeof window.AcbApi?.api === "function") return window.AcbApi.api;
      return null;
    }

    async _submitDecision(action) {
      if (this._isSubmitting || !this._data) return;

      const threadId = this._data.threadId;
      const meta = this._data.metadata || {};
      const message = this._data.message || {};
      const api = this._resolveApi();

      if (!threadId || !api) return;

      this._isSubmitting = true;
      this.classList.remove("resolved");

      const switchBtn = this.querySelector('[data-action="switch"]');
      const keepBtn = this.querySelector('[data-action="keep"]');
      const status = this.querySelector('.msg-sys-admin-status');

      if (switchBtn) switchBtn.disabled = true;
      if (keepBtn) keepBtn.disabled = true;
      if (status) status.textContent = "Submitting decision...";

      const payload = {
        action,
        candidate_admin_id: meta.candidate_admin_id || null,
        source_message_id: message.id || null,
      };

      const result = await api(`/api/threads/${threadId}/admin/decision`, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (result && result.ok) {
        if (status) {
          const finalAction = result.action || action;
          const isAlreadyDecided = Boolean(result.already_decided);
          if (isAlreadyDecided) {
            status.textContent = finalAction === "switch"
              ? "Administrator switch already confirmed."
              : "Administrator keep decision already recorded.";
          } else {
            status.textContent = finalAction === "switch"
              ? "Administrator switch confirmed by human."
              : "Administrator kept by human decision.";
          }
        }
        this.classList.add("resolved");
        this._isSubmitting = false;
        return;
      }

      if (status) status.textContent = "Failed to submit decision. Please retry.";
      if (switchBtn) switchBtn.disabled = false;
      if (keepBtn) keepBtn.disabled = false;
      this._isSubmitting = false;
    }

    _render() {
      if (!this._data) {
        this.innerHTML = "";
        return;
      }

      const meta = this._data.metadata || {};
      const message = this._data.message || {};

      this.className = "msg-sys-admin-card";
      this.setAttribute("data-seq", String(message.seq ?? ""));

      const currentBadge = `${meta.current_admin_emoji || "👑"} ${meta.current_admin_name || meta.current_admin_id || "Unknown"}`;
      const candidateBadge = `${meta.candidate_admin_emoji || "🤖"} ${meta.candidate_admin_name || meta.candidate_admin_id || "Unknown"}`;

      const switchLabel = (meta.ui_buttons && meta.ui_buttons[0] && meta.ui_buttons[0].label)
        ? String(meta.ui_buttons[0].label)
        : `Switch admin to ${candidateBadge}`;
      const keepLabel = (meta.ui_buttons && meta.ui_buttons[1] && meta.ui_buttons[1].label)
        ? String(meta.ui_buttons[1].label)
        : `Keep ${currentBadge} as admin`;
      const resolvedAction = String(meta.decision_action || "").trim();
      const isResolved = meta.decision_status === "resolved" || resolvedAction.length > 0;
      const timeoutSeconds = Number.isFinite(Number(meta.timeout_seconds)) ? Number(meta.timeout_seconds) : null;
      const onlineCount = Number.isFinite(Number(meta.online_agents_count)) ? Number(meta.online_agents_count) : null;
      const modeLabel = String(meta.mode || "").trim() === "single_agent" ? "single-agent" : "multi-agent";
      const visibility = String(meta.visibility || "").trim().toLowerCase();
      const reasonText = timeoutSeconds
        ? `Trigger condition: all online participants stayed in msg_wait for ${timeoutSeconds}s (${modeLabel} path).`
        : `Trigger condition: all online participants stayed in msg_wait past the configured timeout (${modeLabel} path).`;
      const onlineText = onlineCount
        ? `Online participants at trigger time: ${onlineCount}.`
        : "Online participants at trigger time: unavailable.";
      const visibilityText = visibility === "human_only"
        ? "Visibility: human only. Agents cannot read or receive this card."
        : "Visibility: human decision required.";
      const humanOnlyHint = visibility === "human_only"
        ? `
          <div class="msg-sys-admin-human-note" role="note" aria-label="Human-only notice">
            <span class="msg-sys-admin-human-note-icon" aria-hidden="true">i</span>
            <span class="msg-sys-admin-human-note-text">This confirmation card is visible only to human participants.</span>
          </div>
        `
        : "";

      this.innerHTML = `
        <div class="msg-sys-admin-title">Administrator switch confirmation required</div>
        <div class="msg-sys-admin-body">${this._esc(reasonText)} ${this._esc(onlineText)}</div>
        <div class="msg-sys-admin-body">${this._esc(visibilityText)}</div>
        ${humanOnlyHint}
        <div class="msg-sys-admin-body">Current admin: ${this._esc(currentBadge)} | Candidate: ${this._esc(candidateBadge)}</div>
        <div class="msg-sys-admin-actions">
          <button type="button" class="msg-sys-admin-btn msg-sys-admin-btn-switch" data-action="switch">${this._esc(switchLabel)}</button>
          <button type="button" class="msg-sys-admin-btn" data-action="keep">${this._esc(keepLabel)}</button>
        </div>
        <div class="msg-sys-admin-status"></div>
      `;

      const switchBtn = this.querySelector('[data-action="switch"]');
      const keepBtn = this.querySelector('[data-action="keep"]');
      const status = this.querySelector('.msg-sys-admin-status');

      if (isResolved) {
        this.classList.add("resolved");
        if (switchBtn) switchBtn.disabled = true;
        if (keepBtn) keepBtn.disabled = true;
        if (status) {
          status.textContent = resolvedAction === "switch"
            ? "Administrator switch already confirmed."
            : "Administrator keep decision already recorded.";
        }
      } else {
        this.classList.remove("resolved");
      }

      if (switchBtn) {
        switchBtn.addEventListener("click", () => this._submitDecision("switch"));
      }
      if (keepBtn) {
        keepBtn.addEventListener("click", () => this._submitDecision("keep"));
      }
    }
  }

  if (!customElements.get("acb-admin-switch-card")) {
    customElements.define("acb-admin-switch-card", AcbAdminSwitchCard);
  }
})();
