(function registerAcbModalShell() {
  const MINIMAP_KEY = "acb-minimap-enabled";

  function renderUiPreferences() {
    const identity = window.AcbUiAgent?.getUiIdentity?.() || { display_name: "Browser User", emoji: "" };
    return `
      <div class="settings-field-container" style="display:flex;flex-direction:column;gap:4px;margin-bottom:16px;">
        <div style="font-size:13px; font-weight:600; color:var(--text-1); margin-bottom:8px;">Browser User Identity</div>
        <div class="settings-field" style="margin-bottom:8px;">
          <label for="setting-ui-display-name">Display Name</label>
          <input id="setting-ui-display-name" type="text" value="${(identity.display_name || "").replace(/"/g, '&quot;')}" placeholder="Browser User" />
        </div>
        <div class="settings-field" style="margin-bottom:8px;">
          <label for="setting-ui-emoji">Avatar Emoji</label>
          <div style="display:flex; align-items:center; gap:8px;">
            <input id="setting-ui-emoji" type="text" value="${(identity.emoji || "").replace(/"/g, '&quot;')}" placeholder="🤖" style="width:80px; text-align:center; font-size:20px;" maxlength="8" />
            <span id="setting-ui-emoji-preview" style="font-size:28px; line-height:1;">${identity.emoji || "🤖"}</span>
          </div>
          <div class="settings-field-description">A single emoji used as your avatar in message rows, badges, and tooltips. Leave blank for the server default.</div>
        </div>
        <button class="btn-primary" id="btn-save-ui-identity" style="align-self:flex-start; margin-top:4px;" onclick="window._saveUiIdentity()">Save Identity</button>
        <div id="ui-identity-message" style="font-size:12px; display:none; margin-top:4px;"></div>
      </div>
      <hr style="border:none; border-top:1px solid var(--border); margin:8px 0 12px;" />
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

  function syncMinimapCheckbox() {
    const checkbox = document.getElementById("setting-minimap");
    if (!checkbox) return;
    const saved = localStorage.getItem(MINIMAP_KEY);
    checkbox.checked = saved === null ? true : saved === "true";
  }

  function bindMinimapCheckbox() {
    const checkbox = document.getElementById("setting-minimap");
    if (!checkbox || checkbox.dataset.bound === "true") return;
    checkbox.dataset.bound = "true";

    syncMinimapCheckbox();
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
        <div id="modal-overlay">
          <div id="modal" onclick="event.stopPropagation()">
            <div class="meeting-modal-thread-shell">
              <div class="modal-header-row meeting-modal-thread-shell__header">
                <h3 style="margin-bottom:0;">✦ Create New Thread</h3>
                <button class="settings-close-btn" onclick="closeModal()" title="Close">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
              </div>

              <div class="meeting-modal-thread-shell__intro settings-field-description">Create a thread and launch one or more agent sessions into it.</div>

              <div class="meeting-modal-thread-shell__body">
                <div id="thread-create-layout" class="meeting-modal-layout meeting-modal-layout--single">
                  <div class="meeting-modal-layout__main">
                    <div class="meeting-modal-section meeting-modal-section--compact">
                      <div class="meeting-modal-section__title">Startup</div>
                      <div class="meeting-modal-radio-group meeting-modal-radio-group--compact">
                        <label class="meeting-modal-radio">
                          <input type="radio" name="thread-launch-mode" value="thread_with_agent" checked onchange="window.AcbModals && window.AcbModals.syncThreadLaunchUi()" />
                          <div>
                            <strong>Create and start agents</strong>
                            <span>Create the thread and immediately launch one or more agent sessions.</span>
                          </div>
                        </label>
                        <label class="meeting-modal-radio">
                          <input type="radio" name="thread-launch-mode" value="thread_only" onchange="window.AcbModals && window.AcbModals.syncThreadLaunchUi()" />
                          <div>
                            <strong>Create thread only</strong>
                            <span>Deprecated. Not recommended. Open an empty meeting space first and add agents later.</span>
                          </div>
                        </label>
                      </div>
                    </div>

                    <div class="meeting-modal-section meeting-modal-section--compact">
                      <div class="meeting-modal-section__title">Thread</div>
                      <div class="meeting-modal-grid meeting-modal-grid--thread-meta">
                        <div class="settings-field">
                          <label for="modal-topic">Thread Name</label>
                          <input id="modal-topic" type="text" placeholder="Thread name" onkeydown="if(event.key==='Enter') submitModal()" />
                          <div class="settings-field-description">A short, descriptive name. A default name is generated automatically, and you can edit it any time.</div>
                        </div>
                        <div class="settings-field">
                          <label class="template-selector-label" for="modal-template">Collaboration Template</label>
                          <select id="modal-template">
                            <option value="">Stand chat</option>
                          </select>
                          <div id="modal-template-desc" class="settings-field-description" style="margin-top:4px; min-height:1.4em;"></div>
                        </div>
                      </div>
                    </div>

                    <div id="thread-agent-config" class="meeting-modal-section meeting-modal-section--compact">
                      <div class="meeting-modal-section__title">Agents To Start</div>
                      <div class="thread-launch-toolbar">
                        <div class="thread-launch-toolbar__meta">
                          <span class="thread-launch-toolbar__count-label">Count</span>
                          <span id="thread-launch-agent-count" class="thread-launch-toolbar__count-badge">1</span>
                        </div>
                        <div class="settings-field thread-launch-toolbar__interval">
                          <label for="thread-launch-interval-seconds">Interval</label>
                          <select id="thread-launch-interval-seconds" onchange="window.AcbModals && window.AcbModals.syncThreadLaunchUi()">
                            <option value="0">0s</option>
                            <option value="1">1s</option>
                            <option value="2" selected>2s</option>
                            <option value="3">3s</option>
                            <option value="5">5s</option>
                          </select>
                        </div>
                        <div class="thread-launch-toolbar__models">
                          <button
                            id="thread-launch-detect-models"
                            class="btn-secondary"
                            type="button"
                            onclick="window.AcbModals && window.AcbModals.detectThreadLaunchModels(window.AcbApi && window.AcbApi.api)"
                          >
                            Detect Models
                          </button>
                          <div id="thread-launch-model-status" class="thread-launch-model-status">Never detected</div>
                        </div>
                        <button id="thread-launch-add-agent" class="btn-secondary thread-launch-toolbar__add" type="button" onclick="window.AcbModals && window.AcbModals.addThreadLaunchAgent()">Add Agent</button>
                      </div>
                      <div id="thread-launch-model-summary" class="thread-launch-model-summary"></div>
                      <div id="thread-launch-agents-list" class="thread-launch-agents-list" data-agent-count="1"></div>
                      <div class="meeting-modal-hint">Agents launch sequentially. The first active agent becomes the administrator, and later agents join as participants.</div>
                      <div class="settings-field thread-launch-shared-instruction">
                        <label for="thread-launch-global-instruction">Shared Instruction</label>
                        <textarea
                          id="thread-launch-global-instruction"
                          placeholder="Shared instruction for all agents"
                          rows="5"
                        ></textarea>
                        <div class="settings-field-description">Applies to every agent by default. Leave an individual agent override blank to use this shared instruction.</div>
                      </div>
                      <div class="settings-field thread-launch-shared-instruction">
                        <label for="thread-launch-global-reentry-prompt">Shared Re-entry Prompt</label>
                        <textarea
                          id="thread-launch-global-reentry-prompt"
                          placeholder="Shared prompt used to wake or resume agents later"
                          rows="4"
                        ></textarea>
                        <div class="settings-field-description">Used when the system needs to wake an agent back into the thread. Edit this here before launch if you want a custom recovery prompt.</div>
                      </div>
                    </div>

                    <details id="thread-agent-side" class="meeting-modal-preview meeting-modal-preview--collapsible" open>
                      <summary id="thread-agent-prompt-summary" class="meeting-modal-preview__summary">Resolved Launch Prompt</summary>
                      <div id="thread-agent-prompt-meta" class="meeting-modal-preview__meta"></div>
                      <pre id="thread-agent-prompt-preview" class="meeting-modal-preview__body meeting-modal-preview__body--compact"></pre>
                    </details>
                    <details id="thread-agent-reentry-side" class="meeting-modal-preview meeting-modal-preview--collapsible" open>
                      <summary class="meeting-modal-preview__summary">Resolved Re-entry Prompt</summary>
                      <div id="thread-agent-reentry-meta" class="meeting-modal-preview__meta"></div>
                      <pre id="thread-agent-reentry-preview" class="meeting-modal-preview__body meeting-modal-preview__body--compact"></pre>
                    </details>
                  </div>
                </div>
              </div>

              <div class="meeting-modal-footer">
                <div id="thread-agent-actions" class="modal-actions">
                  <button class="btn-secondary" onclick="closeModal()">Cancel</button>
                  <button id="btn-create-thread" class="btn-primary" onclick="submitModal()" disabled>Create and Start First Agent</button>
                </div>

                <div id="thread-thread-only-actions" class="modal-actions meeting-modal-hidden">
                  <button class="btn-secondary" onclick="closeModal()">Cancel</button>
                  <button id="btn-create-thread-only" class="btn-primary" onclick="submitModal()" disabled>Create Thread</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div id="agent-modal-overlay" onclick="closeAddAgentModal(event)" class="meeting-modal-hidden" style="position:fixed;inset:0;background:rgba(0,0,0,.72);align-items:center;justify-content:center;z-index:100;animation:fade-in .15s ease;">
          <div id="agent-modal" class="settings-modal-container" style="width:560px; height:auto; max-height:85vh;" onclick="event.stopPropagation()">
            <div class="settings-modal-header">
              <h3>Add Agent</h3>
              <button class="settings-close-btn" onclick="closeAddAgentModal()" title="Close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>

            <div class="settings-content" style="background:var(--bg-base); padding: 24px; display:flex; flex-direction:column; gap:18px;">
              <div id="agent-modal-context" class="settings-field-description">Launch another agent session into the current thread.</div>

              <div class="meeting-modal-tabs" role="tablist" aria-label="Add agent mode">
                <button
                  id="agent-modal-tab-manual"
                  class="meeting-modal-tab is-active"
                  type="button"
                  role="tab"
                  aria-selected="true"
                  onclick="window.AcbModals && window.AcbModals.switchAddAgentTab('manual')"
                >
                  Manual
                </button>
                <button
                  id="agent-modal-tab-auto"
                  class="meeting-modal-tab"
                  type="button"
                  role="tab"
                  aria-selected="false"
                  onclick="window.AcbModals && window.AcbModals.switchAddAgentTab('auto')"
                >
                  Auto Assemble (Experimental)
                </button>
              </div>

              <div id="agent-modal-panel-manual" class="meeting-modal-tab-panel is-active">
                <div class="meeting-modal-section" style="margin-bottom:0;">
                  <div class="meeting-modal-section__title">Manual</div>
                  <div class="meeting-modal-grid">
                    <div class="settings-field">
                      <label for="agent-modal-adapter">Adapter</label>
                      <select id="agent-modal-adapter">
                        <option value="codex">Codex</option>
                        <option value="cursor">Cursor</option>
                        <option value="copilot">Copilot</option>
                        <option value="claude">Claude</option>
                        <option value="gemini">Gemini</option>
                      </select>
                    </div>
                    <div class="settings-field">
                      <label for="agent-modal-model">Model</label>
                      <div class="thread-launch-model-row">
                        <input id="agent-modal-model" type="text" placeholder="Leave blank for adapter default, or type any model" />
                        <select id="agent-modal-model-suggestion">
                          <option value="">Suggestions</option>
                        </select>
                      </div>
                    </div>
                    <div class="settings-field">
                      <label for="agent-modal-mode">Mode</label>
                      <select id="agent-modal-mode">
                        <option value="direct">Codex Direct (App Server)</option>
                        <option value="interactive">Interactive PTY</option>
                        <option value="headless">Headless JSON Resume</option>
                      </select>
                    </div>
                    <div class="settings-field" style="grid-column:1 / -1;">
                      <label for="agent-modal-display-name">Display Name</label>
                      <input id="agent-modal-display-name" type="text" placeholder="Optional: Research Agent" />
                      <div class="settings-field-description">Leave blank to use an automatically generated agent label.</div>
                    </div>
                    <div class="settings-field" style="grid-column:1 / -1;">
                      <label for="agent-modal-emoji">Emoji</label>
                      <div class="thread-launch-emoji-row">
                        <span id="agent-modal-emoji-preview" class="thread-launch-emoji-preview" aria-hidden="true">🤖</span>
                        <select id="agent-modal-emoji"></select>
                      </div>
                    </div>
                  </div>
                  <div class="settings-field" style="margin-bottom:0;">
                    <label for="agent-modal-instruction">Initial Instruction</label>
                    <textarea id="agent-modal-instruction" class="meeting-modal-textarea" placeholder="Optional: brief the agent on why it is joining this thread."></textarea>
                    <div id="agent-modal-hint" class="meeting-modal-hint">New agents join as participants unless they are the first active agent in the thread.</div>
                    <div class="meeting-modal-preview">
                      <div class="meeting-modal-preview__label">Resolved Launch Prompt</div>
                      <pre id="agent-modal-prompt-preview" class="meeting-modal-preview__body"></pre>
                    </div>
                  </div>
                </div>
              </div>

              <div id="agent-modal-panel-auto" class="meeting-modal-tab-panel meeting-modal-hidden">
                <div class="meeting-modal-section" style="margin-bottom:0;">
                  <div class="meeting-modal-section__title">Auto Assemble (Experimental)</div>
                  <div class="settings-field">
                    <label for="agent-auto-goal">Why do you need more agents?</label>
                    <textarea id="agent-auto-goal" class="meeting-modal-textarea" placeholder="Describe the gap, pressure, or reason for expanding the meeting."></textarea>
                  </div>
                  <div class="meeting-modal-grid">
                    <div class="settings-field">
                      <label for="agent-auto-max">Maximum agents</label>
                      <input id="agent-auto-max" type="number" min="1" max="6" value="2" />
                    </div>
                    <div class="settings-field">
                      <label for="agent-auto-adapters">Allowed adapters</label>
                      <select id="agent-auto-adapters">
                        <option value="any">Any supported adapter</option>
                        <option value="codex_only">Codex only</option>
                        <option value="cursor_only">Cursor only</option>
                      </select>
                    </div>
                  </div>
                  <div class="meeting-modal-placeholder">
                    <strong>Planning UI only in Phase 2A.</strong><br>
                    The proposal generator is intentionally deferred. This tab reserves the interaction model so we can wire suggestion and confirmation flows next.
                  </div>
                </div>
              </div>
            </div>

            <div class="settings-modal-footer">
              <button class="btn-secondary" onclick="closeAddAgentModal()">Cancel</button>
              <button id="btn-add-agent-submit" class="btn-primary" onclick="submitAddAgentModal()">Add Agent</button>
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
              <div class="settings-sidebar" id="settings-sidebar"></div>
              <div class="settings-content" id="settings-content"></div>
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
                <label for="ts-timeout-seconds">Admin Takeover Confirmation Delay (seconds)</label>
                <input id="ts-timeout-seconds" type="number" min="30" value="60" />
                <div class="settings-field-description">
                  Wait duration after <strong>ALL</strong> participating online agents have entered <code>msg_wait</code> (indicating an idle conversation) before the system triggers a coordination intervention or requests human assistance. Minimum 30s.
                  <span id="ts-intervention-example" style="color:var(--accent); cursor:help; text-decoration:underline dotted; margin-left:4px;">Click for example</span>
                </div>
              </div>

              <div class="settings-field">
                <label for="ts-switch-timeout-seconds">Admin Switch Confirmation Delay (seconds)</label>
                <input id="ts-switch-timeout-seconds" type="number" min="30" value="60" />
                <div class="settings-field-description">
                  Wait duration before triggering an administrator switch confirmation if the current administrator is offline while other agents are waiting. Minimum 30s.
                  <span id="ts-switch-intervention-example" style="color:var(--accent); cursor:help; text-decoration:underline dotted; margin-left:4px;">Click for example</span>
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

      // UI-14: enable Create button only when topic is non-empty
      this._attachTopicGuard();
      this._syncThreadLaunchButtonLabel();
      // Add intervention example tooltip
      this._attachInterventionTooltips();
    }

    _attachTopicGuard() {
      const input = this.querySelector("#modal-topic");
      const btn = this.querySelector("#btn-create-thread");
      const threadOnlyBtn = this.querySelector("#btn-create-thread-only");
      if (!input || (!btn && !threadOnlyBtn)) return;
      const sync = () => {
        const disabled = input.value.trim().length === 0;
        if (btn) btn.disabled = disabled;
        if (threadOnlyBtn) threadOnlyBtn.disabled = disabled;
        this._syncThreadLaunchButtonLabel();
      };
      input.addEventListener("input", sync);
      this.querySelectorAll('input[name="thread-launch-mode"]').forEach((radio) => {
        radio.addEventListener("change", sync);
      });
      // Re-sync when modal is opened (topic may have been cleared)
      const overlay = this.querySelector("#modal-overlay");
      if (overlay) {
        const observer = new MutationObserver(() => sync());
        observer.observe(overlay, { attributes: true, attributeFilter: ["class", "style"] });
      }
    }

    _syncThreadLaunchButtonLabel() {
      const btn = this.querySelector("#btn-create-thread");
      const threadOnlyBtn = this.querySelector("#btn-create-thread-only");
      const mode = this.querySelector('input[name="thread-launch-mode"]:checked')?.value || "thread_with_agent";
      const agentCount = Math.max(
        1,
        Number(this.querySelector("#thread-launch-agents-list")?.dataset.agentCount || "1")
      );
      if (btn) {
        btn.textContent = mode === "thread_with_agent"
          ? (agentCount > 1 ? "Create and Start Agents" : "Create and Start First Agent")
          : "Create Thread";
      }
      if (threadOnlyBtn) {
        threadOnlyBtn.textContent = "Create Thread";
      }
    }

    _attachMinimapToggle() {
      bindMinimapCheckbox();
    }

    _attachInterventionTooltips() {
      const attach = (id, title, note, cardId, hydrateFn) => {
        const link = this.querySelector(id);
        if (!link) return;
        link.onclick = (e) => {
          e.preventDefault();
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
          window.AcbTooltip.showRich(link, html, { maxWidth: '580px', interactive: true });
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

  function bindIdentityInputs() {
    const emojiInput = document.getElementById("setting-ui-emoji");
    const preview = document.getElementById("setting-ui-emoji-preview");
    if (emojiInput && preview && emojiInput.dataset.bound !== "true") {
      emojiInput.dataset.bound = "true";
      emojiInput.addEventListener("input", () => {
        preview.textContent = emojiInput.value.trim() || "🤖";
      });
    }
  }

  window._saveUiIdentity = async function () {
    const nameInput = document.getElementById("setting-ui-display-name");
    const emojiInput = document.getElementById("setting-ui-emoji");
    const msg = document.getElementById("ui-identity-message");
    if (!nameInput || !emojiInput || !msg) return;

    const displayName = nameInput.value.trim();
    const emoji = emojiInput.value.trim();

    if (!window.AcbUiAgent?.updateUiAgentIdentity) {
      msg.textContent = "UI agent module not loaded.";
      msg.style.color = "var(--red, #f05555)";
      msg.style.display = "block";
      return;
    }

    const result = await window.AcbUiAgent.updateUiAgentIdentity(displayName, emoji);
    if (result.ok) {
      msg.textContent = "Identity saved and synced!";
      msg.style.color = "var(--green)";
    } else {
      msg.textContent = result.reason === "no_session"
        ? "Saved locally. Will apply on next page load."
        : `Saved locally, but sync failed (${result.reason}).`;
      msg.style.color = result.reason === "no_session" ? "var(--green)" : "var(--text-3)";
    }
    msg.style.display = "block";
    setTimeout(() => { msg.style.display = "none"; }, 3000);
  };

  window.AcbModalShell = {
    renderUiPreferencesHtml: renderUiPreferences,
    bindMinimapCheckbox,
    bindIdentityInputs,
    syncMinimapCheckbox,
  };

  if (!customElements.get("acb-modal-shell")) {
    customElements.define("acb-modal-shell", AcbModalShell);
  }
})();
