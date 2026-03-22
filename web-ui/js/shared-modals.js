(function () {
  const MODAL_CONFIGS = {
    thread: {
      overlayId: "modal-overlay",
      visibility: "class",
    },
    agent: {
      overlayId: "agent-modal-overlay",
      visibility: "style",
      styleVisibleValue: "flex",
    },
    settings: {
      overlayId: "settings-modal-overlay",
      visibility: "style",
      styleVisibleValue: "flex",
    },
    "thread-settings": {
      overlayId: "thread-settings-modal-overlay",
      visibility: "style",
      styleVisibleValue: "flex",
    },
  };

  /**
   * Common dialog positioning logic - positions dialog near click coordinate
   * @param {HTMLElement} dialogElement - The dialog element to position
   * @param {number|null} clickX - X coordinate of click (null to center)
   * @param {number|null} clickY - Y coordinate of click (null to center)
   * @param {number} dialogWidth - Width of dialog
   * @param {number} dialogHeight - Height of dialog
   */
  function positionDialogNearClick(dialogElement, clickX, clickY, dialogWidth, dialogHeight) {
    if (!dialogElement || clickX === null || clickY === null) {
      // Center the dialog (default behavior)
      dialogElement.style.position = '';
      dialogElement.style.left = '';
      dialogElement.style.top = '';
      dialogElement.style.margin = '';
      return;
    }

    const padding = 16;
    let left = clickX;
    let top = clickY;

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

    dialogElement.style.position = 'fixed';
    dialogElement.style.left = `${left}px`;
    dialogElement.style.top = `${top}px`;
    dialogElement.style.margin = '0';
  }

  function getOverlay(configKey) {
    const cfg = MODAL_CONFIGS[configKey];
    if (!cfg) return null;
    return document.getElementById(cfg.overlayId);
  }

  function setModalVisible(configKey, visible) {
    const cfg = MODAL_CONFIGS[configKey];
    const overlay = getOverlay(configKey);
    if (!cfg || !overlay) return;

    if (cfg.visibility === "class") {
      overlay.classList.toggle("visible", visible);
      return;
    }

    const styleValue = cfg.styleVisibleValue || "block";
    overlay.style.display = visible ? styleValue : "none";
  }

  function isOverlayClick(event, configKey) {
    const overlay = getOverlay(configKey);
    return !!overlay && !!event && event.target === overlay;
  }

  // Cache of available templates populated on first modal open
  let _templates = null;

  async function _loadTemplates(api) {
    if (_templates !== null) return _templates;
    try {
      const result = await api("/api/templates");
      _templates = Array.isArray(result) ? result : [];
    } catch {
      // Keep cache unset on failure so future modal opens can retry.
      return [];
    }
    return _templates;
  }

  function _populateTemplateDropdown(templates) {
    const sel = document.getElementById("modal-template");
    if (!sel) return;
    // Keep the first "No template" option, remove the rest
    while (sel.options.length > 1) sel.remove(1);
    for (const t of templates) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name + (t.is_builtin ? "" : " ★");
      opt.dataset.description = t.description || "";
      sel.appendChild(opt);
    }
    sel.onchange = () => {
      const desc = document.getElementById("modal-template-desc");
      if (!desc) return;
      const selected = sel.options[sel.selectedIndex];
      desc.textContent = selected ? (selected.dataset.description || "") : "";
    };
  }

  function getThreadLaunchMode() {
    return document.querySelector('input[name="thread-launch-mode"]:checked')?.value || "thread_only";
  }

  function syncThreadLaunchUi() {
    const mode = getThreadLaunchMode();
    const configEl = document.getElementById("thread-agent-config");
    const submitBtn = document.getElementById("btn-create-thread");
    if (configEl) {
      configEl.classList.toggle("meeting-modal-hidden", mode !== "thread_with_agent");
    }
    if (submitBtn) {
      submitBtn.textContent = mode === "thread_with_agent" ? "Create and Start Agent" : "Create Thread";
    }
  }

  function resetAgentForm(prefix) {
    const adapterEl = document.getElementById(`${prefix}-adapter`);
    const modeEl = document.getElementById(`${prefix}-mode`);
    const displayNameEl = document.getElementById(`${prefix}-display-name`);
    const instructionEl = document.getElementById(`${prefix}-instruction`);
    if (adapterEl) adapterEl.value = "codex";
    if (modeEl) modeEl.value = "interactive";
    if (displayNameEl) displayNameEl.value = "";
    if (instructionEl) instructionEl.value = "";
  }

  function resetAutoAssembleForm() {
    const goalEl = document.getElementById("agent-auto-goal");
    const maxEl = document.getElementById("agent-auto-max");
    const adaptersEl = document.getElementById("agent-auto-adapters");
    if (goalEl) goalEl.value = "";
    if (maxEl) maxEl.value = "2";
    if (adaptersEl) adaptersEl.value = "any";
  }

  function getAddAgentTab() {
    return document.getElementById("agent-modal")?.dataset.activeTab || "manual";
  }

  function switchAddAgentTab(tabId) {
    const nextTab = tabId === "auto" ? "auto" : "manual";
    const modalEl = document.getElementById("agent-modal");
    if (!modalEl) return nextTab;
    modalEl.dataset.activeTab = nextTab;

    const tabs = [
      {
        id: "manual",
        button: document.getElementById("agent-modal-tab-manual"),
        panel: document.getElementById("agent-modal-panel-manual"),
      },
      {
        id: "auto",
        button: document.getElementById("agent-modal-tab-auto"),
        panel: document.getElementById("agent-modal-panel-auto"),
      },
    ];

    tabs.forEach((tab) => {
      const active = tab.id === nextTab;
      if (tab.button) {
        tab.button.classList.toggle("is-active", active);
        tab.button.setAttribute("aria-selected", active ? "true" : "false");
      }
      if (tab.panel) {
        tab.panel.classList.toggle("meeting-modal-hidden", !active);
        tab.panel.classList.toggle("is-active", active);
      }
    });

    const submitBtn = document.getElementById("btn-add-agent-submit");
    if (submitBtn) {
      submitBtn.disabled = nextTab !== "manual";
      submitBtn.textContent = nextTab === "manual" ? "Add Agent" : "Planning Soon";
    }

    return nextTab;
  }

  function readAgentLaunchConfig(prefix) {
    const adapter = String(document.getElementById(`${prefix}-adapter`)?.value || "codex").trim();
    const mode = String(document.getElementById(`${prefix}-mode`)?.value || "interactive").trim();
    const displayName = String(document.getElementById(`${prefix}-display-name`)?.value || "").trim();
    const initialInstruction = String(document.getElementById(`${prefix}-instruction`)?.value || "").trim();
    return {
      adapter,
      mode,
      displayName,
      initialInstruction,
    };
  }

  function buildDefaultParticipantName(config) {
    if (config.displayName) {
      return config.displayName;
    }
    const adapterLabel = config.adapter === "cursor" ? "Cursor" : "Codex";
    const modeLabel = config.mode === "headless" ? "Headless" : "Interactive";
    return `${adapterLabel} ${modeLabel}`;
  }

  function buildDefaultInstruction({ topic, config, isFirstAgent }) {
    const roleLine = isFirstAgent
      ? "You are the first active agent in this thread."
      : "You are joining an existing thread as a participant.";
    return [
      `You are joining the AgentChatBus thread "${topic}".`,
      roleLine,
      "Introduce yourself briefly, explain what you can help with, and wait for further instructions.",
      config.adapter === "cursor" && config.mode === "headless"
        ? "Respond in plain text."
        : "",
    ].filter(Boolean).join(" ");
  }

  async function registerParticipantAgent(api, config) {
    const adapterLabel = config.adapter === "cursor" ? "Cursor" : "Codex";
    const modeLabel = config.mode === "headless" ? "Headless CLI" : "Interactive CLI";
    const displayName = buildDefaultParticipantName(config);
    const result = await api("/api/agents/register", {
      method: "POST",
      body: JSON.stringify({
        ide: adapterLabel,
        model: modeLabel,
        display_name: displayName,
      }),
    });
    return result?.agent_id && result?.token ? result : null;
  }

  async function createParticipantSession(api, options) {
    const {
      threadId,
      threadTopic,
      uiAgent,
      participantAgent,
      config,
      isFirstAgent,
    } = options;
    const result = await api(`/api/threads/${threadId}/cli-sessions`, {
      method: "POST",
      headers: {
        "X-Agent-Token": uiAgent.token,
      },
      body: JSON.stringify({
        adapter: config.adapter,
        mode: config.mode,
        initial_instruction: config.initialInstruction || "",
        requested_by_agent_id: uiAgent.agent_id,
        participant_agent_id: participantAgent.agent_id,
        participant_display_name: participantAgent.display_name || buildDefaultParticipantName(config),
        cols: 120,
        rows: 32,
      }),
    });
    return result?.session || null;
  }

  function openThreadModal(api) {
    const launchThreadOnly = document.querySelector('input[name="thread-launch-mode"][value="thread_only"]');
    if (launchThreadOnly) {
      launchThreadOnly.checked = true;
    }
    resetAgentForm("thread-agent");
    setModalVisible("thread", true);
    syncThreadLaunchUi();
    setTimeout(() => document.getElementById("modal-topic").focus(), 100);
    if (api) {
      _loadTemplates(api).then((templates) => _populateTemplateDropdown(templates));
    }
  }

  function closeThreadModal(e) {
    if (!e || isOverlayClick(e, "thread")) {
      setModalVisible("thread", false);
    }
  }

  async function submitThreadModal(deps) {
    const { api, refreshThreads, selectThread } = deps;
    const topicInput = document.getElementById("modal-topic");
    const topic = topicInput.value.trim();
    if (!topic) return;

    const templateSel = document.getElementById("modal-template");
    const template = templateSel ? templateSel.value || null : null;
    const launchMode = getThreadLaunchMode();
    const shouldLaunchFirstAgent = launchMode === "thread_with_agent";
    const firstAgentConfig = shouldLaunchFirstAgent ? readAgentLaunchConfig("thread-agent") : null;

    // UI-14: get or register a browser-session agent to provide auth for thread creation
    const uiAgent = window.AcbUiAgent ? await window.AcbUiAgent.ensureUiAgent() : null;
    if (!uiAgent) {
      console.error("[Thread Create] Could not obtain UI agent token -- cannot create thread");
      return;
    }

    let creatorAuth = uiAgent;
    let participantAgent = null;
    if (shouldLaunchFirstAgent && firstAgentConfig) {
      participantAgent = await registerParticipantAgent(api, firstAgentConfig);
      if (!participantAgent) {
        console.error("[Thread Create] Could not register participant agent");
        return;
      }
      creatorAuth = {
        agent_id: participantAgent.agent_id,
        token: participantAgent.token,
      };
    }

    topicInput.value = "";
    if (templateSel) templateSel.value = "";
    const descEl = document.getElementById("modal-template-desc");
    if (descEl) descEl.textContent = "";
    resetAgentForm("thread-agent");
    const launchThreadOnly = document.querySelector('input[name="thread-launch-mode"][value="thread_only"]');
    if (launchThreadOnly) {
      launchThreadOnly.checked = true;
    }
    syncThreadLaunchUi();
    closeThreadModal();

    const t = await api("/api/threads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Token": creatorAuth.token,
      },
      body: JSON.stringify({
        topic,
        creator_agent_id: creatorAuth.agent_id,
        assign_creator_admin: shouldLaunchFirstAgent,
        ...(template ? { template } : {}),
      }),
    });
    if (t) {
      if (shouldLaunchFirstAgent && participantAgent && firstAgentConfig) {
        await createParticipantSession(api, {
          threadId: t.id,
          threadTopic: topic,
          uiAgent,
          participantAgent,
          config: firstAgentConfig,
          isFirstAgent: true,
        });
      }
      const syncContext =
        typeof t.current_seq === "number" && t.reply_token
          ? {
              current_seq: t.current_seq,
              reply_token: t.reply_token,
              reply_window: t.reply_window || null,
            }
          : null;
      await refreshThreads();
      selectThread(t.id, t.topic, t.status, syncContext);
      if (window.AcbChat && typeof window.AcbChat.refreshThreadAdmin === "function") {
        await window.AcbChat.refreshThreadAdmin(t.id, api);
      }
    }
  }

  async function openAddAgentModal(api) {
    const threadId = window.currentThreadId;
    if (!threadId) {
      return;
    }
    resetAgentForm("agent-modal");
    resetAutoAssembleForm();
    switchAddAgentTab("manual");
    const threadTitle = document.getElementById("thread-title")?.textContent?.trim() || "current thread";
    const hintEl = document.getElementById("agent-modal-context");
    const roleHintEl = document.getElementById("agent-modal-hint");
    if (hintEl) {
      hintEl.textContent = `Launch another agent session into "${threadTitle}".`;
    }
    if (roleHintEl && api) {
      try {
        const agentsRes = await api(`/api/threads/${threadId}/agents`);
        const count = Array.isArray(agentsRes) ? agentsRes.length : 0;
        roleHintEl.textContent = count > 0
          ? "New agents join as participants."
          : "The first launched agent in this thread will become the administrator.";
      } catch {
        roleHintEl.textContent = "New agents join as participants unless they are the first active agent in the thread.";
      }
    }
    setModalVisible("agent", true);
  }

  function closeAddAgentModal(e) {
    if (!e || isOverlayClick(e, "agent")) {
      setModalVisible("agent", false);
    }
  }

  async function submitAddAgentModal(deps) {
    const { api, refreshAgents } = deps;
    const threadId = window.currentThreadId;
    if (!threadId) {
      return;
    }
    if (getAddAgentTab() !== "manual") {
      return;
    }
    const uiAgent = window.AcbUiAgent ? await window.AcbUiAgent.ensureUiAgent() : null;
    if (!uiAgent) {
      console.error("[Add Agent] Could not obtain UI agent token");
      return;
    }

    const config = readAgentLaunchConfig("agent-modal");
    const participantAgent = await registerParticipantAgent(api, config);
    if (!participantAgent) {
      console.error("[Add Agent] Could not register participant agent");
      return;
    }

    const threadTopic = document.getElementById("thread-title")?.textContent?.trim() || "current thread";
    const session = await createParticipantSession(api, {
      threadId,
      threadTopic,
      uiAgent,
      participantAgent,
      config,
      isFirstAgent: false,
    });
    if (!session) {
      console.error("[Add Agent] Failed to create participant CLI session");
      return;
    }

    closeAddAgentModal();
    if (typeof refreshAgents === "function") {
      await refreshAgents();
    }
    if (window.AcbCliSessions && typeof window.AcbCliSessions.refreshThread === "function") {
      await window.AcbCliSessions.refreshThread(threadId, api);
      if (typeof window.AcbCliSessions.selectSession === "function") {
        window.AcbCliSessions.selectSession(session.id, threadId);
      }
    }
    if (window.AcbChat && typeof window.AcbChat.refreshThreadAdmin === "function") {
      await window.AcbChat.refreshThreadAdmin(threadId, api);
    }
  }

  let _settingsManifest = null;

  function _escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function _diagnosticsToolsCardHtml() {
    return `
      <div class="settings-card diag-card">
        <div class="diag-subtitle" style="margin-bottom: 12px; font-size: 13px; color: var(--text-2);">
          Run a self-test to verify Database, MCP Tools, and Agent connectivity.
        </div>
        <button class="btn-primary diag-run-btn" id="btn-run-diagnostics" onclick="window.runDiagnostics(this)" style="width: 100%; margin-bottom: 12px;">Run Diagnostics <span id="diag-btn-emoji"></span></button>
        <div id="diagnostics-results" class="diag-terminal" style="display: none; background: #0c0c0c; color: #00ff00; font-family: monospace; padding: 12px; border-radius: 6px; font-size: 12px; white-space: pre-wrap; line-height: 1.5; max-width: 100%; box-sizing: border-box; overflow-wrap: anywhere; word-break: break-word; overflow-x: hidden;"></div>
        <button class="btn-secondary diag-copy-btn" id="btn-copy-diagnostics" onclick="window.copyDiagnosticsReport(this)" style="width: 100%; display: none; margin-top: 12px;">Copy Diagnostic Report</button>
      </div>
    `;
  }

  function _renderField(field) {
    const descHtml = field.description
      ? `<div class="settings-field-description">${_escapeHtml(field.description)}</div>`
      : "";
    const envLockHtml = field.readonly_reason
      ? `<div class="settings-field-note">${_escapeHtml(field.readonly_reason)}</div>`
      : "";
    const valueSourceHtml = field.value_source === "env"
      ? `<div class="settings-field-note">Value source: startup parameter / environment</div>`
      : "";
    const restartHtml = field.restart_required
      ? `<div class="settings-field-note">Requires restart</div>`
      : "";
    const disabledAttr = field.editable ? "" : " disabled";
    const inputId = _escapeHtml(field.input_id);
    const label = _escapeHtml(field.label);

    if (field.type === "boolean") {
      return `
        <div class="settings-field-container" style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px;">
          <div class="settings-field settings-field-row" style="margin-bottom:0;">
            <span style="font-size:13px;color:var(--text-1);font-weight:500;">${label}</span>
            <label class="toggle-switch" for="${inputId}">
              <input id="${inputId}" type="checkbox"${field.value ? " checked" : ""}${disabledAttr} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          ${descHtml}
          ${valueSourceHtml}
          ${envLockHtml}
          ${restartHtml}
        </div>`;
    }

    if (field.type === "string[]") {
      const listValue = Array.isArray(field.value) ? field.value.join(", ") : "";
      return `
        <div class="settings-field" style="margin-bottom:8px;">
          <label for="${inputId}">${label}</label>
          <textarea id="${inputId}" rows="3"${disabledAttr}>${_escapeHtml(listValue)}</textarea>
          ${descHtml}
          ${valueSourceHtml}
          ${envLockHtml}
          ${restartHtml}
        </div>`;
    }

    if (field.type === "enum") {
      const options = Array.isArray(field.options) ? field.options : [];
      const currentValue = String(field.value ?? "");
      const optionHtml = options.map((option) => `
        <option value="${_escapeHtml(option.value)}"${option.value === currentValue ? " selected" : ""}>${_escapeHtml(option.label)}</option>
      `).join("");
      return `
        <div class="settings-field" style="margin-bottom:8px;">
          <label for="${inputId}">${label}</label>
          <select id="${inputId}"${disabledAttr}>${optionHtml}</select>
          ${descHtml}
          ${valueSourceHtml}
          ${envLockHtml}
          ${restartHtml}
        </div>`;
    }

    const inputType = field.type === "integer" || field.type === "number" ? "number" : "text";
    const minAttr = field.min !== undefined ? ` min="${field.min}"` : "";
    const maxAttr = field.max !== undefined ? ` max="${field.max}"` : "";
    const stepAttr = field.step !== undefined ? ` step="${field.step}"` : "";
    const rawValue = field.value === undefined || field.value === null ? "" : String(field.value);

    return `
      <div class="settings-field" style="margin-bottom:8px;">
        <label for="${inputId}">${label}</label>
        <input id="${inputId}" type="${inputType}" value="${_escapeHtml(rawValue)}"${minAttr}${maxAttr}${stepAttr}${disabledAttr} />
        ${descHtml}
        ${valueSourceHtml}
        ${envLockHtml}
        ${restartHtml}
      </div>`;
  }

  function _renderSectionPane(section) {
    if (section.id === "ui") {
      const html = window.AcbModalShell?.renderUiPreferencesHtml
        ? window.AcbModalShell.renderUiPreferencesHtml()
        : "";
      return `
        <div id="pane-ui" class="settings-tab-pane">
          <div class="settings-section-title">PREFERENCES</div>
          <div class="settings-card">${html}</div>
        </div>`;
    }

    const fieldsHtml = (section.fields || []).map(_renderField).join("");
    const diagnosticsHtml = section.id === "diagnostics" ? _diagnosticsToolsCardHtml() : "";

    return `
      <div id="pane-${_escapeHtml(section.id)}" class="settings-tab-pane${section.active ? " active" : ""}">
        <div class="settings-section-title">${_escapeHtml(String(section.title || "").toUpperCase())}</div>
        ${fieldsHtml ? `<div class="settings-card">${fieldsHtml}</div>` : ""}
        ${diagnosticsHtml}
      </div>`;
  }

  function _buildSettingsSections(manifest) {
    const serverSections = Array.isArray(manifest?.sections) ? manifest.sections : [];
    const diagnosticsSection = serverSections.find((section) => section.id === "diagnostics") || {
      id: "diagnostics",
      nav_label: "Diagnostics",
      title: "Runtime Configuration",
      fields: [],
      order: 999,
    };
    const visibleServerSections = serverSections
      .filter((section) => section.id !== "diagnostics")
      .sort((left, right) => (left.order || 0) - (right.order || 0));

    return [
      ...visibleServerSections,
      { id: "ui", nav_label: "UI", title: "Preferences", fields: [], order: 95 },
      diagnosticsSection,
    ];
  }

  function _renderSettingsManifest(manifest) {
    const sidebar = document.getElementById("settings-sidebar");
    const content = document.getElementById("settings-content");
    if (!sidebar || !content) return;

    const sections = _buildSettingsSections(manifest);
    const activeSectionId = sections[0]?.id || "agent";

    sidebar.innerHTML = sections.map((section, index) => `
      <div id="nav-${_escapeHtml(section.id)}" class="settings-nav-item${index === 0 ? " active" : ""}" onclick="switchSettingsTab('${_escapeHtml(section.id)}')">
        ${_escapeHtml(section.nav_label || section.title || section.id)}
      </div>
    `).join("") + '<div style="flex-grow: 1;"></div>';

    content.innerHTML = sections
      .map((section, index) => _renderSectionPane({ ...section, active: index === 0 }))
      .join("");

    if (window.AcbModalShell?.bindMinimapCheckbox) {
      window.AcbModalShell.bindMinimapCheckbox();
    } else if (window.AcbModalShell?.syncMinimapCheckbox) {
      window.AcbModalShell.syncMinimapCheckbox();
    }

    window.switchSettingsTab(activeSectionId);
  }

  function _parseFieldValue(field) {
    const input = document.getElementById(field.input_id);
    if (!input) return undefined;

    if (field.type === "boolean") {
      return !!input.checked;
    }
    if (field.type === "integer") {
      return parseInt(input.value, 10);
    }
    if (field.type === "number") {
      return Number(input.value);
    }
    if (field.type === "string[]") {
      return String(input.value || "")
        .split(/[\n,]/g)
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return input.value;
  }

  async function openSettingsModal(api) {
    document.getElementById("settings-message").style.display = "none";
    setModalVisible("settings", true);
    try {
      const manifest = await api("/api/settings/manifest");
      if (manifest) {
        _settingsManifest = manifest;
        _renderSettingsManifest(manifest);
      }
    } catch (err) {
      console.error(err);
    }
  }

  function closeSettingsModal(e) {
    if (e && !isOverlayClick(e, "settings")) return;
    setModalVisible("settings", false);
  }

  async function submitSettings(api) {
    const payload = {};
    const sections = Array.isArray(_settingsManifest?.sections) ? _settingsManifest.sections : [];
    for (const section of sections) {
      for (const field of Array.isArray(section.fields) ? section.fields : []) {
        if (!field.editable) continue;
        payload[field.key] = _parseFieldValue(field);
      }
    }

    const msg = document.getElementById("settings-message");

    try {
      const res = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      if (res && res.ok) {
        msg.textContent = res.message || _settingsManifest?.save_message || "Saved! Restart server to apply.";
        msg.style.display = "block";
        msg.style.color = "var(--green)";
        setTimeout(() => closeSettingsModal(), 2500);
      } else if (msg) {
        const detail = Array.isArray(res?.errors)
          ? res.errors.join("; ")
          : (res?.detail || "Error saving settings");
        msg.textContent = detail;
        msg.style.display = "block";
        msg.style.color = "var(--red, #f05555)";
      }
    } catch (err) {
      console.error(err);
      if (msg) {
        msg.textContent = "Error saving settings";
        msg.style.display = "block";
        msg.style.color = "var(--red, #f05555)";
      }
    }
  }

  // Thread Settings Modal Functions
  async function openThreadSettingsModal(api) {
    const threadId = window.currentThreadId;
    if (!threadId) {
      console.error("No current thread selected");
      return;
    }

    document.getElementById("thread-settings-message").style.display = "none";
    setModalVisible("thread-settings", true);

    let agentEmojiById = new Map();
    try {
      const agentsRes = await api("/api/agents");
      if (Array.isArray(agentsRes)) {
        agentEmojiById = new Map(
          agentsRes
            .map((a) => [String(a?.id || "").trim(), String(a?.emoji || "").trim()])
            .filter(([id, emoji]) => id && emoji)
        );
      }
    } catch (err) {
      console.warn("Unable to load agent emoji map:", err);
    }

    try {
      const res = await api(`/api/threads/${threadId}/settings`);
      if (res) {
        document.getElementById("ts-timeout-seconds").value = res.timeout_seconds || 60;
        document.getElementById("ts-switch-timeout-seconds").value = res.switch_timeout_seconds || 60;
      }
    } catch (err) {
      console.error("Error loading thread settings:", err);
    }

    // Load current admin info
    try {
      const adminRes = await api(`/api/threads/${threadId}/admin`);
      if (adminRes) {
        // Show current admin (creator or auto-assigned)
        const currentAdminEl = document.getElementById("ts-current-admin");
        const adminLabel = adminRes.admin_name || adminRes.admin_id;
        if (adminLabel) {
          const adminId = String(adminRes.admin_id || "").trim();
          const emoji = (adminId ? agentEmojiById.get(adminId) : "") || String(adminRes.admin_emoji || "").trim() || "🤖";
          const typeLabel = adminRes.admin_type === "creator" ? " (Creator)" : " (Auto-assigned)";
          currentAdminEl.textContent = `${emoji} ${adminLabel}${typeLabel}`;
        } else {
          currentAdminEl.textContent = "Unassigned";
        }
      }
    } catch (err) {
      console.error("Error loading admin info:", err);
    }

  }

  function closeThreadSettingsModal(e) {
    if (e && !isOverlayClick(e, "thread-settings")) return;
    setModalVisible("thread-settings", false);
  }

  async function submitThreadSettings(api) {
    const threadId = window.currentThreadId;
    if (!threadId) {
      console.error("No current thread selected");
      return;
    }

    const timeoutInput = document.getElementById("ts-timeout-seconds");
    const switchTimeoutInput = document.getElementById("ts-switch-timeout-seconds");

    // Validation using HTML5 Native checking
    if (!timeoutInput.reportValidity()) return;
    if (!switchTimeoutInput.reportValidity()) return;

    const timeoutSeconds = parseInt(timeoutInput.value, 10);
    const switchTimeoutSeconds = parseInt(switchTimeoutInput.value, 10);

    const msg = document.getElementById("thread-settings-message");
    const cancelBtn = document.getElementById("ts-btn-cancel");
    const saveBtn = document.getElementById("ts-btn-save");

    const setSubmittingState = (submitting) => {
      if (cancelBtn) cancelBtn.disabled = submitting;
      if (saveBtn) {
        saveBtn.disabled = submitting;
        saveBtn.style.cursor = submitting ? "not-allowed" : "pointer";
      }
    };
    let keepDisabledUntilClose = false;

    try {
      setSubmittingState(true);

      const res = await api(`/api/threads/${threadId}/settings`, {
        method: "POST",
        body: JSON.stringify({
          // Auto administrator stays enabled by default and is not user-configurable in UI.
          auto_administrator_enabled: true,
          auto_coordinator_enabled: true,
          timeout_seconds: timeoutSeconds,
          switch_timeout_seconds: switchTimeoutSeconds,
        }),
      });

      if (!res) {
        throw new Error("No response from server");
      }

      if (res.detail || res.error) {
        const detailText = typeof res.detail === "string" ? res.detail : "Error saving settings";
        msg.textContent = detailText;
        msg.style.display = "block";
        msg.style.color = "var(--red, #f05555)";
        return;
      }

      msg.textContent = "Settings saved successfully!";
      msg.style.display = "block";
      msg.style.color = "var(--green)";
      keepDisabledUntilClose = true;
      setTimeout(() => {
        setSubmittingState(false);
        closeThreadSettingsModal();
      }, 1500);
    } catch (err) {
      console.error("Error saving thread settings:", err);
      msg.textContent = "Error saving settings";
      msg.style.display = "block";
      msg.style.color = "var(--red, #f05555)";
    } finally {
      if (keepDisabledUntilClose) return;
      setSubmittingState(false);
    }
  }

  window.AcbModals = {
    positionDialogNearClick,
    openThreadModal,
    closeThreadModal,
    submitThreadModal,
    syncThreadLaunchUi,
    openAddAgentModal,
    closeAddAgentModal,
    submitAddAgentModal,
    switchAddAgentTab,
    openSettingsModal,
    closeSettingsModal,
    submitSettings,
    openThreadSettingsModal,
    closeThreadSettingsModal,
    submitThreadSettings,
  };

  // Global wrappers for onclick handlers
  function _resolveApi() {
    if (window.AcbApi && typeof window.AcbApi.api === "function") {
      return window.AcbApi.api;
    }
    throw new Error("API layer is not ready: window.AcbApi.api is unavailable");
  }

  window.openThreadSettingsModal = function() {
    const api = _resolveApi();
    openThreadSettingsModal(api);
  };
  window.closeThreadSettingsModal = closeThreadSettingsModal;
  window.openAddAgentModal = function() {
    const api = _resolveApi();
    return openAddAgentModal(api);
  };
  window.closeAddAgentModal = closeAddAgentModal;
  window.submitAddAgentModal = function() {
    const api = _resolveApi();
    return submitAddAgentModal({
      api,
      refreshAgents: typeof window.refreshAgents === "function" ? window.refreshAgents : null,
    });
  };
  window.submitThreadSettings = function() {
    const api = _resolveApi();
    submitThreadSettings(api);
  };

  window.runDiagnostics = async function (btn) {
    const resultsEl = document.getElementById("diagnostics-results");
    const copyBtn = document.getElementById("btn-copy-diagnostics");
    if (!resultsEl || !copyBtn) return;

    btn.disabled = true;
    btn.innerHTML = 'Running... <span id="diag-btn-emoji">⏳</span>';
    resultsEl.style.display = "block";
    resultsEl.textContent = "Connecting to backend...\n";
    copyBtn.style.display = "none";

    let allOk = true;

    try {
      const api = _resolveApi();
      const start = performance.now();
      const res = await api("/api/system/diagnostics");
      const rtt = Math.round(performance.now() - start);

      let out = "";

      out += "========================================================\n"
      out += "                   SYSTEM OVERVIEW                      \n"
      out += "========================================================\n"
      out += `App Directory: ${res.app_dir}\n`;
      out += `Database Path: ${res.db_path}\n`;

      const upHours = Math.floor(res.uptime_seconds / 3600);
      const upMins = Math.floor((res.uptime_seconds % 3600) / 60);
      const upSecs = res.uptime_seconds % 60;
      out += `Server Uptime: ${upHours}h ${upMins}m ${upSecs}s\n`;
      out += `Server Time  : ${res.server_time_utc}\n\n`;

      out += `SQLite Threads : ${res.total_threads}\n`;
      out += `SQLite Messages: ${res.total_messages}\n\n`;

      out += "========================================================\n"
      out += "                 TRANSPORT & SERVICES                   \n"
      out += "========================================================\n"
      out += `[DB] SQLite Check: ${res.db_ok ? "✅ OK" : "❌ FAIL"} (${res.db_latency_ms}ms)\n`;
      if (!res.db_ok) allOk = false;

      out += `[MCP] Service Check: ${res.mcp_ok ? "✅ OK" : "❌ FAIL"}\n`;
      out += `      Tools    : ${res.mcp_tools_count}\n`;
      out += `      Prompts  : ${res.mcp_prompts_count}\n`;
      out += `      Resources: ${res.mcp_resources_count}\n\n`;
      if (!res.mcp_ok) allOk = false;

      out += `[NET] TCP SSE Streams: ${res.active_sse_connections}\n`;
      out += `      SSE Loopback Test: ${res.sse_simulated_ok ? "✅ OK" : "❌ FAIL"}\n`;
      if (!res.sse_simulated_ok) allOk = false;

      out += `[AGT] Registered Agents: ${res.online_agents_total} Online\n`;
      out += `      SSE Transport: ${res.sse_agents_count}\n`;
      out += `      StdIO Transport: ${res.stdio_agents_count}\n`;

      let uiConnected = false;
      if (window.AcbSSE && typeof window.AcbSSE.isConnected === 'function') {
        uiConnected = window.AcbSSE.isConnected();
      } else if (window.AcbSSE) {
        uiConnected = window.AcbSSE.connected;
      }

      out += `\n[UI] SSE Event Stream: ${uiConnected ? "✅ CONNECTED" : "❌ DISCONNECTED"}\n\n`;
      if (!uiConnected) allOk = false;

      out += "========================================================\n"
      out += "                    DIAGNOSTIC LOGS                     \n"
      out += "========================================================\n"
      if (res.logs && Array.isArray(res.logs)) {
        res.logs.forEach(l => {
          out += `> ${l}\n`;
        });
      }

      resultsEl.textContent = out;
      copyBtn.style.display = "block";
    } catch (err) {
      resultsEl.textContent += `\n❌ Error: ${err.message || err}`;
      allOk = false;
    } finally {
      btn.disabled = false;
      btn.innerHTML = `Run Diagnostics <span id="diag-btn-emoji">${allOk ? "✅" : "❌"}</span>`;
    }
  };

  window.copyDiagnosticsReport = function (btn) {
    const resultsEl = document.getElementById("diagnostics-results");
    if (!resultsEl) return;

    const text = resultsEl.textContent;
    const report = "### AgentChatBus Diagnostics Report\n\n```text\n" + text + "\n```\n\n**User Agent**: " + navigator.userAgent + "\n**URL**: " + window.location.href;

    navigator.clipboard.writeText(report).then(() => {
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = orig; }, 2000);
    }).catch(err => {
      console.error("Failed to copy", err);
      alert("Failed to copy to clipboard");
    });
  };
})();
