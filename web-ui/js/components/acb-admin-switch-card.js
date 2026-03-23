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
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    _resolveApi() {
      const apiFn = this._data?.api;
      if (typeof apiFn === "function") return apiFn;
      if (typeof window.AcbApi?.api === "function") return window.AcbApi.api;
      return null;
    }

    _getCachedAgents() {
      if (typeof window.AcbAgents?.getCachedAgents === "function") {
        return window.AcbAgents.getCachedAgents();
      }
      if (Array.isArray(window.__acbCurrentAgents)) {
        return window.__acbCurrentAgents;
      }
      return [];
    }

    _resolveAgentEmoji(agentId, fallbackEmoji) {
      const normalizedId = String(agentId || "").trim();
      if (normalizedId) {
        const agents = this._getCachedAgents();
        const match = agents.find((agent) => String(agent?.id || agent?.agent_id || "").trim() === normalizedId);
        const liveEmoji = String(match?.emoji || "").trim();
        if (liveEmoji) {
          return liveEmoji;
        }
      }
      return String(fallbackEmoji || "").trim();
    }

    _statusText(action, alreadyDecided) {
      const past = alreadyDecided ? "already " : "";
      if (action === "switch") return `Administrator switch ${past}confirmed.`;
      if (action === "keep") return `Administrator keep decision ${past}recorded.`;
      if (action === "takeover") return `Administrator takeover instruction ${past}sent.`;
      if (action === "cancel") return `Takeover request ${past}canceled.`;
      return alreadyDecided ? "Decision already recorded." : "Decision submitted.";
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

      const actionButtons = this.querySelectorAll('[data-action]');
      const status = this.querySelector('.msg-sys-admin-status');

      actionButtons.forEach((btn) => {
        btn.disabled = true;
      });
      if (status) status.textContent = "Submitting decision...";

      const payload = {
        action,
        candidate_admin_id: action === "switch" ? (meta.candidate_admin_id || null) : null,
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
          status.textContent = this._statusText(finalAction, isAlreadyDecided);
        }
        this.classList.add("resolved");
        this._isSubmitting = false;
        return;
      }

      if (status) status.textContent = "Failed to submit decision. Please retry.";
      actionButtons.forEach((btn) => {
        btn.disabled = false;
      });
      this._isSubmitting = false;
    }

    _render() {
      if (!this._data) {
        this.innerHTML = "";
        return;
      }

      const meta = this._data.metadata || {};
      const message = this._data.message || {};
      const uiType = String(meta.ui_type || "").trim();
      const isTakeoverCard = uiType === "admin_takeover_confirmation_required";

      this.className = "msg-sys-admin-card";
      this.setAttribute("data-seq", String(message.seq ?? ""));

      const currentAdminEmoji = this._resolveAgentEmoji(
        meta.current_admin_id,
        meta.current_admin_emoji || "👑",
      ) || "👑";
      const candidateAdminEmoji = this._resolveAgentEmoji(
        meta.candidate_admin_id,
        meta.candidate_admin_emoji || "🤖",
      ) || "🤖";
      const currentBadge = `${currentAdminEmoji} ${meta.current_admin_name || meta.current_admin_id || "Unknown"}`;
      const candidateBadge = `${candidateAdminEmoji} ${meta.candidate_admin_name || meta.candidate_admin_id || "Unknown"}`;

      const defaultButtons = isTakeoverCard
        ? [
            { action: "takeover", label: "Require administrator to take over now" },
            { action: "cancel", label: "Cancel" },
          ]
        : [
            { action: "switch", label: `Switch admin to ${candidateBadge}` },
            { action: "keep", label: `Keep ${currentBadge} as admin` },
          ];
      const uiButtons = Array.isArray(meta.ui_buttons) && meta.ui_buttons.length >= 2
        ? meta.ui_buttons
        : defaultButtons;
      const primaryBtn = uiButtons[0] || defaultButtons[0];
      const secondaryBtn = uiButtons[1] || defaultButtons[1];
      const primaryAction = String(primaryBtn.action || defaultButtons[0].action);
      const secondaryAction = String(secondaryBtn.action || defaultButtons[1].action);
      const primaryLabel = String(primaryBtn.label || defaultButtons[0].label);
      const secondaryLabel = String(secondaryBtn.label || defaultButtons[1].label);
      const primaryTooltip = String(primaryBtn.tooltip || "").trim();
      const secondaryTooltip = String(secondaryBtn.tooltip || "").trim();
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
      const visibilityLine = visibility === "human_only"
        ? ""
        : `<div class="msg-sys-admin-body">Visibility: human decision required.</div>`;
      const humanOnlyHint = visibility === "human_only"
        ? `
          <div class="msg-sys-admin-human-note" role="note" aria-label="Human-only notice">
            <span class="msg-sys-admin-human-note-icon" aria-hidden="true">i</span>
            <span class="msg-sys-admin-human-note-text">This confirmation card is visible only to human participants.</span>
          </div>
        `
        : "";

      const cardTitle = isTakeoverCard
        ? "Administrator takeover confirmation required"
        : "Administrator switch confirmation required";
      const subjectLine = isTakeoverCard
        ? `Administrator: ${this._esc(currentBadge)}`
        : `Current admin: ${this._esc(currentBadge)} | Candidate: ${this._esc(candidateBadge)}`;

      this.innerHTML = `
        <div class="msg-sys-admin-title">${this._esc(cardTitle)}</div>
        <div class="msg-sys-admin-body">${this._esc(reasonText)} ${this._esc(onlineText)}</div>
        <div class="msg-sys-admin-body">${this._esc(message.content || "")}</div>
        ${visibilityLine}
        ${humanOnlyHint}
        <div class="msg-sys-admin-body">${subjectLine}</div>
        <div class="msg-sys-admin-actions">
          <button type="button" class="msg-sys-admin-btn msg-sys-admin-btn-switch" data-action="${this._esc(primaryAction)}" ${primaryTooltip ? `title="${this._esc(primaryTooltip)}"` : ""}>${this._esc(primaryLabel)}</button>
          <button type="button" class="msg-sys-admin-btn" data-action="${this._esc(secondaryAction)}" ${secondaryTooltip ? `title="${this._esc(secondaryTooltip)}"` : ""}>${this._esc(secondaryLabel)}</button>
        </div>
        <div class="msg-sys-admin-status"></div>
      `;

      const actionButtons = this.querySelectorAll('[data-action]');
      const status = this.querySelector('.msg-sys-admin-status');

      if (isResolved) {
        this.classList.add("resolved");
        actionButtons.forEach((btn) => {
          btn.disabled = true;
        });
        if (status) {
          status.textContent = this._statusText(resolvedAction, true);
        }
      } else {
        this.classList.remove("resolved");
      }

      actionButtons.forEach((btn) => {
        const action = String(btn.getAttribute("data-action") || "").trim();
        if (!action) return;
        btn.addEventListener("click", () => this._submitDecision(action));
      });
    }
  }

  if (!customElements.get("acb-admin-switch-card")) {
    customElements.define("acb-admin-switch-card", AcbAdminSwitchCard);
  }
})();
