(function () {
  const MODAL_CONFIGS = {
    thread: {
      overlayId: "modal-overlay",
      visibility: "class",
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

  function openThreadModal(api) {
    setModalVisible("thread", true);
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

    // UI-14: get or register a browser-session agent to provide auth for thread creation
    const uiAgent = window.AcbUiAgent ? await window.AcbUiAgent.ensureUiAgent() : null;
    if (!uiAgent) {
      console.error("[Thread Create] Could not obtain UI agent token -- cannot create thread");
      return;
    }

    topicInput.value = "";
    if (templateSel) templateSel.value = "";
    const descEl = document.getElementById("modal-template-desc");
    if (descEl) descEl.textContent = "";
    closeThreadModal();

    const t = await api("/api/threads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Token": uiAgent.token,
      },
      body: JSON.stringify({ topic, creator_agent_id: uiAgent.agent_id, ...(template ? { template } : {}) }),
    });
    if (t) {
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
    }
  }

  async function openSettingsModal(api) {
    document.getElementById("settings-message").style.display = "none";
    setModalVisible("settings", true);
    // UI-07: sync minimap checkbox state from localStorage
    if (window.AcbModalShell) window.AcbModalShell.syncMinimapCheckbox();
    try {
      const res = await api("/api/settings");
      if (res) {
        document.getElementById("setting-host").value = res.HOST || "0.0.0.0";
        document.getElementById("setting-port").value = res.PORT || 39765;
        document.getElementById("setting-heartbeat").value = res.AGENT_HEARTBEAT_TIMEOUT || 30;
        document.getElementById("setting-wait").value = res.MSG_WAIT_TIMEOUT || 300;

        if (document.getElementById("setting-handoff-target")) {
          document.getElementById("setting-handoff-target").checked = !!res.ENABLE_HANDOFF_TARGET;
        }
        if (document.getElementById("setting-stop-reason")) {
          document.getElementById("setting-stop-reason").checked = !!res.ENABLE_STOP_REASON;
        }
        if (document.getElementById("setting-priority")) {
          document.getElementById("setting-priority").checked = !!res.ENABLE_PRIORITY;
        }
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
    const pHost = document.getElementById("setting-host").value;
    const pPort = parseInt(document.getElementById("setting-port").value, 10);
    const pHb = parseInt(document.getElementById("setting-heartbeat").value, 10);
    const pWait = parseInt(document.getElementById("setting-wait").value, 10);

    const pHandoffTarget = document.getElementById("setting-handoff-target") ? document.getElementById("setting-handoff-target").checked : false;
    const pStopReason = document.getElementById("setting-stop-reason") ? document.getElementById("setting-stop-reason").checked : false;
    const pPriority = document.getElementById("setting-priority") ? document.getElementById("setting-priority").checked : false;

    try {
      const res = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          HOST: pHost,
          PORT: pPort,
          AGENT_HEARTBEAT_TIMEOUT: pHb,
          MSG_WAIT_TIMEOUT: pWait,
          ENABLE_HANDOFF_TARGET: pHandoffTarget,
          ENABLE_STOP_REASON: pStopReason,
          ENABLE_PRIORITY: pPriority,
        }),
      });
      if (res && res.ok) {
        const msg = document.getElementById("settings-message");
        msg.textContent = res.message || "Saved! Restart server to apply.";
        msg.style.display = "block";
        setTimeout(() => closeSettingsModal(), 2500);
      }
    } catch (err) {
      console.error(err);
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

    const timeoutSeconds = parseInt(document.getElementById("ts-timeout-seconds").value, 10);
    const switchTimeoutSeconds = parseInt(document.getElementById("ts-switch-timeout-seconds").value, 10);

    // Validation
    if (isNaN(timeoutSeconds) || timeoutSeconds < 30) {
      alert("Inactivity Intervention Delay must be at least 30 seconds.");
      return;
    }
    if (isNaN(switchTimeoutSeconds) || switchTimeoutSeconds < 30) {
      alert("Switch Confirmation Delay must be at least 30 seconds.");
      return;
    }

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
    openThreadModal,
    closeThreadModal,
    submitThreadModal,
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
