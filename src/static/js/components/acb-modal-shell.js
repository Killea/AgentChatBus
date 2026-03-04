(function registerAcbModalShell() {
  const SETTINGS_FIELDS = [
    { label: "Host", id: "setting-host", type: "text" },
    { label: "Port", id: "setting-port", type: "number" },
    { label: "Agent Heartbeat Timeout (s)", id: "setting-heartbeat", type: "number" },
    { label: "Wait Timeout (s)", id: "setting-wait", type: "number" },
  ];

  const MINIMAP_KEY = "acb-minimap-enabled";

  function renderSettingsFields() {
    return SETTINGS_FIELDS.map((field) => {
      return `
        <label style="display:block;font-size:13px;color:var(--text-2);margin-bottom:6px;">${field.label}</label>
        <input id="${field.id}" type="${field.type}"
          style="width:100%;background:var(--bg-input);border:1px solid var(--border-light);color:var(--text-1);border-radius:10px;padding:10px 14px;font-size:14px;font-family:inherit;margin-bottom:16px;" />`;
    }).join("\n");
  }

  function renderUiPreferences() {
    return `
      <div style="border-top:1px solid var(--border-light);margin:4px 0 16px;padding-top:16px;">
        <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-2);margin-bottom:12px;">UI Preferences</div>
        <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-1);cursor:pointer;user-select:none;">
          <input id="setting-minimap" type="checkbox" style="width:15px;height:15px;cursor:pointer;accent-color:var(--accent);" />
          <span>Message minimap (navigation sidebar)</span>
        </label>
        <div style="font-size:11px;color:var(--text-2);margin-top:4px;padding-left:25px;">Scrollable anchor list on the right — toggle without restart.</div>
      </div>`;
  }

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
          <div id="settings-modal"
            style="background:var(--bg-card);border:1px solid var(--border-light);border-radius:14px;padding:28px;width:440px;max-width:90vw;box-shadow:var(--shadow);animation:modal-in .2s ease;"
            onclick="event.stopPropagation()">
            <h3 style="font-size:16px;font-weight:600;margin-bottom:18px;color:var(--text-1)">⚙️ MCP Server Settings</h3>
            ${renderSettingsFields()}
            ${renderUiPreferences()}
            <div id="settings-message" style="font-size:12px;color:var(--green);margin-bottom:16px;display:none;"></div>
            <div class="modal-actions">
              <button class="btn-secondary" onclick="closeSettingsModal()">Cancel</button>
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
