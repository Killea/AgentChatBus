(function () {
  const latestSessionByThread = new Map();
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

  function getTerminalEl() {
    return document.getElementById("cli-session-terminal");
  }

  function getComposerEl() {
    return document.getElementById("cli-session-compose");
  }

  function getSessionBadgeEl() {
    return document.getElementById("cli-session-state-badge");
  }

  function getSessionTitleEl() {
    return document.getElementById("cli-session-title-label");
  }

  function getSessionMetaEl() {
    return document.getElementById("cli-session-meta");
  }

  function getSessionSummaryEl() {
    return document.getElementById("cli-session-summary");
  }

  function sessionLabel(session) {
    if (session?.adapter === "codex" && session?.mode === "interactive") {
      return "Codex PTY";
    }
    if (session?.adapter === "cursor" && session?.mode === "headless") {
      return "Cursor smoke test";
    }
    return `${String(session?.adapter || "cli")} ${String(session?.mode || "session")}`;
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
    if (!terminalState.terminal) return;
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
    if (
      terminalState.lastResizeCols === nextCols
      && terminalState.lastResizeRows === nextRows
    ) {
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
    if (!session?.supports_input) {
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

  function renderInteractiveBody(session) {
    return `
      <div class="cli-session-terminal__note">Click the terminal to focus it. Keystrokes are sent to the PTY in real time.</div>
      <div class="cli-session-terminal__shell">
        <div id="cli-session-terminal" class="cli-session-terminal"></div>
      </div>
      <div class="cli-session-compose__row">
        <textarea id="cli-session-compose" class="cli-session-compose" rows="2" placeholder="Optional: send a full prompt line to Codex" onkeydown="return window.AcbCliSessions && window.AcbCliSessions.handleComposerKeydown(event)"></textarea>
        <button class="toolbar-btn cli-session-compose__send" type="button" onclick="window.AcbCliSessions && window.AcbCliSessions.sendComposerInput()">Send</button>
      </div>
      <div id="cli-session-summary">${renderSessionSummary(session)}</div>
    `;
  }

  function renderSessionSummary(session) {
    if (session?.last_result) {
      return `<div class="cli-session-strip__body">${escapeHtml(session.last_result)}</div>`;
    }
    if (session?.last_error) {
      return `<div class="cli-session-strip__body cli-session-strip__body--error">${escapeHtml(session.last_error)}</div>`;
    }
    return "";
  }

  function renderPassiveBody(session) {
    return `<div id="cli-session-summary">${renderSessionSummary(session)}</div>`;
  }

  function buildMetaBits(session) {
    const metaBits = [
      sessionLabel(session),
      `${escapeHtml(session.adapter)} / ${escapeHtml(session.mode)}`,
      `run #${escapeHtml(session.run_count)}`,
    ];
    if (session.shell) {
      metaBits.push(`shell ${escapeHtml(session.shell)}`);
    }
    if (session.automation_state) {
      metaBits.push(`auto ${escapeHtml(session.automation_state)}`);
    }
    if (session.external_session_id) {
      metaBits.push(`external ${escapeHtml(session.external_session_id)}`);
    }
    if (session.cols && session.rows) {
      metaBits.push(`${escapeHtml(session.cols)}x${escapeHtml(session.rows)}`);
    }
    return metaBits;
  }

  function updateSessionChrome(panelEl, session) {
    panelEl.dataset.sessionId = String(session.id || "");
    panelEl.dataset.sessionInteractive = session.supports_input ? "1" : "0";

    const badgeEl = getSessionBadgeEl();
    if (badgeEl) {
      badgeEl.className = `cli-session-strip__badge cli-session-strip__badge--${stateTone(session.state)}`;
      badgeEl.textContent = escapeHtml(session.state);
    }

    const titleEl = getSessionTitleEl();
    if (titleEl) {
      titleEl.textContent = sessionLabel(session);
    }

    const metaEl = getSessionMetaEl();
    if (metaEl) {
      metaEl.innerHTML = buildMetaBits(session)
        .map((bit) => `<span>${bit}</span>`)
        .join("");
    }

    const summaryEl = getSessionSummaryEl();
    if (summaryEl) {
      summaryEl.innerHTML = renderSessionSummary(session);
    }
  }

  function canReuseInteractiveRender(panelEl, session) {
    return Boolean(
      session?.supports_input
      && terminalState.sessionId === session.id
      && terminalState.terminal
      && panelEl?.dataset?.sessionId === session.id
      && panelEl?.dataset?.sessionInteractive === "1"
      && getTerminalEl()
    );
  }

  function renderThread(threadId = getActiveThreadId()) {
    const panelEl = getPanelEl();
    if (!panelEl) return;

    if (!threadId) {
      teardownTerminal();
      panelEl.hidden = true;
      panelEl.innerHTML = "";
      return;
    }

    const session = latestSessionByThread.get(threadId);
    if (!session) {
      teardownTerminal();
      panelEl.hidden = true;
      panelEl.innerHTML = "";
      return;
    }

    panelEl.hidden = false;
    if (canReuseInteractiveRender(panelEl, session)) {
      updateSessionChrome(panelEl, session);
      return;
    }

    panelEl.innerHTML = `
      <div class="cli-session-strip__header">
        <div class="cli-session-strip__title">
          <span id="cli-session-state-badge" class="cli-session-strip__badge cli-session-strip__badge--${stateTone(session.state)}">${escapeHtml(session.state)}</span>
          <span id="cli-session-title-label">${escapeHtml(sessionLabel(session))}</span>
        </div>
        <div class="cli-session-strip__actions">
          <button class="toolbar-btn" type="button" title="Restart CLI session" aria-label="Restart CLI session" onclick="window.AcbCliSessions && window.AcbCliSessions.restartLatest()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10"></path>
              <path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14"></path>
            </svg>
          </button>
          <button class="toolbar-btn" type="button" title="Stop CLI session" aria-label="Stop CLI session" onclick="window.AcbCliSessions && window.AcbCliSessions.stopLatest()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2"></rect>
            </svg>
          </button>
        </div>
      </div>
      <div id="cli-session-meta" class="cli-session-strip__meta">
        ${buildMetaBits(session).map((bit) => `<span>${bit}</span>`).join("")}
      </div>
      ${session.supports_input ? renderInteractiveBody(session) : renderPassiveBody(session)}
    `;
    updateSessionChrome(panelEl, session);

    if (session.supports_input) {
      void mountTerminalForSession(session);
    } else {
      teardownTerminal();
    }
  }

  async function refreshThread(threadId, api) {
    if (!threadId) {
      renderThread(null);
      return null;
    }

    const result = await api(`/api/threads/${threadId}/cli-sessions`);
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    if (sessions.length > 0) {
      latestSessionByThread.set(threadId, sessions[0]);
    } else {
      latestSessionByThread.delete(threadId);
    }
    renderThread(threadId);
    return sessions[0] || null;
  }

  function upsertSession(session) {
    if (!session?.thread_id) return;
    latestSessionByThread.set(session.thread_id, session);
    if (session.thread_id === getActiveThreadId()) {
      renderThread(session.thread_id);
    }
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
      return result.session;
    }
    return null;
  }

  async function restartLatest(api) {
    const threadId = getActiveThreadId();
    if (!threadId) return null;
    const session = latestSessionByThread.get(threadId);
    if (!session) return null;

    const uiAgent = await getUiAgent();
    if (!uiAgent) return null;

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
      return result.session;
    }
    return null;
  }

  async function stopLatest(api) {
    const threadId = getActiveThreadId();
    if (!threadId) return null;
    const session = latestSessionByThread.get(threadId);
    if (!session) return null;

    const uiAgent = await getUiAgent();
    if (!uiAgent) return null;

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
      return result.session;
    }
    return null;
  }

  async function sendComposerInput() {
    const threadId = getActiveThreadId();
    if (!threadId) return null;
    const session = latestSessionByThread.get(threadId);
    if (!session?.supports_input) return null;

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
    if (!event) return true;
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
    startCodexInteractive: () => startCodexInteractive(window.AcbApi.api),
    restartLatest: () => restartLatest(window.AcbApi.api),
    stopLatest: () => stopLatest(window.AcbApi.api),
    sendComposerInput,
    handleComposerKeydown,
  };

  window.launchCodexPtySession = () => startCodexInteractive(window.AcbApi.api);
})();
