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
    if (_templates) return _templates;
    try {
      const result = await api("/api/templates");
      _templates = Array.isArray(result) ? result : [];
    } catch {
      _templates = [];
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

    topicInput.value = "";
    if (templateSel) templateSel.value = "";
    const descEl = document.getElementById("modal-template-desc");
    if (descEl) descEl.textContent = "";
    closeThreadModal();

    const t = await api("/api/threads", {
      method: "POST",
      body: JSON.stringify({ topic, ...(template ? { template } : {}) }),
    });
    if (t) {
      await refreshThreads();
      selectThread(t.id, t.topic, t.status);
    }
  }

  async function openSettingsModal(api) {
    document.getElementById("settings-message").style.display = "none";
    setModalVisible("settings", true);
    try {
      const res = await api("/api/settings");
      if (res) {
        document.getElementById("setting-host").value = res.HOST || "0.0.0.0";
        document.getElementById("setting-port").value = res.PORT || 39765;
        document.getElementById("setting-heartbeat").value = res.AGENT_HEARTBEAT_TIMEOUT || 30;
        document.getElementById("setting-wait").value = res.MSG_WAIT_TIMEOUT || 300;
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

    try {
      const res = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          HOST: pHost,
          PORT: pPort,
          AGENT_HEARTBEAT_TIMEOUT: pHb,
          MSG_WAIT_TIMEOUT: pWait,
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

  window.AcbModals = {
    openThreadModal,
    closeThreadModal,
    submitThreadModal,
    openSettingsModal,
    closeSettingsModal,
    submitSettings,
  };
})();
