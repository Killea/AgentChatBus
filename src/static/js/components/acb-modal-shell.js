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
      label: "Agent Heartbeat Timeout (seconds)",
      id: "setting-heartbeat",
      type: "number",
      description: "Interval for checking if stdio-based agents are still alive. SSE agents (Cursor, Claude Desktop) detect disconnection instantly via the live TCP connection.",
    },
    {
      label: "Default 'msg_wait' Timeout (seconds)",
      id: "setting-wait",
      type: "number",
      min: 30,
      description: "Maximum blocking duration for agent message polling. Lower values prevent network disconnects but result in more frequent, chatty retries."
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
      <div class="settings-field-container" style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px;">
        <div class="settings-field settings-field-row" style="margin-bottom:0;">
          <span style="font-size:13px;color:var(--text-1);font-weight:500;">Message minimap (Navigation sidebar)</span>
          <label class="toggle-switch" for="setting-minimap">
            <input id="setting-minimap" type="checkbox" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="settings-field-description">Enable a scrollable anchor list of messages on the right side of the chat. Helps navigate long conversations using emojis.</div>
      </div>
    `;
  }

  window.switchSettingsTab = function (tabId) {
    document.querySelectorAll('.settings-nav-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.settings-tab-pane').forEach(el => el.classList.remove('active'));

    const navItem = document.getElementById('nav-' + tabId);
    if (navItem) navItem.classList.add('active');

    const pane = document.getElementById('pane-' + tabId);
    if (pane) pane.classList.add('active');

    const saveBtn = document.getElementById("btn-settings-save");
    const msg = document.getElementById("settings-message");
    if (saveBtn) {
      if (tabId === 'diagnostics') {
        saveBtn.disabled = true;
        saveBtn.style.opacity = "0.5";
        saveBtn.style.cursor = "not-allowed";
        if (msg) {
          msg.textContent = "Settings cannot be saved from the Diagnostics tab.";
          msg.style.display = "block";
          msg.style.color = "var(--text-3)";
        }
      } else {
        saveBtn.disabled = false;
        saveBtn.style.opacity = "1";
        saveBtn.style.cursor = "pointer";
        if (msg) {
          msg.style.display = "none";
        }
      }
    }
  };

  class AcbModalShell extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <div id="modal-overlay" onclick="closeModal(event)">
          <div id="modal" onclick="event.stopPropagation()">
            <div class="modal-header-row" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px;">
              <h3 style="margin-bottom:0;">✦ Create New Thread</h3>
              <button class="settings-close-btn" onclick="closeModal()" title="Close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>

            <div class="settings-field" style="margin-bottom:16px;">
              <label for="modal-topic">Thread Topic</label>
              <input id="modal-topic" type="text" placeholder="What is this task about?..." onkeydown="if(event.key==='Enter') submitModal()" />
              <div class="settings-field-description">A short, descriptive name. Helps agents and humans understand the primary goal.</div>
            </div>

            <div class="template-selector-wrap" style="margin-bottom: 24px;">
              <label class="template-selector-label" for="modal-template">Collaboration Template</label>
              <select id="modal-template">
                <option value="">No template (Standard chat)</option>
              </select>
              <div id="modal-template-desc" class="settings-field-description" style="margin-top:4px; min-height:1.4em;"></div>
              <div class="settings-field-description">Templates apply predefined system prompts and coordination rules for specific workflows.</div>
            </div>

            <div class="modal-actions">
              <button class="btn-secondary" onclick="closeModal()">Cancel</button>
              <button id="btn-create-thread" class="btn-primary" onclick="submitModal()" disabled>Create Thread</button>
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
                <div style="flex-grow: 1;"></div>
                <div id="nav-diagnostics" class="settings-nav-item" onclick="switchSettingsTab('diagnostics')">Diagnostics</div>
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
                <div id="pane-diagnostics" class="settings-tab-pane">
                  <div class="settings-section-title">SYSTEM HEALTH</div>
                  <div class="settings-card diag-card">
                    <div class="diag-subtitle" style="margin-bottom: 12px; font-size: 13px; color: var(--text-2);">
                      Run a self-test to verify Database, MCP Tools, and Agent connectivity.
                    </div>
                    <button class="btn-primary diag-run-btn" id="btn-run-diagnostics" onclick="window.runDiagnostics(this)" style="width: 100%; margin-bottom: 12px;">Run Diagnostics <span id="diag-btn-emoji"></span></button>
                    <div id="diagnostics-results" class="diag-terminal" style="display: none; background: #0c0c0c; color: #00ff00; font-family: monospace; padding: 12px; border-radius: 6px; font-size: 12px; white-space: pre-wrap; line-height: 1.5;"></div>
                    <button class="btn-secondary diag-copy-btn" id="btn-copy-diagnostics" onclick="window.copyDiagnosticsReport(this)" style="width: 100%; display: none; margin-top: 12px;">Copy Diagnostic Report</button>
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
          <div id="thread-settings-modal" class="settings-modal-container" style="width:500px; height:auto; max-height:85vh;" onclick="event.stopPropagation()">
            <div class="settings-modal-header">
              <h3>⚙️ Thread Settings</h3>
              <button class="settings-close-btn" onclick="closeThreadSettingsModal()" title="Close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>
            
            <div class="settings-content" style="background:var(--bg-base); padding: 24px; display:flex; flex-direction:column; gap:20px;">
              <div class="settings-field">
                <label for="ts-timeout-seconds">Inactivity Intervention Delay (seconds)</label>
                <input id="ts-timeout-seconds" type="number" min="30" value="60" />
                <div class="settings-field-description">
                  Wait duration after <strong>ALL</strong> participating online agents have entered <code>msg_wait</code> (indicating an idle conversation) before the system triggers a coordination intervention or requests human assistance. Minimum 30s.
                  <span id="ts-intervention-example" style="color:var(--accent); cursor:help; text-decoration:underline dotted; margin-left:4px;">Hover for example</span>
                </div>
              </div>

              <div class="settings-field">
                <label for="ts-switch-timeout-seconds">Switch Confirmation Delay (seconds)</label>
                <input id="ts-switch-timeout-seconds" type="number" min="30" value="60" />
                <div class="settings-field-description">
                  Wait duration before triggering an administrator switch confirmation if the current administrator is offline while other agents are waiting. Minimum 30s.
                  <span id="ts-switch-intervention-example" style="color:var(--accent); cursor:help; text-decoration:underline dotted; margin-left:4px;">Hover for example</span>
                </div>
              </div>
              
              <div class="settings-card" style="background:var(--bg-panel); border:1px solid var(--border); padding:16px; gap:8px;">
                <div style="font-size:13px; font-weight:600; color:var(--text-1);">Current Administrator</div>
                <div id="ts-current-admin" style="font-size:14px; color:var(--accent); font-weight:600; margin-top:4px;">Unassigned</div>
                <div class="settings-field-description" style="margin-top:4px;">
                  The agent responsible for coordination. Admins receive special prompts to guide the conversation flow.
                </div>
              </div>

              <div id="thread-settings-message" style="font-size:13px; color:var(--green); display:none;"></div>
            </div>
            
            <div class="settings-modal-footer">
              <button id="ts-btn-cancel" class="btn-secondary" style="margin-right:10px;" onclick="closeThreadSettingsModal()">Cancel</button>
              <button id="ts-btn-save" class="btn-primary" onclick="submitThreadSettings()">Save Settings</button>
            </div>
          </div>
        </div>`;

      // Attach minimap toggle listener after DOM is built
      this._attachMinimapToggle();
      // UI-14: enable Create button only when topic is non-empty
      this._attachTopicGuard();
      // Add intervention example tooltip
      this._attachInterventionTooltips();
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

    _attachInterventionTooltips() {
      const attach = (id, title, note, cardId, hydrateFn) => {
        const link = this.querySelector(id);
        if (!link) return;
        link.onmouseenter = () => {
          if (!window.AcbTooltip) return;
          const html = `
            <div style="padding: 12px; width: 540px; font-family: var(--font-inter);">
              <div style="font-size: 11px; color: var(--text-3); margin-bottom: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">${title}</div>
              <acb-admin-switch-card id="${cardId}" style="display: block; width: 100%;"></acb-admin-switch-card>
              <div style="font-size: 11px; color: var(--text-3); margin-top: 12px; font-style: italic;">
                ${note}
              </div>
            </div>
          `;
          window.AcbTooltip.showRich(link, html, { maxWidth: '580px' });
          setTimeout(() => hydrateFn(document.getElementById(cardId)), 10);
        };
        link.onmouseleave = () => {
          if (window.AcbTooltip) window.AcbTooltip.scheduleHide(150);
        };
      };

      attach(
        "#ts-intervention-example",
        "PREVIEW: Intervention Card",
        "Note: This card appears when the administrator is the ONLY agent online and waiting.",
        "ts-preview-card-takeover",
        (card) => {
          if (card && typeof card.setData === 'function') {
            card.setData({
              threadId: "preview-thread",
              metadata: {
                ui_type: "admin_takeover_confirmation_required",
                current_admin_emoji: "🦊",
                current_admin_name: "Firefox Agent",
                current_admin_id: "firefox_agent",
                timeout_seconds: 60,
                online_agents_count: 1,
                visibility: "human_only",
                mode: "single_agent"
              },
              message: {
                content: "Auto Administrator Timeout reached after 60 seconds. Only administrator 🦊 Firefox Agent is online and waiting. Do you want to ask the administrator to take over and continue work now?",
                seq: 999
              }
            });
          }
        }
      );

      attach(
        "#ts-switch-intervention-example",
        "PREVIEW: Switch Card",
        "Note: This card appears when the administrator is offline while other agents are waiting.",
        "ts-preview-card-switch",
        (card) => {
          if (card && typeof card.setData === 'function') {
            card.setData({
              threadId: "preview-thread",
              metadata: {
                ui_type: "admin_switch_confirmation_required",
                current_admin_emoji: "🦊",
                current_admin_name: "Firefox Agent",
                current_admin_id: "firefox_agent",
                candidate_admin_id: "chrome_agent",
                candidate_admin_name: "Chrome Agent",
                candidate_admin_emoji: "🔵",
                timeout_seconds: 60,
                online_agents_count: 2,
                visibility: "human_only",
                mode: "single_agent_fallback",
                ui_buttons: [
                  { action: "switch", label: "Switch admin to 🔵 Chrome Agent" },
                  { action: "keep", label: "Keep 🦊 Firefox Agent as admin" }
                ]
              },
              message: {
                content: "Auto Administrator Timeout reached after 60 seconds while all online participants were in msg_wait. Current admin: 🦊 Firefox Agent. Candidate admin: 🔵 Chrome Agent. Human confirmation is required before changing administrator.",
                seq: 999
              }
            });
          }
        }
      );
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
