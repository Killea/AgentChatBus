(function () {
  const sessionsByThread = new Map();
  const activeSessionIdByThread = new Map();
  const terminalVisibilityByThread = new Map();
  const terminalInstances = new Map();
  const headlessOutputStateBySession = new Map();
  const threadAgentsByThread = new Map();
  const ACTIVE_SESSION_STATES = new Set(["created", "starting", "running"]);
  const DELIVERY_BUSY_REPLY_STATES = new Set(["waiting_for_reply", "working", "streaming"]);
  const DELIVERY_BUSY_AUTOMATION_STATES = new Set([
    "codex_working",
    "claude_working",
    "cursor_working",
    "gemini_working",
    "copilot_working",
  ]);

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

  function getSessionCountEl() {
    return document.getElementById("cli-session-count");
  }

  function getDetailEl() {
    return document.getElementById("cli-session-detail");
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
    const sessionMap = sessionsByThread.get(threadId);
    sessionsByThread.delete(threadId);
    threadAgentsByThread.delete(threadId);
    activeSessionIdByThread.delete(threadId);
    if (sessionMap instanceof Map) {
      for (const sessionId of sessionMap.keys()) {
        teardownHeadlessOutputState(sessionId);
      }
    }
    for (const sessionId of Array.from(terminalInstances.keys())) {
      const instance = terminalInstances.get(sessionId);
      if (instance?.threadId === threadId) {
        teardownTerminalInstance(sessionId);
      }
    }
  }

  function sessionDisplayName(session) {
    return String(session?.participant_display_name || "").trim() || sessionLabel(session);
  }

  function sessionLabel(session) {
    const participantLabel = String(session?.participant_display_name || "").trim();
    if (session?.adapter === "codex" && session?.mode === "headless") {
      return participantLabel ? `${participantLabel} · Codex JSON resume` : "Codex JSON resume";
    }
    if (session?.adapter === "codex" && session?.mode === "interactive") {
      return participantLabel ? `${participantLabel} · Codex PTY` : "Codex PTY";
    }
    if (session?.adapter === "cursor" && session?.mode === "headless") {
      return participantLabel ? `${participantLabel} · Cursor JSON resume` : "Cursor JSON resume";
    }
    if (session?.adapter === "copilot" && session?.mode === "headless") {
      return participantLabel ? `${participantLabel} · Copilot JSON resume` : "Copilot JSON resume";
    }
    const base = `${String(session?.adapter || "cli")} ${String(session?.mode || "session")}`;
    return participantLabel ? `${participantLabel} · ${base}` : base;
  }

  function sessionAvatar(session) {
    const resolvedEmoji = String(session?.participant_emoji || "").trim();
    if (resolvedEmoji) {
      return resolvedEmoji;
    }
    const candidate = sessionDisplayName(session).replace(/[^A-Za-z0-9]/g, "");
    return String(candidate.charAt(0) || String(session?.adapter || "A").charAt(0) || "A").toUpperCase();
  }

  function resolvedRole(session) {
    return String(session?.resolved_participant_role || session?.participant_role || "").trim().toLowerCase();
  }

  function stateLabel(state) {
    const raw = String(state || "unknown");
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  function roleLabel(session) {
    return resolvedRole(session) === "administrator" ? "Administrator" : "Participant";
  }

  function roleTone(session) {
    return resolvedRole(session) === "administrator" ? "admin" : "participant";
  }

  function isInteractiveSession(session) {
    return Boolean(session?.supports_input);
  }

  function isActiveSession(session) {
    return ACTIVE_SESSION_STATES.has(String(session?.state || ""));
  }

  function compareSessionsForDisplay(left, right) {
    const leftAdmin = resolvedRole(left) === "administrator" ? 0 : 1;
    const rightAdmin = resolvedRole(right) === "administrator" ? 0 : 1;
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
    return Array.from((sessionsByThread.get(threadId) || new Map()).values()).sort(compareSessionsForDisplay);
  }

  function getParticipantSessionsForThread(threadId) {
    return getSessionsForThread(threadId).filter((session) => Boolean(session?.participant_agent_id));
  }

  function isSessionDeliveryBusy(session) {
    if (!session || !isActiveSession(session)) {
      return false;
    }

    if (String(session?.interactive_work_state || "").trim() === "busy") {
      return true;
    }

    if (String(session?.meeting_post_state || "").trim() === "posting") {
      return true;
    }

    if (DELIVERY_BUSY_REPLY_STATES.has(String(session?.reply_capture_state || "").trim())) {
      return true;
    }

    if (DELIVERY_BUSY_AUTOMATION_STATES.has(String(session?.automation_state || "").trim())) {
      return true;
    }

    return false;
  }

  function getDeliverySummaryForSeq(seq, threadId = getActiveThreadId()) {
    const normalizedSeq = Number(seq);
    if (!threadId || !Number.isFinite(normalizedSeq) || normalizedSeq <= 0) {
      return null;
    }

    const sessions = getParticipantSessionsForThread(threadId).filter((session) => isActiveSession(session));
    if (!sessions.length) {
      return null;
    }

    const delivered = [];
    const waiting = [];
    for (const session of sessions) {
      const label = sessionDisplayName(session);
      const acknowledgedSeq = Number(session?.last_acknowledged_seq) || 0;
      const deliveryBusy = isSessionDeliveryBusy(session);
      const deliverySettled = acknowledgedSeq >= normalizedSeq && !deliveryBusy;

      if (deliverySettled) {
        delivered.push(label);
      } else {
        waiting.push(label);
      }
    }

    return {
      participantCount: sessions.length,
      delivered,
      waiting,
      waitingCount: waiting.length,
      deliveredCount: delivered.length,
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
    return sessionMap.get(sessionId) || null;
  }

  function selectSessionFromElement(element) {
    const sessionId = element?.getAttribute("data-session-id");
    return selectSession(sessionId);
  }

  function getTerminalInstance(sessionId) {
    return terminalInstances.get(sessionId) || null;
  }

  function teardownTerminalInstance(sessionId) {
    const runtime = terminalInstances.get(sessionId);
    if (!runtime) {
      return;
    }
    if (runtime.resizeObserver) {
      runtime.resizeObserver.disconnect();
    }
    if (runtime.resizeTimer) {
      window.clearTimeout(runtime.resizeTimer);
    }
    if (runtime.terminal) {
      runtime.terminal.dispose();
    }
    terminalInstances.delete(sessionId);
  }

  function teardownHeadlessOutputState(sessionId) {
    headlessOutputStateBySession.delete(sessionId);
  }

  function teardownAllTerminals() {
    for (const sessionId of Array.from(terminalInstances.keys())) {
      teardownTerminalInstance(sessionId);
    }
    headlessOutputStateBySession.clear();
  }

  function writeTerminalNotice(sessionId, message) {
    const runtime = getTerminalInstance(sessionId);
    if (!runtime?.terminal) {
      return;
    }
    runtime.terminal.write(`\r\n[agentchatbus] ${message}\r\n`);
  }

  async function getUiAgent() {
    return window.AcbUiAgent ? await window.AcbUiAgent.ensureUiAgent() : null;
  }

  async function syncTerminalSize(sessionId) {
    const runtime = getTerminalInstance(sessionId);
    if (!runtime?.fitAddon || !runtime.hostEl?.isConnected) {
      return;
    }

    const dims = runtime.fitAddon.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) {
      return;
    }

    const nextCols = Math.max(1, Math.floor(dims.cols));
    const nextRows = Math.max(1, Math.floor(dims.rows));
    if (runtime.lastResizeCols === nextCols && runtime.lastResizeRows === nextRows) {
      return;
    }

    runtime.fitAddon.fit();
    runtime.lastResizeCols = nextCols;
    runtime.lastResizeRows = nextRows;

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
    const runtime = getTerminalInstance(sessionId);
    if (!runtime) {
      return;
    }
    if (runtime.resizeTimer) {
      window.clearTimeout(runtime.resizeTimer);
    }
    runtime.resizeTimer = window.setTimeout(() => {
      syncTerminalSize(sessionId).catch((error) => {
        writeTerminalNotice(sessionId, error instanceof Error ? error.message : String(error));
      });
    }, 80);
  }

  function appendTerminalOutput(sessionId, entry) {
    const runtime = getTerminalInstance(sessionId);
    if (!runtime?.terminal || !entry || typeof entry.seq !== "number") {
      return;
    }
    if (entry.seq <= runtime.outputCursor) {
      return;
    }
    runtime.terminal.write(String(entry.text || ""));
    runtime.outputCursor = entry.seq;
  }

  function normalizeSessionLogText(value) {
    return String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();
  }

  function joinDistinctLogSections(values) {
    const seen = new Set();
    const sections = [];
    values.forEach((value) => {
      const normalized = normalizeSessionLogText(value);
      if (!normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      sections.push(normalized);
    });
    return sections.join("\n\n");
  }

  function buildHeadlessSessionFallbackText(session) {
    const rawErrors = Array.isArray(session?.raw_result?.errors)
      ? session.raw_result.errors.map((entry) => normalizeSessionLogText(entry)).filter(Boolean)
      : [];
    const combined = joinDistinctLogSections([
      session?.last_error,
      session?.stderr_excerpt,
      session?.stdout_excerpt,
      ...rawErrors,
      session?.last_result,
    ]);
    if (combined) {
      return combined;
    }
    if (String(session?.state || "") === "failed") {
      return "This headless session failed before any terminal output was captured.";
    }
    return "Headless session output will appear here when logs or results become available.";
  }

  function buildHeadlessSessionOutputText(session, entries) {
    const logText = normalizeSessionLogText(
      Array.isArray(entries)
        ? entries.map((entry) => String(entry?.text || "")).join("")
        : "",
    );
    if (logText) {
      return logText;
    }
    return buildHeadlessSessionFallbackText(session);
  }

  function renderHeadlessSessionText(hostEl, session, text) {
    if (!hostEl) {
      return;
    }
    hostEl.innerHTML = "";
    const transcriptEl = document.createElement("pre");
    transcriptEl.className = "cli-session-terminal__transcript";
    if (String(session?.state || "") === "failed") {
      transcriptEl.classList.add("cli-session-terminal__transcript--error");
    }
    if (!normalizeSessionLogText(text)) {
      transcriptEl.classList.add("cli-session-terminal__transcript--muted");
    }
    transcriptEl.textContent = text;
    hostEl.appendChild(transcriptEl);
  }

  async function mountHeadlessOutputForSessionCard(session, hostEl) {
    if (!hostEl) {
      return;
    }

    const outputCursor = Number(session?.output_cursor) || 0;
    const sessionState = String(session?.state || "");
    const lastError = String(session?.last_error || "");
    const existing = headlessOutputStateBySession.get(session.id);
    if (
      existing
      && existing.hostEl === hostEl
      && existing.outputCursor === outputCursor
      && existing.sessionState === sessionState
      && existing.lastError === lastError
    ) {
      return;
    }

    const runtime = {
      hostEl,
      outputCursor,
      sessionState,
      lastError,
    };
    headlessOutputStateBySession.set(session.id, runtime);
    renderHeadlessSessionText(hostEl, session, buildHeadlessSessionFallbackText(session));

    if (outputCursor <= 0) {
      return;
    }

    try {
      const result = await window.AcbApi.api(`/api/cli-sessions/${session.id}/output?after=0&limit=1000`);
      const latest = headlessOutputStateBySession.get(session.id);
      if (!latest || latest !== runtime || latest.hostEl !== hostEl) {
        return;
      }
      const entries = Array.isArray(result?.entries) ? result.entries : [];
      renderHeadlessSessionText(hostEl, session, buildHeadlessSessionOutputText(session, entries));
    } catch (error) {
      const latest = headlessOutputStateBySession.get(session.id);
      if (!latest || latest !== runtime || latest.hostEl !== hostEl) {
        return;
      }
      const notice = joinDistinctLogSections([
        buildHeadlessSessionFallbackText(session),
        error instanceof Error ? error.message : String(error),
      ]);
      renderHeadlessSessionText(hostEl, session, notice);
    }
  }

  async function mountTerminalForSessionCard(session, hostEl) {
    if (!isInteractiveSession(session) || !hostEl) {
      return;
    }

    const existing = getTerminalInstance(session.id);
    if (existing?.hostEl === hostEl && existing.terminal) {
      scheduleTerminalResize(session.id);
      return;
    }

    if (existing) {
      teardownTerminalInstance(session.id);
    }

    hostEl.innerHTML = "";

    if (!window.Terminal || !window.FitAddon || !window.FitAddon.FitAddon) {
      hostEl.innerHTML = '<div class="cli-session-terminal__fallback">xterm.js did not load.</div>';
      return;
    }

    const terminal = new window.Terminal({
      allowTransparency: true,
      cursorBlink: true,
      convertEol: false,
      disableStdin: true,
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
    terminal.open(hostEl);
    if (typeof terminal.attachCustomKeyEventHandler === "function") {
      terminal.attachCustomKeyEventHandler(() => false);
    }

    const runtime = {
      sessionId: session.id,
      threadId: session.thread_id,
      terminal,
      fitAddon,
      hostEl,
      outputCursor: 0,
      resizeObserver: null,
      resizeTimer: null,
      lastResizeCols: null,
      lastResizeRows: null,
    };
    terminalInstances.set(session.id, runtime);

    if (typeof ResizeObserver === "function") {
      runtime.resizeObserver = new ResizeObserver(() => {
        scheduleTerminalResize(session.id);
      });
      runtime.resizeObserver.observe(hostEl);
    }

    scheduleTerminalResize(session.id);

    try {
      const result = await window.AcbApi.api(`/api/cli-sessions/${session.id}/output?after=0&limit=1000`);
      const latest = getTerminalInstance(session.id);
      if (!latest || latest.hostEl !== hostEl) {
        return;
      }
      const entries = Array.isArray(result?.entries) ? result.entries : [];
      entries.forEach((entry) => appendTerminalOutput(session.id, entry));
    } catch (error) {
      writeTerminalNotice(session.id, error instanceof Error ? error.message : String(error));
    }
  }

  function ensurePanelShell(panelEl) {
    if (!panelEl || panelEl.dataset.cliSessionShell === "1") {
      return;
    }

    panelEl.innerHTML = `
      <div class="cli-session-strip__header">
        <div class="cli-session-strip__title">
          <span>Agent Sessions</span>
          <span id="cli-session-count" class="cli-session-strip__count">0 sessions</span>
        </div>
      </div>
      <div id="cli-session-detail" class="cli-session-detail cli-session-detail--grid"></div>
    `;
    panelEl.dataset.cliSessionShell = "1";
  }

  function renderHeaderSummary(sessions) {
    const countEl = getSessionCountEl();
    if (!countEl) {
      return;
    }
    const count = Array.isArray(sessions) ? sessions.length : 0;
    countEl.textContent = `${count} session${count === 1 ? "" : "s"}`;
  }

  function renderTerminalToggle(threadId = getActiveThreadId()) {
    const toggleEl = document.getElementById("thread-agent-panel-toggle");
    if (!toggleEl) {
      return;
    }
    const visible = isTerminalVisible(threadId);
    const labelEl = toggleEl.querySelector(".thread-agent-panel-toggle__label");
    if (labelEl) {
      labelEl.textContent = visible ? "Hide Agent Panel" : "Show Agent Panel";
    }
    toggleEl.setAttribute("aria-label", visible ? "Hide agent panel" : "Show agent panel");
    toggleEl.setAttribute("title", visible ? "Hide the agent session panel" : "Show the agent session panel");
  }

  function getSessionStatusText(session) {
    const state = stateLabel(session.state);
    const replyCapture = String(session?.reply_capture_state || "").trim();
    if (replyCapture === "working" || replyCapture === "streaming" || replyCapture === "waiting_for_reply") {
      return "Working";
    }
    if (String(session?.meeting_post_state || "").trim() === "posting") {
      return "Posting";
    }
    return state;
  }

  function canSendManualControl(session) {
    return Boolean(isInteractiveSession(session) && session?.supports_input && session?.state === "running");
  }

  function buildSessionMeta(session) {
    return [
      String(session.adapter || "CLI"),
      String(session.mode || "session"),
    ].join(" · ");
  }

  function truncateMiddle(value, maxLength = 18) {
    const text = String(value || "").trim();
    if (!text || text.length <= maxLength) {
      return text;
    }
    const head = Math.max(6, Math.ceil((maxLength - 3) / 2));
    const tail = Math.max(6, Math.floor((maxLength - 3) / 2));
    return `${text.slice(0, head)}...${text.slice(-tail)}`;
  }

  function collectSessionTextCandidates(session) {
    const values = [
      session?.external_session_id,
      session?.external_request_id,
      session?.stdout_excerpt,
      session?.stderr_excerpt,
      session?.last_result,
      session?.last_error,
    ];
    if (Array.isArray(session?.raw_result?.errors)) {
      session.raw_result.errors.forEach((entry) => values.push(entry));
    }
    values.push(session?.raw_result?.thread_id);
    values.push(session?.raw_result?.session_id);
    values.push(session?.raw_result?.chat_id);
    values.push(session?.raw_result?.conversation_id);
    return values
      .map((value) => String(value || ""))
      .filter(Boolean);
  }

  function extractLastExternalId(session) {
    const directId = String(session?.external_session_id || "").trim();
    if (directId) {
      return directId;
    }

    const candidates = collectSessionTextCandidates(session);
    for (const candidate of candidates) {
      const lineMatch = candidate.match(/^([A-Za-z0-9][A-Za-z0-9._:-]{5,})$/);
      if (lineMatch?.[1]) {
        return String(lineMatch[1]).trim() || null;
      }

      const patterns = [
        /"type"\s*:\s*"thread\.started"[\s\S]*?"thread_id"\s*:\s*"([^"]+)"/g,
        /"session_id"\s*:\s*"([^"]+)"/g,
        /"chat_id"\s*:\s*"([^"]+)"/g,
        /"conversation_id"\s*:\s*"([^"]+)"/g,
      ];
      for (const pattern of patterns) {
        const matches = Array.from(candidate.matchAll(pattern));
        if (matches.length) {
          return String(matches[matches.length - 1][1] || "").trim() || null;
        }
      }
    }
    return null;
  }

  function replaceThreadAgents(threadId, agents) {
    if (!threadId) {
      return;
    }
    const nextMap = new Map();
    if (Array.isArray(agents)) {
      agents.forEach((agent) => {
        if (agent?.id) {
          nextMap.set(String(agent.id), agent);
        }
      });
    }
    threadAgentsByThread.set(threadId, nextMap);
  }

  function getParticipantAgent(session) {
    const threadId = String(session?.thread_id || "");
    const participantAgentId = String(session?.participant_agent_id || "");
    if (!threadId || !participantAgentId) {
      return null;
    }
    return threadAgentsByThread.get(threadId)?.get(participantAgentId) || null;
  }

  function getActiveThreadLifecycleStatus() {
    return String(window.__acbActiveThreadStatus || "").trim().toLowerCase();
  }

  function getSessionStatusInfo(session) {
    const participantAgent = getParticipantAgent(session);
    const sessionThreadId = String(session?.thread_id || "").trim();
    const activeThreadId = String(getActiveThreadId() || "").trim();
    const activeThreadStatus = getActiveThreadLifecycleStatus();
    const state = String(session?.state || "").trim().toLowerCase();
    const meetingTransport = String(session?.meeting_transport || "").trim().toLowerCase();
    const replyCapture = String(session?.reply_capture_state || "").trim().toLowerCase();
    const meetingPost = String(session?.meeting_post_state || "").trim().toLowerCase();
    const automationState = String(session?.automation_state || "").trim().toLowerCase();
    const participantActivity = String(participantAgent?.last_activity || "").trim().toLowerCase();
    const participantOnline = participantAgent?.is_online;
    const lastDeliveredSeq = Number(session?.last_delivered_seq) || 0;
    const lastAcknowledgedSeq = Number(session?.last_acknowledged_seq) || 0;
    const hasHeadlessOutput = Number(session?.output_cursor) > 0;
    const threadClosed = Boolean(
      sessionThreadId
      && activeThreadId
      && sessionThreadId === activeThreadId
      && activeThreadStatus === "closed",
    );

    if (state === "failed") {
      return {
        headline: "Launch Failed",
        detail: "Disconnected. The CLI process failed before it could keep listening.",
        tone: "error",
      };
    }
    if (state === "stopped") {
      return {
        headline: "Disconnected",
        detail: "CLI stopped. You can relaunch or resume this session later.",
        tone: "warn",
      };
    }
    if (state === "completed") {
      return {
        headline: "Disconnected",
        detail: meetingTransport === "agent_mcp"
          ? "Session ended and is no longer waiting in msg_wait. You can resume it later."
          : "One-shot run completed. Start a new session to reconnect.",
        tone: "warn",
      };
    }
    if (threadClosed) {
      return {
        headline: "Disconnected",
        detail: "Thread closed. Automatic coordination stopped; reconnect manually if needed.",
        tone: "warn",
      };
    }
    if (state === "created" || state === "starting") {
      return {
        headline: "Connecting",
        detail: "Starting the CLI process and preparing the session.",
        tone: "pending",
      };
    }
    if (participantOnline === false) {
      return {
        headline: "Disconnected",
        detail: "Agent offline. It is not listening now, but can be resumed later.",
        tone: "warn",
      };
    }
    if (meetingPost === "posting" || participantActivity === "msg_post") {
      return {
        headline: "Connected",
        detail: "Posting a reply to the thread now.",
        tone: "active",
      };
    }
    if (
      replyCapture === "working"
      || replyCapture === "streaming"
      || replyCapture === "waiting_for_reply"
      || String(session?.interactive_work_state || "").trim().toLowerCase() === "busy"
      || DELIVERY_BUSY_AUTOMATION_STATES.has(automationState)
    ) {
      return {
        headline: "Connected",
        detail: "Working on a reply right now.",
        tone: "active",
      };
    }
    if (participantActivity === "msg_wait") {
      return {
        headline: "Connected",
        detail: "Waiting in msg_wait for new messages.",
        tone: "ready",
      };
    }
    if (meetingTransport === "agent_mcp" && participantOnline === true) {
      if (
        state === "running"
        && hasHeadlessOutput
        && meetingPost !== "posting"
        && lastAcknowledgedSeq >= lastDeliveredSeq
      ) {
        return {
          headline: "Connected",
          detail: "Waiting in msg_wait for new messages.",
          tone: "ready",
        };
      }
      if (participantActivity === "registered") {
        return {
          headline: "Connecting",
          detail: "Agent identity is registered, but the MCP wait loop is not ready yet.",
          tone: "pending",
        };
      }
      if (participantActivity === "resume" || participantActivity === "heartbeat") {
        return {
          headline: "Connected",
          detail: "Online, but not currently waiting in msg_wait.",
          tone: "pending",
        };
      }
      if (Number(session?.output_cursor) > 0) {
        return {
          headline: "Connected",
          detail: "MCP session is active, but the wait state is not confirmed yet.",
          tone: "pending",
        };
      }
    }

    return {
      headline: getSessionStatusText(session),
      detail: isActiveSession(session)
        ? "Session process is running."
        : "Session is idle.",
      tone: isActiveSession(session) ? "pending" : "neutral",
    };
  }

  function createSessionCardElement(session) {
    const card = document.createElement("section");
    card.className = "cli-session-card";
    card.dataset.sessionId = String(session.id || "");
    const manualControlButtons = isInteractiveSession(session)
      ? `
          <button type="button" class="btn-secondary btn-compact" data-role="enter">Enter</button>
          <button type="button" class="btn-secondary btn-compact cli-session-card__danger" data-role="escape">ESC</button>
        `
      : "";
    card.innerHTML = `
      <div class="cli-session-card__header">
        <div class="cli-session-card__identity">
          <span class="cli-session-card__avatar" data-role="avatar"></span>
          <div class="cli-session-card__identity-body">
            <div class="cli-session-card__identity-row">
              <span class="cli-session-card__name" data-role="name"></span>
              <span class="cli-session-role-badge" data-role="role"></span>
            </div>
            <div class="cli-session-card__meta" data-role="meta"></div>
            <div class="cli-session-card__external-id" data-role="external-id" hidden></div>
            <div class="cli-session-card__status" data-role="status"></div>
          </div>
        </div>
        <div class="cli-session-card__actions">
          <button type="button" class="btn-secondary btn-compact" data-role="stop">Stop CLI</button>
          <button type="button" class="btn-secondary btn-compact cli-session-card__danger" data-role="kick">Kick Agent</button>
          ${manualControlButtons}
        </div>
      </div>
      <div class="cli-session-card__body">
        <div class="cli-session-terminal__shell cli-session-terminal__shell--card" data-role="terminal-shell">
          <div class="cli-session-terminal cli-session-terminal--card" data-role="terminal"></div>
        </div>
      </div>
    `;

    const enterBtn = card.querySelector('[data-role="enter"]');
    const escapeBtn = card.querySelector('[data-role="escape"]');
    const stopBtn = card.querySelector('[data-role="stop"]');
    const kickBtn = card.querySelector('[data-role="kick"]');
    if (stopBtn) {
      stopBtn.addEventListener("click", () => {
        void confirmAndStopSession(session.id);
      });
    }
    if (kickBtn) {
      kickBtn.addEventListener("click", () => {
        void confirmAndKickAgent(session.id);
      });
    }
    if (enterBtn) {
      enterBtn.addEventListener("click", () => {
        void confirmAndSendControl(session.id, "enter");
      });
    }
    if (escapeBtn) {
      escapeBtn.addEventListener("click", () => {
        void confirmAndSendControl(session.id, "escape");
      });
    }
    return card;
  }

  function updateSessionCardElement(card, session) {
    card.dataset.sessionId = String(session.id || "");
    card.dataset.sessionState = String(session.state || "");

    const avatarEl = card.querySelector('[data-role="avatar"]');
    const nameEl = card.querySelector('[data-role="name"]');
    const roleEl = card.querySelector('[data-role="role"]');
    const metaEl = card.querySelector('[data-role="meta"]');
    const externalIdEl = card.querySelector('[data-role="external-id"]');
    const statusEl = card.querySelector('[data-role="status"]');
    const terminalEl = card.querySelector('[data-role="terminal"]');
    const terminalShellEl = card.querySelector('[data-role="terminal-shell"]');
    const enterBtn = card.querySelector('[data-role="enter"]');
    const escapeBtn = card.querySelector('[data-role="escape"]');
    const stopBtn = card.querySelector('[data-role="stop"]');
    const kickBtn = card.querySelector('[data-role="kick"]');

    if (avatarEl) {
      avatarEl.textContent = sessionAvatar(session);
    }
    if (nameEl) {
      nameEl.textContent = sessionDisplayName(session);
    }
    if (roleEl) {
      roleEl.textContent = roleLabel(session);
      roleEl.className = `cli-session-role-badge cli-session-role-badge--${roleTone(session)}`;
    }
    if (metaEl) {
      metaEl.textContent = buildSessionMeta(session);
    }
    if (externalIdEl) {
      const externalId = extractLastExternalId(session);
      if (externalId) {
        externalIdEl.hidden = false;
        externalIdEl.textContent = `Last external id: ${truncateMiddle(externalId, 22)}`;
        externalIdEl.title = externalId;
      } else {
        externalIdEl.hidden = true;
        externalIdEl.textContent = "";
        externalIdEl.removeAttribute("title");
      }
    }
    if (statusEl) {
      const statusInfo = getSessionStatusInfo(session);
      statusEl.textContent = `${statusInfo.headline} · ${statusInfo.detail}`;
      statusEl.dataset.tone = statusInfo.tone;
    }

    const manualEnabled = canSendManualControl(session);
    const isRunning = String(session?.state || "").trim().toLowerCase() === "running";
    const showManualControls = isInteractiveSession(session);
    if (enterBtn) {
      enterBtn.hidden = !showManualControls;
      enterBtn.disabled = !manualEnabled;
      enterBtn.title = manualEnabled ? "Send Enter to the CLI after confirmation" : "This session cannot receive manual input right now";
    }
    if (escapeBtn) {
      escapeBtn.hidden = !showManualControls;
      escapeBtn.disabled = !manualEnabled;
      escapeBtn.title = manualEnabled ? "Send ESC to the CLI after confirmation" : "This session cannot receive manual input right now";
    }
    if (stopBtn) {
      stopBtn.disabled = !isRunning;
      stopBtn.title = isRunning ? "Stop this CLI process after confirmation" : "This CLI process is not running";
    }
    if (kickBtn) {
      const hasParticipantAgent = Boolean(String(session?.participant_agent_id || "").trim());
      kickBtn.disabled = !hasParticipantAgent;
      kickBtn.title = hasParticipantAgent
        ? "Force this agent offline after confirmation"
        : "No participant agent is attached to this session";
    }

    if (isInteractiveSession(session)) {
      if (terminalShellEl) {
        terminalShellEl.hidden = false;
      }
      if (terminalEl) {
        void mountTerminalForSessionCard(session, terminalEl);
      }
    } else {
      teardownTerminalInstance(session.id);
      if (terminalShellEl) {
        terminalShellEl.hidden = false;
      }
      if (terminalEl) {
        void mountHeadlessOutputForSessionCard(session, terminalEl);
      }
    }
  }

  function renderSessionCards(detailEl, sessions) {
    if (!detailEl) {
      return;
    }

    const existingCards = new Map(
      Array.from(detailEl.querySelectorAll(".cli-session-card")).map((card) => [card.dataset.sessionId, card]),
    );
    const nextIds = new Set(sessions.map((session) => String(session.id || "")));

    for (const [sessionId, card] of existingCards.entries()) {
      if (!nextIds.has(sessionId)) {
        teardownTerminalInstance(sessionId);
        teardownHeadlessOutputState(sessionId);
        card.remove();
      }
    }

    sessions.forEach((session) => {
      const sessionId = String(session.id || "");
      let card = existingCards.get(sessionId);
      if (!card) {
        card = createSessionCardElement(session);
      }
      updateSessionCardElement(card, session);
      detailEl.appendChild(card);
    });
  }

  function renderEmptyState(panelEl) {
    ensurePanelShell(panelEl);
    panelEl.hidden = false;
    panelEl.dataset.selectedSessionId = "";
    renderHeaderSummary([]);

    const detailEl = getDetailEl();
    if (detailEl) {
      detailEl.innerHTML = `
        <div class="cli-session-detail__empty">
          <strong>No agent sessions are active for this thread yet.</strong><br>
          Interactive agent terminals will appear here as fixed-size cards when sessions start.
        </div>
      `;
    }

    teardownAllTerminals();
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
      teardownAllTerminals();
      panelEl.hidden = true;
      panelEl.innerHTML = "";
      panelEl.dataset.cliSessionShell = "";
      panelEl.dataset.selectedSessionId = "";
      return;
    }

    ensurePanelShell(panelEl);
    renderTerminalToggle(threadId);
    const terminalVisible = isTerminalVisible(threadId);
    panelEl.hidden = !terminalVisible;
    if (!terminalVisible) {
      teardownAllTerminals();
      if (window.AcbChat?.refreshHumanDeliveryIndicators) {
        window.AcbChat.refreshHumanDeliveryIndicators(threadId);
      }
      return;
    }

    const sessions = getSessionsForThread(threadId);
    if (!sessions.length) {
      renderEmptyState(panelEl);
      return;
    }

    ensureSelectedSession(threadId);
    renderHeaderSummary(sessions);
    renderSessionCards(getDetailEl(), sessions);
    if (window.AcbChat?.refreshHumanDeliveryIndicators) {
      window.AcbChat.refreshHumanDeliveryIndicators(threadId);
    }
  }

  async function refreshThread(threadId, api) {
    if (!threadId) {
      renderThread(null);
      return null;
    }

    const [result, threadAgents] = await Promise.all([
      api(`/api/threads/${threadId}/cli-sessions`),
      api(`/api/threads/${threadId}/agents`).catch(() => []),
    ]);
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    replaceThreadAgents(threadId, Array.isArray(threadAgents) ? threadAgents : []);
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
        mode: "headless",
        meeting_transport: "agent_mcp",
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

  async function stopSessionById(sessionId, api = window.AcbApi.api) {
    const threadId = getActiveThreadId();
    const session = getSessionsForThread(threadId).find((item) => item.id === sessionId);
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

  async function kickAgentById(agentId, api = window.AcbApi.api) {
    if (!agentId) {
      return null;
    }
    return await api(`/api/agents/${agentId}/kick`, {
      method: "POST",
    });
  }

  async function sendManualInput(sessionId, text, notice) {
    const uiAgent = await getUiAgent();
    if (!uiAgent) {
      return null;
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

    if (result?.ok) {
      writeTerminalNotice(sessionId, notice);
    }
    return result;
  }

  async function confirmAndSendControl(sessionId, controlType) {
    const session = getSessionsForThread(getActiveThreadId()).find((item) => item.id === sessionId);
    if (!session || !canSendManualControl(session)) {
      return null;
    }

    const confirmDialog = document.getElementById("confirm-dialog");
    if (!confirmDialog || typeof confirmDialog.show !== "function") {
      return null;
    }

    const isEscape = controlType === "escape";
    const keyLabel = isEscape ? "ESC" : "Enter";
    const confirmed = await confirmDialog.show({
      title: `Send ${keyLabel}`,
      message: `
        <strong>This sends a real ${keyLabel} keypress to the CLI terminal.</strong><br><br>
        This is meant as a manual recovery tool when an agent appears stuck or is waiting at a prompt.<br><br>
        It can interrupt or alter the current automatic flow, so only continue if you really want to send ${keyLabel} to <code>${escapeHtml(sessionDisplayName(session))}</code>.
      `,
      confirmText: `Send ${keyLabel}`,
      confirmClass: isEscape ? "btn-destructive" : "btn-primary",
    });

    if (!confirmed) {
      return null;
    }

    const text = isEscape ? "\u001b" : "\r";
    const notice = isEscape ? "Manual ESC sent." : "Manual Enter sent.";
    return await sendManualInput(sessionId, text, notice);
  }

  async function confirmAndStopSession(sessionId) {
    const threadId = getActiveThreadId();
    const session = getSessionsForThread(threadId).find((item) => item.id === sessionId);
    if (!session) {
      return null;
    }

    const confirmDialog = document.getElementById("confirm-dialog");
    if (!confirmDialog || typeof confirmDialog.show !== "function") {
      return null;
    }

    const confirmed = await confirmDialog.show({
      title: "Stop CLI Session",
      message: `
        <strong>This will stop the CLI process for this session.</strong><br><br>
        Session: <code>${escapeHtml(sessionDisplayName(session))}</code><br><br>
        The thread stays open, but this agent will stop listening until you restart or relaunch it.
      `,
      confirmText: "Stop CLI",
      confirmClass: "btn-destructive",
    });

    if (!confirmed) {
      return null;
    }

    const result = await stopSessionById(sessionId);
    renderThread(threadId);
    return result;
  }

  async function confirmAndKickAgent(sessionId) {
    const threadId = getActiveThreadId();
    const session = getSessionsForThread(threadId).find((item) => item.id === sessionId);
    const participantAgentId = String(session?.participant_agent_id || "").trim();
    if (!session || !participantAgentId) {
      return null;
    }

    const confirmDialog = document.getElementById("confirm-dialog");
    if (!confirmDialog || typeof confirmDialog.show !== "function") {
      return null;
    }

    const confirmed = await confirmDialog.show({
      title: "Kick Agent",
      message: `
        <strong>This will forcibly disconnect the agent and interrupt its current wait state.</strong><br><br>
        Agent: <code>${escapeHtml(sessionDisplayName(session))}</code><br><br>
        Use this only when the agent is stuck, runaway, or should be forced offline immediately.
      `,
      confirmText: "Kick Agent",
      confirmClass: "btn-destructive",
    });

    if (!confirmed) {
      return null;
    }

    const result = await kickAgentById(participantAgentId);
    await refreshThread(threadId, window.AcbApi.api);
    return result;
  }

  function handleSseEvent(event) {
    const type = String(event?.type || "");
    if (!type.startsWith("cli.session.")) {
      return;
    }

    if (type === "cli.session.output") {
      const sessionId = event?.payload?.session_id;
      const entry = event?.payload?.entry;
      if (sessionId) {
        appendTerminalOutput(sessionId, entry);
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
    confirmAndSendControl,
    stopSessionById,
    kickAgentById,
    confirmAndStopSession,
    confirmAndKickAgent,
    startCodexInteractive: () => startCodexInteractive(window.AcbApi.api),
    restartSelected: () => restartSelected(window.AcbApi.api),
    stopSelected: () => stopSelected(window.AcbApi.api),
    restartLatest: () => restartSelected(window.AcbApi.api),
    stopLatest: () => stopSelected(window.AcbApi.api),
  };

  window.launchCodexPtySession = () => startCodexInteractive(window.AcbApi.api);
})();
