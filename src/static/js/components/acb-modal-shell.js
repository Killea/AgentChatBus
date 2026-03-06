(function registerAcbModalShell() {
  const NETWORK_FIELDS = [
    {
      label: "Host",
      id: "setting-host",
      type: "text",
      description: "The IP address or hostname the server binds to. Use '127.0.0.1' for local-only access (secure), or '0.0.0.0' to allow agents from other machines on the network."
    },
    {
      label: "Port",
      id: "setting-port",
      type: "number",
      description: "The TCP network port the server listens on (Default: 39765). Ensure this port is open in your firewall if you plan to connect external agents."
    },
  ];

  const AGENT_FIELDS = [
    {
      label: "Agent Heartbeat Timeout (s)",
      id: "setting-heartbeat",
      type: "number",
      note: "⚠️ Only applies to stdio-transport agents. SSE agents (Cursor, Claude Desktop) detect disconnection instantly via the live TCP connection.",
    },
    {
      label: "Default 'msg_wait' Timeout (s)",
      id: "setting-wait",
      type: "number",
      min: 30,
      description: "Fallback maximum blocking duration when agents do not specify an explicit timeout in their msg_wait requests. Lower values prevent network disconnects but result in more frequent, chatty retries."
    },
  ];

  const ATTENTION_FIELDS = [
    {
      label: "Handoff Target Mechanism",
      id: "setting-handoff-target",
      type: "toggle",
      description: "Controls whether agents can explicitly route messages to one another. Disabling this saves token output and prevents agents from over-thinking coordination."
    },
    {
      label: "Stop Reason Mechanism",
      id: "setting-stop-reason",
      type: "toggle",
      description: "Controls whether agents must justify ending their turn. Disabling this avoids agents wasting attention on selecting the right exit status."
    },
    {
      label: "Message Priority Mechanism",
      id: "setting-priority",
      type: "toggle",
      description: "Controls whether agents can mark messages as 'urgent' or 'system'. Disabling this prevents agents from hyper-fixating on message priority."
    },
  ];

  const MINIMAP_KEY = "acb-minimap-enabled";

  function renderFields(fields) {
    return fields.map((field) => {
      const noteHtml = field.note
        ? `<div class="settings-field-note">${field.note}</div>`
        : "";
      const descHtml = field.description
        ? `<div class="settings-field-description">${field.description}</div>`
        : "";

      if (field.type === "toggle") {
        return `
          <div class="settings-field-container" style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px;">
            <div class="settings-field settings-field-row" style="margin-bottom:0;">
              <span style="font-size:13px;color:var(--text-1);font-weight:500;">${field.label}</span>
              <label class="toggle-switch" for="${field.id}">
                <input id="${field.id}" type="checkbox" />
                <span class="toggle-slider"></span>
              </label>
            </div>
            ${descHtml}
            ${noteHtml}
          </div>`;
      }

      const minAttr = field.min !== undefined ? ` min="${field.min}"` : "";

      return `
        <div class="settings-field" style="margin-bottom:8px;">
          <label>${field.label}</label>
          <input id="${field.id}" type="${field.type}"${minAttr} />
          ${descHtml}
          ${noteHtml}
        </div>`;
    }).join("\n");
  }

  function renderUiPreferences() {
    return `
      <div class="settings-field settings-field-row">
        <span style="font-size:13px;color:var(--text-1);font-weight:500;">Message minimap (Navigation sidebar)</span>
        <label class="toggle-switch" for="setting-minimap">
          <input id="setting-minimap" type="checkbox" />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="settings-field-note" style="margin-top: 4px;">Scrollable anchor list on the right — toggle without restart.</div>
    `;
  }

  window.switchSettingsTab = function (tabId) {
    document.querySelectorAll('.settings-nav-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.settings-tab-pane').forEach(el => el.classList.remove('active'));

    const navItem = document.getElementById('nav-' + tabId);
    if (navItem) navItem.classList.add('active');

    const pane = document.getElementById('pane-' + tabId);
    if (pane) pane.classList.add('active');
  };

  class AcbModalShell extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <div id="modal-overlay" onclick="closeModal(event)">
          <div id="modal" onclick="event.stopPropagation()">
            <h3>✦ Create New Thread</h3>
            <input id="modal-topic" type="text" placeholder="Thread topic..." onkeydown="if(event.key==='Enter') submitModal()" />
            <div class="template-selector-wrap">
              <label class="template-selector-label" for="modal-template">Template</label>
              <select id="modal-template">
                <option value="">No template</option>
              </select>
              <span id="modal-template-desc" class="template-description"></span>
            </div>
            <div class="modal-actions">
              <button class="btn-secondary" onclick="closeModal()">Cancel</button>
              <button id="btn-create-thread" class="btn-primary" onclick="submitModal()" disabled>Create</button>
            </div>
          </div>
        </div>

        <div id="settings-modal-overlay" onclick="closeSettingsModal(event)"
          style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);align-items:center;justify-content:center;z-index:100;animation:fade-in .15s ease;">
          <div id="settings-modal" class="settings-modal-container" onclick="event.stopPropagation()">
            <div class="settings-modal-header">
              <h3>Settings - AgentChatBus</h3>
              <button class="settings-close-btn" onclick="closeSettingsModal()">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>
            <div class="settings-modal-body">
              <div class="settings-sidebar">
                <div id="nav-agent" class="settings-nav-item active" onclick="switchSettingsTab('agent')">Agent</div>
                <div id="nav-attention" class="settings-nav-item" onclick="switchSettingsTab('attention')">Attention</div>
                <div id="nav-network" class="settings-nav-item" onclick="switchSettingsTab('network')">Network</div>
                <div id="nav-ui" class="settings-nav-item" onclick="switchSettingsTab('ui')">UI</div>
              </div>
              <div class="settings-content">
                <div id="pane-agent" class="settings-tab-pane active">
                  <div class="settings-section-title">TIMEOUTS</div>
                  <div class="settings-card">
                    ${renderFields(AGENT_FIELDS)}
                  </div>
                </div>
                <div id="pane-attention" class="settings-tab-pane">
                  <div class="settings-section-title">ATTENTION MECHANISMS</div>
                  <div class="settings-card">
                    ${renderFields(ATTENTION_FIELDS)}
                  </div>
                </div>
                <div id="pane-network" class="settings-tab-pane">
                  <div class="settings-section-title">LISTENING</div>
                  <div class="settings-card">
                    ${renderFields(NETWORK_FIELDS)}
                  </div>
                </div>
                <div id="pane-ui" class="settings-tab-pane">
                  <div class="settings-section-title">PREFERENCES</div>
                  <div class="settings-card">
                    ${renderUiPreferences()}
                  </div>
                </div>
              </div>
            </div>
            <div class="settings-modal-footer">
              <div id="settings-message" style="font-size:13px;color:var(--green);display:none;"></div>
              <div style="flex:1"></div>
              <button class="btn-primary" id="btn-settings-save" onclick="submitSettings()">Save (Requires Restart)</button>
            </div>
          </div>
        </div>

        <div id="thread-settings-modal-overlay" onclick="closeThreadSettingsModal(event)"
          style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);align-items:center;justify-content:center;z-index:100;animation:fade-in .15s ease;">
          <div id="thread-settings-modal"
            style="background:var(--bg-card);border:1px solid var(--border-light);border-radius:14px;padding:28px;width:480px;max-width:90vw;box-shadow:var(--shadow);animation:modal-in .2s ease;"
            onclick="event.stopPropagation()">
            <h3 style="font-size:16px;font-weight:600;margin-bottom:18px;color:var(--text-1)">⚙️ Thread Settings</h3>
            
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-2);margin-bottom:6px;">
              Administrator Confirmation Delay (seconds)
              <span
                title="When all currently online participants stay in msg_wait for this long, the system creates a human-only administrator confirmation card. Minimum 30 seconds; no maximum."
                aria-label="When all currently online participants stay in msg_wait for this long, the system creates a human-only administrator confirmation card. Minimum 30 seconds; no maximum."
                style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:1px solid var(--border-light);border-radius:50%;font-size:11px;line-height:1;cursor:help;color:var(--text-2);"
              >i</span>
            </label>
            <input id="ts-timeout-seconds" type="number" min="30" value="60"
              style="width:100%;background:var(--bg-input);border:1px solid var(--border-light);color:var(--text-1);border-radius:10px;padding:10px 14px;font-size:14px;font-family:inherit;margin-bottom:16px;" />
            
            <div style="background:var(--bg-input);border:1px solid var(--border-light);border-radius:10px;padding:12px;margin-bottom:16px;font-size:13px;color:var(--text-2);">
              <div><strong>Current Administrator:</strong> <span id="ts-current-admin">Unassigned</span></div>
            </div>
            
            <div id="thread-settings-message" style="font-size:12px;color:var(--green);margin-bottom:16px;display:none;"></div>
            
            <div class="modal-actions">
              <button id="ts-btn-cancel" class="btn-secondary" onclick="closeThreadSettingsModal()">Cancel</button>
              <button id="ts-btn-save" class="btn-primary" onclick="submitThreadSettings()">Save</button>
            </div>
          </div>
        </div>`;

      // Attach minimap toggle listener after DOM is built
      this._attachMinimapToggle();
      // UI-14: enable Create button only when topic is non-empty
      this._attachTopicGuard();
    }

    _attachTopicGuard() {
      const input = this.querySelector("#modal-topic");
      const btn = this.querySelector("#btn-create-thread");
      if (!input || !btn) return;
      const sync = () => { btn.disabled = input.value.trim().length === 0; };
      input.addEventListener("input", sync);
      // Re-sync when modal is opened (topic may have been cleared)
      const overlay = this.querySelector("#modal-overlay");
      if (overlay) {
        const observer = new MutationObserver(() => sync());
        observer.observe(overlay, { attributes: true, attributeFilter: ["style"] });
      }
    }

    _attachMinimapToggle() {
      const checkbox = this.querySelector("#setting-minimap");
      if (!checkbox) return;

      // Read saved state (default: enabled)
      const saved = localStorage.getItem(MINIMAP_KEY);
      checkbox.checked = saved === null ? true : saved === "true";

      // Apply immediately on change (no restart needed)
      checkbox.addEventListener("change", () => {
        const enabled = checkbox.checked;
        localStorage.setItem(MINIMAP_KEY, String(enabled));
        if (window.AcbNavSidebar) {
          window.AcbNavSidebar.setEnabled(enabled);
        } else {
          document.body.classList.toggle("minimap-hidden", !enabled);
        }
      });
    }
  }

  // Expose helper so shared-modals.js openSettingsModal can sync the checkbox state
  window.AcbModalShell = {
    syncMinimapCheckbox() {
      const checkbox = document.getElementById("setting-minimap");
      if (!checkbox) return;
      const saved = localStorage.getItem(MINIMAP_KEY);
      checkbox.checked = saved === null ? true : saved === "true";
    },
  };

  if (!customElements.get("acb-modal-shell")) {
    customElements.define("acb-modal-shell", AcbModalShell);
  }
})();
