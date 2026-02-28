(function registerAcbModalShell() {
  const SETTINGS_FIELDS = [
    { label: "Host", id: "setting-host", type: "text" },
    { label: "Port", id: "setting-port", type: "number" },
    { label: "Agent Heartbeat Timeout (s)", id: "setting-heartbeat", type: "number" },
    { label: "Wait Timeout (s)", id: "setting-wait", type: "number" },
  ];

  function renderSettingsFields() {
    return SETTINGS_FIELDS.map((field) => {
      return `
        <label style="display:block;font-size:13px;color:var(--text-2);margin-bottom:6px;">${field.label}</label>
        <input id="${field.id}" type="${field.type}"
          style="width:100%;background:var(--bg-input);border:1px solid var(--border-light);color:var(--text-1);border-radius:10px;padding:10px 14px;font-size:14px;font-family:inherit;margin-bottom:16px;" />`;
    }).join("\n");
  }

  class AcbModalShell extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <div id="modal-overlay" onclick="closeModal(event)">
          <div id="modal" onclick="event.stopPropagation()">
            <h3>✦ Create New Thread</h3>
            <input id="modal-topic" type="text" placeholder="Thread topic..." onkeydown="if(event.key==='Enter') submitModal()" />
            <div class="modal-actions">
              <button class="btn-secondary" onclick="closeModal()">Cancel</button>
              <button class="btn-primary" onclick="submitModal()">Create</button>
            </div>
          </div>
        </div>

        <div id="settings-modal-overlay" onclick="closeSettingsModal(event)"
          style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);align-items:center;justify-content:center;z-index:100;animation:fade-in .15s ease;">
          <div id="settings-modal"
            style="background:var(--bg-card);border:1px solid var(--border-light);border-radius:14px;padding:28px;width:440px;max-width:90vw;box-shadow:var(--shadow);animation:modal-in .2s ease;"
            onclick="event.stopPropagation()">
            <h3 style="font-size:16px;font-weight:600;margin-bottom:18px;color:var(--text-1)">⚙️ MCP Server Settings</h3>
            ${renderSettingsFields()}
            <div id="settings-message" style="font-size:12px;color:var(--green);margin-bottom:16px;display:none;"></div>
            <div class="modal-actions">
              <button class="btn-secondary" onclick="closeSettingsModal()">Cancel</button>
              <button class="btn-primary" onclick="submitSettings()">Save (Requires Restart)</button>
            </div>
          </div>
        </div>`;
    }
  }

  if (!customElements.get("acb-modal-shell")) {
    customElements.define("acb-modal-shell", AcbModalShell);
  }
})();
