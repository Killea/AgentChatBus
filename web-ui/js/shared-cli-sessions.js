(function () {
  const sessionsByThread = new Map();
  const activeSessionIdByThread = new Map();
  const terminalVisibilityByThread = new Map();
  const terminalInstances = new Map();
  const headlessOutputStateBySession = new Map();
  const threadAgentsByThread = new Map();
  const autoScrollPreferencesBySession = new Map();
  const ACTIVE_SESSION_STATES = new Set(["created", "starting", "running"]);
  const DELIVERY_BUSY_REPLY_STATES = new Set(["waiting_for_reply", "working", "streaming"]);
  const DELIVERY_BUSY_AUTOMATION_STATES = new Set([
    "codex_working",
    "claude_working",
    "cursor_working",
    "gemini_working",
    "copilot_working",
  ]);
  const KNOWN_TOOL_NAMES = [
    "bus_connect",
    "msg_wait",
    "msg_post",
    "msg_get",
    "msg_list",
    "msg_edit",
    "msg_react",
    "msg_unreact",
    "thread_create",
    "thread_get",
    "thread_list",
    "thread_close",
    "thread_archive",
    "thread_unarchive",
    "thread_set_state",
    "thread_settings_get",
    "thread_settings_update",
    "agent_register",
    "agent_update",
    "agent_resume",
    "agent_heartbeat",
    "agent_list",
  ];

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
    if (session?.adapter === "cursor" && session?.mode === "headless") {
      return participantLabel ? `${participantLabel} · Cursor JSON resume` : "Cursor JSON resume";
    }
    if (session?.adapter === "copilot" && session?.mode === "headless") {
      return participantLabel ? `${participantLabel} · Copilot JSON resume` : "Copilot JSON resume";
    }
    if (session?.adapter === "claude" && session?.mode === "headless") {
      return participantLabel ? `${participantLabel} · Claude JSON resume` : "Claude JSON resume";
    }
    if (session?.adapter === "gemini" && session?.mode === "headless") {
      return participantLabel ? `${participantLabel} · Gemini JSON resume` : "Gemini JSON resume";
    }
    const base = `${String(session?.adapter || "cli")} ${String(session?.mode || "session")}`;
    return participantLabel ? `${participantLabel} · ${base}` : base;
  }

  function hasBusConnectedParticipant(session) {
    const participantAgent = getParticipantAgent(session);
    return Boolean(
      window.AcbAgentStatus?.hasBusConnectedParticipant?.({
        agent: participantAgent,
        session,
      }),
    );
  }

  function sessionAvatar(session) {
    const participantAgent = getParticipantAgent(session);
    const unifiedStatus = window.AcbAgentStatus?.deriveUnifiedStatus?.({
      agent: participantAgent,
      session,
      threadStatus: getActiveThreadLifecycleStatus(),
    });
    return unifiedStatus?.avatarEmoji || "❓";
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

  function getPromptHistoryEntries(session) {
    if (Array.isArray(session?.prompt_history) && session.prompt_history.length) {
      return session.prompt_history;
    }
    const fallbackPrompt = String(session?.prompt || "");
    if (!fallbackPrompt.trim()) {
      return [];
    }
    return [{
      at: String(session?.created_at || session?.updated_at || ""),
      kind: "initial",
      prompt: fallbackPrompt,
    }];
  }

  function promptHistoryKindLabel(kind) {
    const normalized = String(kind || "").trim().toLowerCase();
    if (normalized === "initial") {
      return "Initial";
    }
    if (normalized === "delivery") {
      return "Delivery";
    }
    if (normalized === "wake") {
      return "Wake";
    }
    if (normalized === "update") {
      return "Update";
    }
    return normalized || "Prompt";
  }

  function buildPromptHistoryTooltip(session) {
    const entries = getPromptHistoryEntries(session);
    if (!entries.length) {
      return "";
    }
    return entries.map((entry, index) => {
      const timestamp = formatToolEventTime(entry?.at);
      const label = promptHistoryKindLabel(entry?.kind);
      const prompt = String(entry?.prompt || "").trim() || "(empty)";
      return `${index + 1}. ${label}${timestamp ? ` ${timestamp}` : ""}\n${prompt}`;
    }).join("\n\n");
  }

  function buildPromptTagLabel(session) {
    const count = getPromptHistoryEntries(session).length;
    return count > 1 ? `Prompt ${count}` : "Prompt";
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

  function getSessionForAgent(threadId, agentId) {
    const resolvedThreadId = String(threadId || "").trim();
    const resolvedAgentId = String(agentId || "").trim();
    if (!resolvedThreadId || !resolvedAgentId) {
      return null;
    }

    const candidates = getSessionsForThread(resolvedThreadId).filter((session) => {
      return String(session?.participant_agent_id || "").trim() === resolvedAgentId;
    });
    if (!candidates.length) {
      return null;
    }
    return choosePreferredSession(candidates) || candidates[0] || null;
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
    return terminalVisibilityByThread.get(threadId) === true;
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
      if (window.AcbAgents?.rerenderStatusBar) {
        void window.AcbAgents.rerenderStatusBar();
      }
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
    autoScrollPreferencesBySession.delete(sessionId);
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

  function getAutoScrollPreference(sessionId, panelType) {
    const existing = autoScrollPreferencesBySession.get(sessionId) || {};
    return existing[panelType] !== false;
  }

  function setAutoScrollPreference(sessionId, panelType, enabled) {
    const existing = autoScrollPreferencesBySession.get(sessionId) || {};
    existing[panelType] = enabled !== false;
    autoScrollPreferencesBySession.set(sessionId, existing);
  }

  function scrollLogBodyToBottom(hostEl, sessionId, panelType) {
    if (!hostEl || !getAutoScrollPreference(sessionId, panelType)) {
      return;
    }

    const scrollTarget = hostEl.matches?.(".cli-session-log__body")
      ? hostEl
      : hostEl.querySelector?.(".cli-session-log__body") || hostEl;

    const applyScroll = () => {
      scrollTarget.scrollTop = Math.max(0, scrollTarget.scrollHeight - scrollTarget.clientHeight);
    };

    applyScroll();
    window.requestAnimationFrame(applyScroll);
  }

  function highlightToolNamesInHtml(escapedText) {
    let html = String(escapedText || "");
    KNOWN_TOOL_NAMES.forEach((toolName) => {
      const pattern = new RegExp(`(^|[^A-Za-z0-9_])(${toolName})(?=$|[^A-Za-z0-9_])`, "g");
      html = html.replace(pattern, (_, prefix, match) => `${prefix}<span class="cli-session-log__tool">${match}</span>`);
    });
    return html;
  }

  function formatLogHtml(text) {
    const escaped = escapeHtml(String(text || ""));
    return highlightToolNamesInHtml(escaped).replace(/\n/g, "<br>");
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
    const transcriptEl = document.createElement("div");
    transcriptEl.className = "cli-session-terminal__transcript cli-session-log__body";
    if (String(session?.state || "") === "failed") {
      transcriptEl.classList.add("cli-session-terminal__transcript--error");
    }
    if (!normalizeSessionLogText(text)) {
      transcriptEl.classList.add("cli-session-terminal__transcript--muted");
    }
    transcriptEl.innerHTML = formatLogHtml(text);
    hostEl.appendChild(transcriptEl);
    scrollLogBodyToBottom(hostEl, session.id, "terminal");
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
    const state = stateLabel(session?.state);
    return state === "Unknown" ? "Disconnected" : state;
  }

  function buildSessionMeta(session) {
    return [
      String(session.adapter || "CLI"),
      String(session.mode || "session"),
    ].join(" · ");
  }

  function formatToolEventTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return "--:--:--";
    }
    return date.toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function renderToolEventSummary(session) {
    const entries = Array.isArray(session?.recent_tool_events) ? session.recent_tool_events : [];
    if (!entries.length) {
      return "No MCP tool calls recorded yet.";
    }
    return entries
      .map((entry) => `${formatToolEventTime(entry?.at)} ${String(entry?.tool_name || "").trim() || "unknown_tool"}`)
      .join(" · ");
  }

  function renderStreamEventSummary(session) {
    const entries = Array.isArray(session?.recent_stream_events) ? session.recent_stream_events : [];
    if (!entries.length) {
      return "No stream input received yet.";
    }
    return entries
      .map((entry) => `${formatToolEventTime(entry?.at)} received ${String(entry?.stream || "stream").trim()}`)
      .join(" · ");
  }

  function buildActivityLogHtml(session) {
    return [
      `<div class="cli-session-log__line">${formatLogHtml(renderTimingSummary(session))}</div>`,
      `<div class="cli-session-log__line">${formatLogHtml(renderToolEventSummary(session))}</div>`,
      `<div class="cli-session-log__line">${formatLogHtml(renderStreamEventSummary(session))}</div>`,
    ].join("");
  }

  function renderTimingSummary(session) {
    const parts = [];
    parts.push(`Requested ${formatToolEventTime(session?.created_at)}`);
    if (session?.launch_started_at) {
      parts.push(`Launch ${formatToolEventTime(session.launch_started_at)}`);
    }
    if (session?.process_started_at) {
      parts.push(`PID ${formatToolEventTime(session.process_started_at)}`);
    }
    if (session?.first_output_at) {
      parts.push(`First output ${formatToolEventTime(session.first_output_at)}`);
    }
    if (session?.connected_at) {
      parts.push(`bus_connect ${formatToolEventTime(session.connected_at)}`);
    }
    if (session?.last_tool_call_at) {
      parts.push(`Last tool ${formatToolEventTime(session.last_tool_call_at)}`);
    }
    if (session?.last_output_at) {
      parts.push(`Last output ${formatToolEventTime(session.last_output_at)}`);
    }
    return parts.join(" · ");
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
    const unifiedStatus = window.AcbAgentStatus?.deriveUnifiedStatus?.({
      agent: participantAgent,
      session,
      threadStatus: getActiveThreadLifecycleStatus(),
    });
    if (unifiedStatus) {
      return {
        headline: unifiedStatus.primaryLabel,
        detail: unifiedStatus.detail,
        tone: unifiedStatus.tone,
        statusText: unifiedStatus.statusText,
        secondaryLabels: unifiedStatus.secondaryLabels,
      };
    }

    return {
      headline: getSessionStatusText(session),
      detail: isActiveSession(session)
        ? "Session process is running."
        : "Session is idle.",
      tone: isActiveSession(session) ? "pending" : "neutral",
      statusText: getSessionStatusText(session),
      secondaryLabels: [],
    };
  }

  function createSessionCardElement(session) {
    const card = document.createElement("section");
    card.className = "cli-session-card";
    card.dataset.sessionId = String(session.id || "");
    card.innerHTML = `
      <div class="cli-session-card__header">
        <div class="cli-session-card__identity">
          <span class="cli-session-card__avatar" data-role="avatar"></span>
          <div class="cli-session-card__identity-body">
            <div class="cli-session-card__identity-row">
              <span class="cli-session-card__name" data-role="name"></span>
              <span class="cli-session-role-badge" data-role="role"></span>
              <span class="cli-session-card__prompt-tag" data-role="prompt-tag" hidden></span>
            </div>
            <div class="cli-session-card__meta" data-role="meta"></div>
            <div class="cli-session-card__external-id" data-role="external-id" hidden></div>
            <div class="cli-session-card__status" data-role="status"></div>
          </div>
        </div>
        <div class="cli-session-card__actions">
          <button type="button" class="btn-secondary btn-compact" data-role="stop">Stop CLI</button>
          <button type="button" class="btn-secondary btn-compact cli-session-card__danger" data-role="kick">Kick Agent</button>
        </div>
      </div>
      <div class="cli-session-card__body">
        <section class="cli-session-log-panel cli-session-log-panel--activity">
          <div class="cli-session-log-panel__header">
            <div class="cli-session-log-panel__title">Activity Log</div>
            <label class="cli-session-log-panel__autoscroll">
              <input type="checkbox" data-role="activity-autoscroll" checked />
              <span>Auto-scroll</span>
            </label>
          </div>
          <div class="cli-session-card__activity cli-session-log__body" data-role="activity"></div>
        </section>
        <section class="cli-session-log-panel cli-session-log-panel--terminal">
          <div class="cli-session-log-panel__header">
            <div class="cli-session-log-panel__title">CLI Output</div>
            <label class="cli-session-log-panel__autoscroll">
              <input type="checkbox" data-role="terminal-autoscroll" checked />
              <span>Auto-scroll</span>
            </label>
          </div>
          <div class="cli-session-terminal__shell cli-session-terminal__shell--card" data-role="terminal-shell">
            <div class="cli-session-terminal cli-session-terminal--card" data-role="terminal"></div>
          </div>
        </section>
      </div>
    `;

    const activityAutoscrollEl = card.querySelector('[data-role="activity-autoscroll"]');
    const terminalAutoscrollEl = card.querySelector('[data-role="terminal-autoscroll"]');
    if (activityAutoscrollEl) {
      activityAutoscrollEl.checked = getAutoScrollPreference(session.id, "activity");
      activityAutoscrollEl.addEventListener("change", () => {
        setAutoScrollPreference(session.id, "activity", activityAutoscrollEl.checked);
        const activityEl = card.querySelector('[data-role="activity"]');
        scrollLogBodyToBottom(activityEl, session.id, "activity");
      });
    }
    if (terminalAutoscrollEl) {
      terminalAutoscrollEl.checked = getAutoScrollPreference(session.id, "terminal");
      terminalAutoscrollEl.addEventListener("change", () => {
        setAutoScrollPreference(session.id, "terminal", terminalAutoscrollEl.checked);
        const terminalEl = card.querySelector('[data-role="terminal"]');
        scrollLogBodyToBottom(terminalEl, session.id, "terminal");
      });
    }

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
    return card;
  }

  function updateSessionCardElement(card, session) {
    card.dataset.sessionId = String(session.id || "");
    card.dataset.sessionState = String(session.state || "");

    const avatarEl = card.querySelector('[data-role="avatar"]');
    const nameEl = card.querySelector('[data-role="name"]');
    const roleEl = card.querySelector('[data-role="role"]');
    const promptTagEl = card.querySelector('[data-role="prompt-tag"]');
    const metaEl = card.querySelector('[data-role="meta"]');
    const externalIdEl = card.querySelector('[data-role="external-id"]');
    const statusEl = card.querySelector('[data-role="status"]');
    const activityEl = card.querySelector('[data-role="activity"]');
    const terminalEl = card.querySelector('[data-role="terminal"]');
    const terminalShellEl = card.querySelector('[data-role="terminal-shell"]');
    const stopBtn = card.querySelector('[data-role="stop"]');
    const kickBtn = card.querySelector('[data-role="kick"]');
    const activityAutoscrollEl = card.querySelector('[data-role="activity-autoscroll"]');
    const terminalAutoscrollEl = card.querySelector('[data-role="terminal-autoscroll"]');

    if (activityAutoscrollEl) {
      activityAutoscrollEl.checked = getAutoScrollPreference(session.id, "activity");
    }
    if (terminalAutoscrollEl) {
      terminalAutoscrollEl.checked = getAutoScrollPreference(session.id, "terminal");
    }

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
    if (promptTagEl) {
      const promptTooltip = buildPromptHistoryTooltip(session);
      if (promptTooltip) {
        promptTagEl.hidden = false;
        promptTagEl.textContent = buildPromptTagLabel(session);
        promptTagEl.title = promptTooltip;
        promptTagEl.setAttribute("aria-label", promptTooltip);
      } else {
        promptTagEl.hidden = true;
        promptTagEl.textContent = "";
        promptTagEl.removeAttribute("title");
        promptTagEl.removeAttribute("aria-label");
      }
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
      statusEl.textContent = `${statusInfo.statusText} · ${statusInfo.detail}`;
      statusEl.dataset.tone = statusInfo.tone;
    }
    if (activityEl) {
      const timingSummary = renderTimingSummary(session);
      const toolSummary = renderToolEventSummary(session);
      const streamSummary = renderStreamEventSummary(session);
      activityEl.innerHTML = buildActivityLogHtml(session);
      activityEl.title = `${timingSummary}\n${toolSummary}\n${streamSummary}`;
      scrollLogBodyToBottom(activityEl, session.id, "activity");
    }

    const isRunning = String(session?.state || "").trim().toLowerCase() === "running";
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

    teardownTerminalInstance(session.id);
    if (terminalShellEl) {
      terminalShellEl.hidden = false;
    }
    if (terminalEl) {
      void mountHeadlessOutputForSessionCard(session, terminalEl);
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
    if (window.AcbAgents?.rerenderStatusBar) {
      await window.AcbAgents.rerenderStatusBar();
    }

    if (window.AcbChat && typeof window.AcbChat.refreshThreadAdmin === "function") {
      await window.AcbChat.refreshThreadAdmin(threadId, api);
    }

    return getSelectedSession(threadId);
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
    getSessionForAgent,
    selectSession,
    selectSessionFromElement,
    toggleTerminalVisibility,
    setTerminalVisibility,
    stopSessionById,
    kickAgentById,
    confirmAndStopSession,
    confirmAndKickAgent,
    restartSelected: () => restartSelected(window.AcbApi.api),
    stopSelected: () => stopSelected(window.AcbApi.api),
    restartLatest: () => restartSelected(window.AcbApi.api),
    stopLatest: () => stopSelected(window.AcbApi.api),
  };
})();
