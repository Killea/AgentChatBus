(function () {
  const sessionsByThread = new Map();
  const activeSessionIdByThread = new Map();
  const terminalVisibilityByThread = new Map();
  const ACTIVE_SESSION_STATES = new Set(["created", "starting", "running"]);
  const terminalState = {
    sessionId: null,
    terminal: null,
    fitAddon: null,
    outputCursor: 0,
    resizeObserver: null,
    resizeTimer: null,
    lastResizeCols: null,
    lastResizeRows: null,
    inputQueue: Promise.resolve(),
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function getActiveThreadId() {
    return window.currentThreadId || null;
  }

  function getPanelEl() {
    return document.getElementById("cli-session-strip");
  }

  function getParticipantsEl() {
    return document.getElementById("cli-session-participants");
  }

  function getSessionCountEl() {
    return document.getElementById("cli-session-count");
  }

  function getDetailEl() {
    return document.getElementById("cli-session-detail");
  }

  function getTerminalEl() {
    return document.getElementById("cli-session-terminal");
  }

  function getComposerEl() {
    return document.getElementById("cli-session-compose");
  }

  function getDetailBadgeEl() {
    return document.getElementById("cli-session-selected-badge");
  }

  function getDetailTitleEl() {
    return document.getElementById("cli-session-selected-title");
  }

  function getDetailRoleEl() {
    return document.getElementById("cli-session-selected-role");
  }

  function getDetailMetaEl() {
    return document.getElementById("cli-session-selected-meta");
  }

  function getDetailSummaryEl() {
    return document.getElementById("cli-session-selected-summary");
  }

  function getOrCreateSessionMap(threadId) {
    let sessionMap = sessionsByThread.get(threadId);
    if (!sessionMap) {
      sessionMap = new Map();
      sessionsByThread.set(threadId, sessionMap);
    }
    return sessionMap;
  }

  function clearThreadSessions(threadId) {
    sessionsByThread.delete(threadId);
    activeSessionIdByThread.delete(threadId);
  }

  function sessionDisplayName(session) {
    return String(session?.participant_display_name || "").trim() || sessionLabel(session);
  }

  function sessionLabel(session) {
    const participantLabel = String(session?.participant_display_name || "").trim();
    if (session?.adapter === "codex" && session?.mode === "interactive") {
      return participantLabel ? `${participantLabel} · Codex PTY` : "Codex PTY";
    }
    if (session?.adapter === "cursor" && session?.mode === "headless") {
      return participantLabel ? `${participantLabel} · Cursor headless` : "Cursor headless";
    }
    const base = `${String(session?.adapter || "cli")} ${String(session?.mode || "session")}`;
    return participantLabel ? `${participantLabel} · ${base}` : base;
  }

  function sessionAvatar(session) {
    const candidate = sessionDisplayName(session).replace(/[^A-Za-z0-9]/g, "");
    return String(candidate.charAt(0) || String(session?.adapter || "A").charAt(0) || "A").toUpperCase();
  }

  function stateTone(state) {
    switch (String(state || "").toLowerCase()) {
      case "completed":
        return "success";
      case "failed":
        return "error";
      case "stopped":
        return "warn";
      default:
        return "running";
    }
  }

  function stateLabel(state) {
    const raw = String(state || "unknown");
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  function roleLabel(session) {
    return session?.participant_role === "administrator" ? "Admin" : "Participant";
  }

  function roleTone(session) {
    return session?.participant_role === "administrator" ? "admin" : "participant";
  }

  function isInteractiveSession(session) {
    return Boolean(session?.supports_input);
  }

  function isActiveSession(session) {
    return ACTIVE_SESSION_STATES.has(String(session?.state || ""));
  }

  function compareSessionsForDisplay(left, right) {
    const leftAdmin = left?.participant_role === "administrator" ? 0 : 1;
    const rightAdmin = right?.participant_role === "administrator" ? 0 : 1;
    if (leftAdmin !== rightAdmin) {
      return leftAdmin - rightAdmin;
    }

    const createdCompare = String(left?.created_at || "").localeCompare(String(right?.created_at || ""));
    if (createdCompare !== 0) {
      return createdCompare;
    }

    const nameCompare = sessionDisplayName(left).localeCompare(sessionDisplayName(right));
    if (nameCompare !== 0) {
      return nameCompare;
    }

    return String(left?.id || "").localeCompare(String(right?.id || ""));
  }

  function compareSessionsForPreference(left, right) {
    const leftActive = isActiveSession(left) ? 0 : 1;
    const rightActive = isActiveSession(right) ? 0 : 1;
    if (leftActive !== rightActive) {
      return leftActive - rightActive;
    }

    const leftInteractive = isInteractiveSession(left) ? 0 : 1;
    const rightInteractive = isInteractiveSession(right) ? 0 : 1;
    if (leftInteractive !== rightInteractive) {
      return leftInteractive - rightInteractive;
    }

    const updatedCompare = String(right?.updated_at || "").localeCompare(String(left?.updated_at || ""));
    if (updatedCompare !== 0) {
      return updatedCompare;
    }

    const createdCompare = String(right?.created_at || "").localeCompare(String(left?.created_at || ""));
    if (createdCompare !== 0) {
      return createdCompare;
    }

    return String(right?.id || "").localeCompare(String(left?.id || ""));
  }

  function getSessionsForThread(threadId) {
    return Array.from((sessionsByThread.get(threadId) || new Map()).values())
      .sort(compareSessionsForDisplay);
  }

  function getParticipantSessionsForThread(threadId) {
    return getSessionsForThread(threadId)
      .filter((session) => Boolean(session?.participant_agent_id));
  }

  function getDeliverySummaryForSeq(seq, threadId = getActiveThreadId()) {
    const normalizedSeq = Number(seq);
    if (!threadId || !Number.isFinite(normalizedSeq) || normalizedSeq <= 0) {
      return null;
    }

    const sessions = getParticipantSessionsForThread(threadId)
      .filter((session) => isActiveSession(session));
    if (!sessions.length) {
      return null;
    }

    const delivered = [];
    const waiting = [];
    for (const session of sessions) {
      const label = sessionDisplayName(session);
      if ((Number(session?.last_delivered_seq) || 0) >= normalizedSeq) {
        delivered.push(label);
      } else {
        waiting.push(label);
      }
    }

    return {
      participantCount: sessions.length,
      delivered,
      waiting,
    };
  }

  function choosePreferredSession(sessions) {
    return [...sessions].sort(compareSessionsForPreference)[0] || null;
  }

  function ensureSelectedSession(threadId) {
    const sessions = getSessionsForThread(threadId);
    if (!sessions.length) {
      activeSessionIdByThread.delete(threadId);
      return null;
    }

    const activeSessionId = activeSessionIdByThread.get(threadId);
    if (activeSessionId) {
      const existing = sessions.find((session) => session.id === activeSessionId);
      if (existing) {
        return existing;
      }
    }

    const preferred = choosePreferredSession(sessions);
    if (preferred?.id) {
      activeSessionIdByThread.set(threadId, preferred.id);
    }
    return preferred;
  }

  function getSelectedSession(threadId = getActiveThreadId()) {
    if (!threadId) {
      return null;
    }
    return ensureSelectedSession(threadId);
  }

  function isTerminalVisible(threadId = getActiveThreadId()) {
    if (!threadId) {
      return true;
    }
    return terminalVisibilityByThread.get(threadId) !== false;
  }

  function setTerminalVisibility(threadId, visible) {
    if (!threadId) {
      return;
    }
    terminalVisibilityByThread.set(threadId, visible !== false);
  }

  function toggleTerminalVisibility(threadId = getActiveThreadId()) {
    if (!threadId) {
      return;
    }
    setTerminalVisibility(threadId, !isTerminalVisible(threadId));
    renderThread(threadId);
  }

  function replaceSessionsForThread(threadId, sessions) {
    if (!threadId) {
      return;
    }
    if (!Array.isArray(sessions) || sessions.length === 0) {
      clearThreadSessions(threadId);
      return;
    }

    const nextMap = new Map();
    sessions.forEach((session) => {
      if (session?.id) {
        nextMap.set(session.id, session);
      }
    });

    sessionsByThread.set(threadId, nextMap);
    ensureSelectedSession(threadId);
  }

  function upsertSession(session) {
    if (!session?.thread_id || !session?.id) {
      return;
    }
    const sessionMap = getOrCreateSessionMap(session.thread_id);
    sessionMap.set(session.id, session);
    ensureSelectedSession(session.thread_id);
    if (session.thread_id === getActiveThreadId()) {
      renderThread(session.thread_id);
    }
  }

  function selectSession(sessionId, threadId = getActiveThreadId()) {
    if (!threadId || !sessionId) {
      return null;
    }
    const sessionMap = sessionsByThread.get(threadId);
    if (!sessionMap || !sessionMap.has(sessionId)) {
      return null;
    }
    activeSessionIdByThread.set(threadId, sessionId);
    renderThread(threadId);
    return sessionMap.get(sessionId) || null;
  }

  function selectSessionFromElement(element) {
    const sessionId = element?.getAttribute("data-session-id");
    return selectSession(sessionId);
  }

  function teardownTerminal() {
    if (terminalState.resizeObserver) {
      terminalState.resizeObserver.disconnect();
    }
    if (terminalState.resizeTimer) {
      window.clearTimeout(terminalState.resizeTimer);
    }
    if (terminalState.terminal) {
      terminalState.terminal.dispose();
    }
    terminalState.sessionId = null;
    terminalState.terminal = null;
    terminalState.fitAddon = null;
    terminalState.outputCursor = 0;
    terminalState.resizeObserver = null;
    terminalState.resizeTimer = null;
    terminalState.lastResizeCols = null;
    terminalState.lastResizeRows = null;
    terminalState.inputQueue = Promise.resolve();
  }

  function writeTerminalNotice(message) {
    if (!terminalState.terminal) {
      return;
    }
    terminalState.terminal.write(`\r\n[agentchatbus] ${message}\r\n`);
  }

  async function getUiAgent() {
    return window.AcbUiAgent ? await window.AcbUiAgent.ensureUiAgent() : null;
  }

  async function sendRawInput(sessionId, text) {
    const uiAgent = await getUiAgent();
    if (!uiAgent) {
      throw new Error("UI agent is not available.");
    }

    const result = await window.AcbApi.api(`/api/cli-sessions/${sessionId}/input`, {
      method: "POST",
      headers: {
        "X-Agent-Token": uiAgent.token,
      },
      body: JSON.stringify({
        requested_by_agent_id: uiAgent.agent_id,
        text,
      }),
    });

    if (result?.ok === false) {
      throw new Error(result.error || "Input was rejected.");
    }
  }

  function queueRawInput(sessionId, text) {
    if (!text || !sessionId) {
      return Promise.resolve();
    }

    terminalState.inputQueue = terminalState.inputQueue
      .then(() => sendRawInput(sessionId, text))
      .catch((error) => {
        writeTerminalNotice(error instanceof Error ? error.message : String(error));
      });

    return terminalState.inputQueue;
  }

  async function syncTerminalSize(sessionId) {
    if (!terminalState.fitAddon || !terminalState.sessionId || terminalState.sessionId !== sessionId) {
      return;
    }

    const dims = terminalState.fitAddon.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) {
      return;
    }

    const nextCols = Math.max(1, Math.floor(dims.cols));
    const nextRows = Math.max(1, Math.floor(dims.rows));
    if (terminalState.lastResizeCols === nextCols && terminalState.lastResizeRows === nextRows) {
      return;
    }

    terminalState.fitAddon.fit();
    terminalState.lastResizeCols = nextCols;
    terminalState.lastResizeRows = nextRows;

    const uiAgent = await getUiAgent();
    if (!uiAgent) {
      return;
    }

    const result = await window.AcbApi.api(`/api/cli-sessions/${sessionId}/resize`, {
      method: "POST",
      headers: {
        "X-Agent-Token": uiAgent.token,
      },
      body: JSON.stringify({
        requested_by_agent_id: uiAgent.agent_id,
        cols: nextCols,
        rows: nextRows,
      }),
    });

    if (result?.ok === false) {
      throw new Error(result.error || "Resize was rejected.");
    }
  }

  function scheduleTerminalResize(sessionId) {
    if (terminalState.resizeTimer) {
      window.clearTimeout(terminalState.resizeTimer);
    }
    terminalState.resizeTimer = window.setTimeout(() => {
      syncTerminalSize(sessionId).catch((error) => {
        writeTerminalNotice(error instanceof Error ? error.message : String(error));
      });
    }, 80);
  }

  function appendTerminalOutput(entry) {
    if (!terminalState.terminal || !entry || typeof entry.seq !== "number") {
      return;
    }
    if (entry.seq <= terminalState.outputCursor) {
      return;
    }
    terminalState.terminal.write(String(entry.text || ""));
    terminalState.outputCursor = entry.seq;
  }

  async function mountTerminalForSession(session) {
    if (!isInteractiveSession(session)) {
      teardownTerminal();
      return;
    }

    const terminalEl = getTerminalEl();
    if (!terminalEl) {
      return;
    }

    if (terminalState.sessionId === session.id && terminalState.terminal) {
      return;
    }

    teardownTerminal();

    if (!window.Terminal || !window.FitAddon || !window.FitAddon.FitAddon) {
      terminalEl.innerHTML = '<div class="cli-session-terminal__fallback">xterm.js did not load.</div>';
      return;
    }

    const terminal = new window.Terminal({
      allowTransparency: true,
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      scrollback: 5000,
      theme: {
        background: "#08111f",
        foreground: "#dbeafe",
        cursor: "#7dd3fc",
        selectionBackground: "rgba(59, 130, 246, 0.28)",
      },
    });
    const fitAddon = new window.FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalEl);

    terminal.onData((data) => {
      void queueRawInput(session.id, data);
    });

    terminalState.sessionId = session.id;
    terminalState.terminal = terminal;
    terminalState.fitAddon = fitAddon;
    terminalState.outputCursor = 0;
    terminalState.lastResizeCols = null;
    terminalState.lastResizeRows = null;

    if (typeof ResizeObserver === "function") {
      terminalState.resizeObserver = new ResizeObserver(() => {
        scheduleTerminalResize(session.id);
      });
      terminalState.resizeObserver.observe(terminalEl);
    }

    scheduleTerminalResize(session.id);

    try {
      const result = await window.AcbApi.api(`/api/cli-sessions/${session.id}/output?after=0&limit=1000`);
      if (terminalState.sessionId !== session.id) {
        return;
      }
      const entries = Array.isArray(result?.entries) ? result.entries : [];
      entries.forEach((entry) => appendTerminalOutput(entry));
      terminal.focus();
    } catch (error) {
      writeTerminalNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function renderSessionSummary(session) {
    if ((session?.meeting_post_state === "error" || session?.meeting_post_state === "stale") && session?.meeting_post_error) {
      return `<div class="cli-session-strip__body cli-session-strip__body--error">Relay error: ${escapeHtml(session.meeting_post_error)}</div>`;
    }
    if (session?.reply_capture_excerpt) {
      const state = session?.reply_capture_state ? ` (${escapeHtml(session.reply_capture_state)})` : "";
      return `<div class="cli-session-strip__body"><strong>Latest reply${state}:</strong><br>${escapeHtml(session.reply_capture_excerpt).replaceAll("\n", "<br>")}</div>`;
    }
    if (session?.reply_capture_error) {
      return `<div class="cli-session-strip__body cli-session-strip__body--error">Reply capture error: ${escapeHtml(session.reply_capture_error)}</div>`;
    }
    if (session?.last_result) {
      return `<div class="cli-session-strip__body"><strong>Session result:</strong><br>${escapeHtml(session.last_result)}</div>`;
    }
    if (session?.last_error) {
      return `<div class="cli-session-strip__body cli-session-strip__body--error">${escapeHtml(session.last_error)}</div>`;
    }
    return '<div class="cli-session-strip__body cli-session-strip__body--empty">No captured reply yet.</div>';
  }

  function renderInteractiveBody(session) {
    const label = escapeHtml(sessionDisplayName(session));
    return `
      <div class="cli-session-terminal__note">Click the terminal to focus it. Keystrokes are sent to the PTY in real time.</div>
      <div class="cli-session-terminal__shell">
        <div id="cli-session-terminal" class="cli-session-terminal"></div>
      </div>
      <div class="cli-session-compose__row">
        <textarea id="cli-session-compose" class="cli-session-compose" rows="2" placeholder="Optional: send a full prompt line to ${label}" onkeydown="return window.AcbCliSessions && window.AcbCliSessions.handleComposerKeydown(event)"></textarea>
        <button class="toolbar-btn cli-session-compose__send" type="button" onclick="window.AcbCliSessions && window.AcbCliSessions.sendComposerInput()">Send</button>
      </div>
      <div id="cli-session-selected-summary">${renderSessionSummary(session)}</div>
    `;
  }

  function renderPassiveBody(session) {
    return `<div id="cli-session-selected-summary">${renderSessionSummary(session)}</div>`;
  }

  function buildMetaBits(session) {
    const metaBits = [
      `${escapeHtml(session.adapter)} / ${escapeHtml(session.mode)}`,
      `run #${escapeHtml(session.run_count)}`,
    ];
    if (session.participant_display_name) {
      metaBits.push(`participant ${escapeHtml(session.participant_display_name)}`);
    }
    if (session.participant_role) {
      metaBits.push(`role ${escapeHtml(session.participant_role)}`);
    }
    if (session.shell) {
      metaBits.push(`shell ${escapeHtml(session.shell)}`);
    }
    if (session.automation_state) {
      metaBits.push(`auto ${escapeHtml(session.automation_state)}`);
    }
    if (session.reply_capture_state) {
      metaBits.push(`reply ${escapeHtml(session.reply_capture_state)}`);
    }
    if (session.meeting_post_state) {
      metaBits.push(`relay ${escapeHtml(session.meeting_post_state)}`);
    }
    if (session.external_session_id) {
      metaBits.push(`external ${escapeHtml(session.external_session_id)}`);
    }
    if (session.cols && session.rows) {
      metaBits.push(`${escapeHtml(session.cols)}x${escapeHtml(session.rows)}`);
    }
    return metaBits;
  }

  function ensurePanelShell(panelEl) {
    if (!panelEl || panelEl.dataset.cliSessionShell === "1") {
      return;
    }

    panelEl.innerHTML = `
      <div class="cli-session-strip__header">
        <div class="cli-session-strip__title">
          <span>Participants & Sessions</span>
          <span id="cli-session-count" class="cli-session-strip__count">0 participants</span>
        </div>
        <div class="cli-session-strip__actions">
          <button class="thread-header-cta" type="button" onclick="window.openAddAgentModal && window.openAddAgentModal()">Add Agent</button>
          <button id="cli-session-terminal-toggle" class="thread-header-cta" type="button" onclick="window.AcbCliSessions && window.AcbCliSessions.toggleTerminalVisibility()">Hide Terminal</button>
        </div>
      </div>
      <div id="cli-session-participants" class="cli-session-participants"></div>
      <div id="cli-session-detail" class="cli-session-detail"></div>
    `;
    panelEl.dataset.cliSessionShell = "1";
  }

  function renderHeaderSummary(sessions) {
    const countEl = getSessionCountEl();
    if (!countEl) {
      return;
    }
    const count = Array.isArray(sessions) ? sessions.length : 0;
    countEl.textContent = `${count} participant${count === 1 ? "" : "s"}`;
  }

  function renderTerminalToggle(threadId = getActiveThreadId()) {
    const toggleEl = document.getElementById("cli-session-terminal-toggle");
    if (!toggleEl) {
      return;
    }
    const visible = isTerminalVisible(threadId);
    toggleEl.textContent = visible ? "Hide Agent Panel" : "Show Agent Panel";
    toggleEl.setAttribute(
      "title",
      visible ? "Hide the selected agent detail panel" : "Show the selected agent detail panel",
    );
  }

  function renderParticipantsList(sessions, selectedSessionId) {
    const participantsEl = getParticipantsEl();
    if (!participantsEl) {
      return;
    }

    participantsEl.innerHTML = sessions.map((session) => {
      const selected = session.id === selectedSessionId;
      const role = roleLabel(session);
      const meta = [
        String(session.adapter || "CLI"),
        String(session.mode || "session"),
        stateLabel(session.state),
      ].join(" · ");
      return `
        <button
          type="button"
          class="cli-session-participant${selected ? " is-selected" : ""}"
          data-session-id="${escapeHtml(session.id)}"
          onclick="window.AcbCliSessions && window.AcbCliSessions.selectSessionFromElement(this)"
        >
          <span class="cli-session-participant__avatar">${escapeHtml(sessionAvatar(session))}</span>
          <span class="cli-session-participant__body">
            <span class="cli-session-participant__row">
              <span class="cli-session-participant__name">${escapeHtml(sessionDisplayName(session))}</span>
              <span class="cli-session-role-badge cli-session-role-badge--${roleTone(session)}">${escapeHtml(role)}</span>
            </span>
            <span class="cli-session-participant__meta">${escapeHtml(meta)}</span>
          </span>
        </button>
      `;
    }).join("");
  }

  function updateDetailChrome(session) {
    const badgeEl = getDetailBadgeEl();
    if (badgeEl) {
      badgeEl.className = `cli-session-strip__badge cli-session-strip__badge--${stateTone(session.state)}`;
      badgeEl.textContent = stateLabel(session.state);
    }

    const titleEl = getDetailTitleEl();
    if (titleEl) {
      titleEl.textContent = sessionDisplayName(session);
    }

    const roleEl = getDetailRoleEl();
    if (roleEl) {
      if (session?.participant_role) {
        roleEl.hidden = false;
        roleEl.className = `cli-session-role-badge cli-session-role-badge--${roleTone(session)}`;
        roleEl.textContent = roleLabel(session);
      } else {
        roleEl.hidden = true;
        roleEl.textContent = "";
      }
    }

    const metaEl = getDetailMetaEl();
    if (metaEl) {
      metaEl.innerHTML = buildMetaBits(session)
        .map((bit) => `<span>${bit}</span>`)
        .join("");
    }

    const summaryEl = getDetailSummaryEl();
    if (summaryEl) {
      summaryEl.innerHTML = renderSessionSummary(session);
    }
  }

  function canReuseInteractiveSelection(panelEl, session) {
    return Boolean(
      panelEl
      && session
      && isInteractiveSession(session)
      && terminalState.sessionId === session.id
      && terminalState.terminal
      && panelEl.dataset.selectedSessionId === String(session.id || "")
      && panelEl.dataset.selectedInteractive === "1"
      && getTerminalEl()
    );
  }

  function renderSessionDetail(panelEl, session, options = {}) {
    const detailEl = getDetailEl();
    if (!detailEl || !session) {
      return;
    }

    panelEl.dataset.selectedSessionId = String(session.id || "");
    panelEl.dataset.selectedInteractive = isInteractiveSession(session) ? "1" : "0";
    const terminalVisible = isTerminalVisible(session.thread_id);

    if (!terminalVisible) {
      detailEl.hidden = true;
      teardownTerminal();
      return;
    }

    detailEl.hidden = false;

    if (!options.reuseInteractive) {
      detailEl.innerHTML = `
        <div class="cli-session-detail__card">
          <div class="cli-session-detail__header">
            <div class="cli-session-detail__title-stack">
              <div class="cli-session-detail__title-row">
                <span id="cli-session-selected-badge" class="cli-session-strip__badge cli-session-strip__badge--${stateTone(session.state)}">${escapeHtml(stateLabel(session.state))}</span>
                <span id="cli-session-selected-title" class="cli-session-detail__title">${escapeHtml(sessionDisplayName(session))}</span>
                <span id="cli-session-selected-role" class="cli-session-role-badge cli-session-role-badge--${roleTone(session)}"${session?.participant_role ? "" : " hidden"}>${escapeHtml(roleLabel(session))}</span>
              </div>
              <div id="cli-session-selected-meta" class="cli-session-strip__meta"></div>
            </div>
            <div class="cli-session-strip__actions">
              <button class="toolbar-btn" type="button" title="Restart selected CLI session" aria-label="Restart selected CLI session" onclick="window.AcbCliSessions && window.AcbCliSessions.restartSelected()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="23 4 23 10 17 10"></polyline>
                  <polyline points="1 20 1 14 7 14"></polyline>
                  <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10"></path>
                  <path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14"></path>
                </svg>
              </button>
              <button class="toolbar-btn" type="button" title="Stop selected CLI session" aria-label="Stop selected CLI session" onclick="window.AcbCliSessions && window.AcbCliSessions.stopSelected()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2"></rect>
                </svg>
              </button>
            </div>
          </div>
          <div class="cli-session-detail__view">
            ${isInteractiveSession(session)
              ? renderInteractiveBody(session)
              : renderPassiveBody(session)}
          </div>
        </div>
      `;
    }

    updateDetailChrome(session);

    if (isInteractiveSession(session)) {
      void mountTerminalForSession(session);
      return;
    }

    teardownTerminal();
  }

  function renderEmptyState(panelEl) {
    ensurePanelShell(panelEl);
    panelEl.hidden = false;
    panelEl.dataset.selectedSessionId = "";
    panelEl.dataset.selectedInteractive = "0";
    renderHeaderSummary([]);

    const participantsEl = getParticipantsEl();
    if (participantsEl) {
      participantsEl.innerHTML = "";
    }

    const detailEl = getDetailEl();
    if (detailEl) {
      detailEl.hidden = false;
      detailEl.innerHTML = `
        <div class="cli-session-detail__empty">
          <strong>No agents have joined this thread yet.</strong><br>
          Start the first participant when you are ready to turn this thread into an active meeting.
          <div class="cli-session-detail__empty-actions">
            <button class="thread-header-cta" type="button" onclick="window.openAddAgentModal && window.openAddAgentModal()">Add First Agent</button>
          </div>
        </div>
      `;
    }

    teardownTerminal();
    if (window.AcbChat?.refreshHumanDeliveryIndicators) {
      window.AcbChat.refreshHumanDeliveryIndicators(getActiveThreadId());
    }
  }

  function renderThread(threadId = getActiveThreadId()) {
    const panelEl = getPanelEl();
    if (!panelEl) {
      return;
    }

    if (!threadId) {
      teardownTerminal();
      panelEl.hidden = true;
      panelEl.innerHTML = "";
      panelEl.dataset.cliSessionShell = "";
      panelEl.dataset.selectedSessionId = "";
      panelEl.dataset.selectedInteractive = "0";
      return;
    }

    ensurePanelShell(panelEl);
    panelEl.hidden = false;
    renderTerminalToggle(threadId);

    const sessions = getSessionsForThread(threadId);
    if (!sessions.length) {
      renderEmptyState(panelEl);
      return;
    }

    const selectedSession = ensureSelectedSession(threadId);
    if (!selectedSession) {
      renderEmptyState(panelEl);
      return;
    }

    renderHeaderSummary(sessions);
    renderParticipantsList(sessions, selectedSession.id);

    const reuseInteractive = canReuseInteractiveSelection(panelEl, selectedSession);
    renderSessionDetail(panelEl, selectedSession, { reuseInteractive });
    if (window.AcbChat?.refreshHumanDeliveryIndicators) {
      window.AcbChat.refreshHumanDeliveryIndicators(threadId);
    }
  }

  async function refreshThread(threadId, api) {
    if (!threadId) {
      renderThread(null);
      return null;
    }

    const result = await api(`/api/threads/${threadId}/cli-sessions`);
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    replaceSessionsForThread(threadId, sessions);
    renderThread(threadId);

    if (window.AcbChat && typeof window.AcbChat.refreshThreadAdmin === "function") {
      await window.AcbChat.refreshThreadAdmin(threadId, api);
    }

    return getSelectedSession(threadId);
  }

  async function startCodexInteractive(api) {
    const threadId = getActiveThreadId();
    if (!threadId) {
      return null;
    }

    const uiAgent = await getUiAgent();
    if (!uiAgent) {
      return null;
    }

    const result = await api(`/api/threads/${threadId}/cli-sessions`, {
      method: "POST",
      headers: {
        "X-Agent-Token": uiAgent.token,
      },
      body: JSON.stringify({
        adapter: "codex",
        mode: "interactive",
        prompt: "who are you",
        requested_by_agent_id: uiAgent.agent_id,
        cols: 120,
        rows: 32,
      }),
    });

    if (result?.session) {
      upsertSession(result.session);
      selectSession(result.session.id, threadId);
      return result.session;
    }

    return null;
  }

  async function restartSelected(api) {
    const threadId = getActiveThreadId();
    const session = getSelectedSession(threadId);
    if (!threadId || !session) {
      return null;
    }

    const uiAgent = await getUiAgent();
    if (!uiAgent) {
      return null;
    }

    const result = await api(`/api/cli-sessions/${session.id}/restart`, {
      method: "POST",
      headers: {
        "X-Agent-Token": uiAgent.token,
      },
      body: JSON.stringify({
        requested_by_agent_id: uiAgent.agent_id,
      }),
    });

    if (result?.session) {
      upsertSession(result.session);
      selectSession(result.session.id, threadId);
      return result.session;
    }

    return null;
  }

  async function stopSelected(api) {
    const threadId = getActiveThreadId();
    const session = getSelectedSession(threadId);
    if (!threadId || !session) {
      return null;
    }

    const uiAgent = await getUiAgent();
    if (!uiAgent) {
      return null;
    }

    const result = await api(`/api/cli-sessions/${session.id}/stop`, {
      method: "POST",
      headers: {
        "X-Agent-Token": uiAgent.token,
      },
      body: JSON.stringify({
        requested_by_agent_id: uiAgent.agent_id,
      }),
    });

    if (result?.session) {
      upsertSession(result.session);
      selectSession(result.session.id, threadId);
      return result.session;
    }

    return null;
  }

  async function sendComposerInput() {
    const session = getSelectedSession();
    if (!session || !isInteractiveSession(session)) {
      return null;
    }

    const composeEl = getComposerEl();
    const value = String(composeEl?.value || "");
    if (!value.trim()) {
      return null;
    }

    if (composeEl) {
      composeEl.value = "";
    }

    await queueRawInput(session.id, value.endsWith("\n") ? value : `${value}\r`);
    if (terminalState.terminal) {
      terminalState.terminal.focus();
    }
    return true;
  }

  function handleComposerKeydown(event) {
    if (!event) {
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendComposerInput();
      return false;
    }
    return true;
  }

  function handleSseEvent(event) {
    const type = String(event?.type || "");
    if (!type.startsWith("cli.session.")) {
      return;
    }

    if (type === "cli.session.output") {
      const sessionId = event?.payload?.session_id;
      const entry = event?.payload?.entry;
      if (terminalState.sessionId && sessionId === terminalState.sessionId) {
        appendTerminalOutput(entry);
      }
      return;
    }

    const session = event?.payload?.session;
    if (session?.thread_id) {
      upsertSession(session);
    }
  }

  window.AcbCliSessions = {
    refreshThread,
    renderThread,
    handleSseEvent,
    getDeliverySummaryForSeq,
    selectSession,
    selectSessionFromElement,
    toggleTerminalVisibility,
    startCodexInteractive: () => startCodexInteractive(window.AcbApi.api),
    restartSelected: () => restartSelected(window.AcbApi.api),
    stopSelected: () => stopSelected(window.AcbApi.api),
    restartLatest: () => restartSelected(window.AcbApi.api),
    stopLatest: () => stopSelected(window.AcbApi.api),
    sendComposerInput,
    handleComposerKeydown,
  };

  window.launchCodexPtySession = () => startCodexInteractive(window.AcbApi.api);
})();
