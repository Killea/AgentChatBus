(function () {
  function openThreadModal() {
    document.getElementById("modal-overlay").classList.add("visible");
    setTimeout(() => document.getElementById("modal-topic").focus(), 100);
  }

  function closeThreadModal(e) {
    if (!e || e.target === document.getElementById("modal-overlay")) {
      document.getElementById("modal-overlay").classList.remove("visible");
    }
  }

  async function submitThreadModal(deps) {
    const { api, refreshThreads, selectThread } = deps;
    const topicInput = document.getElementById("modal-topic");
    const topic = topicInput.value.trim();
    if (!topic) return;

    topicInput.value = "";
    closeThreadModal();
    const t = await api("/api/threads", {
      method: "POST",
      body: JSON.stringify({ topic }),
    });
    if (t) {
      await refreshThreads();
      selectThread(t.id, t.topic, t.status);
    }
  }

  async function openSettingsModal(api) {
    document.getElementById("settings-message").style.display = "none";
    document.getElementById("settings-modal-overlay").style.display = "flex";
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
    if (e && e.target !== document.getElementById("settings-modal-overlay")) return;
    document.getElementById("settings-modal-overlay").style.display = "none";
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
