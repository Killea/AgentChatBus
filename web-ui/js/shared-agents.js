(function () {
  let _cachedAgents = [];

  function setCachedAgents(agents) {
    _cachedAgents = Array.isArray(agents) ? agents.slice() : [];
    try {
      window.__acbCurrentAgents = _cachedAgents;
    } catch {
      // Ignore global cache assignment failures and keep local cache usable.
    }
  }

  function getCachedAgents() {
    return Array.isArray(_cachedAgents) ? _cachedAgents.slice() : [];
  }

  function updateOnlinePresence({
    onlineAgentKeys,
    onlineAgentLabelsByKey,
    activeThreadLastSeenMs,
    activeThreadLabelsByKey,
    threadActivityWindowMs,
    activeThreadId,
  }) {
    const countEl = document.getElementById("online-count");
    const badgeEl = document.getElementById("online-presence");
    if (!countEl || !badgeEl) return;

    const onlineAgentEntries = Array.from(onlineAgentKeys).map((key) => ({
      key,
      label: onlineAgentLabelsByKey.get(key) || key,
    }));
    const onlineAgents = onlineAgentEntries
      .map((x) => String(x.label))
      .sort((a, b) => a.localeCompare(b));

    const nowMs = Date.now();
    // All participant keys for the active thread (both online and offline)
    const threadAllKeys = Array.from(activeThreadLabelsByKey.keys());

    // Determine which of the thread participants are considered online/recent
    const threadOnlineKeys = threadAllKeys.filter((key) => {
      if (onlineAgentKeys.has(key)) return true;
      const lastSeenMs = activeThreadLastSeenMs.get(key);
      return typeof lastSeenMs === "number" && nowMs - lastSeenMs <= threadActivityWindowMs;
    });

    const threadAllAgents = threadAllKeys
      .map((key) => String(activeThreadLabelsByKey.get(key) || onlineAgentLabelsByKey.get(key) || key))
      .sort((a, b) => a.localeCompare(b));

    const threadOnlineAgents = threadOnlineKeys
      .map((key) => String(activeThreadLabelsByKey.get(key) || onlineAgentLabelsByKey.get(key) || key))
      .sort((a, b) => a.localeCompare(b));

    const showingThreadScoped = Boolean(activeThreadId);
    const total = showingThreadScoped ? threadAllKeys.length : onlineAgentEntries.length;

    countEl.textContent = showingThreadScoped ? `Thread agents ${total}` : `Online agents ${total}`;

    const tooltip = showingThreadScoped
      ? `Thread participants: ${threadAllAgents.length ? threadAllAgents.join(", ") : "(none)"} | Thread online: ${threadOnlineAgents.length ? threadOnlineAgents.join(", ") : "(none)"} | Global online: ${onlineAgents.length ? onlineAgents.join(", ") : "(none)"}`
      : `Agents: ${onlineAgents.length ? onlineAgents.join(", ") : "(none)"}`;
    if (window.AcbTooltip && window.AcbTooltip.setTooltip) {
      window.AcbTooltip.setTooltip(badgeEl, tooltip);
      window.AcbTooltip.setTooltip(countEl, tooltip);
    } else {
      badgeEl.title = tooltip;
      countEl.title = tooltip;
    }
  }

  function getAgentDisplayName(msg) {
    if (!msg) return null;
    const role = String(msg.role ?? "").toLowerCase();
    const author = String(msg.author_name ?? msg.author ?? "").trim();
    if (!author) return null;
    if (role === "system") return null;
    const lower = author.toLowerCase();
    if (lower === "human" || lower === "system") return null;
    return author;
  }

  function getAgentPresenceKey(msg) {
    if (!msg) return null;
    const role = String(msg.role ?? "").toLowerCase();
    if (role === "system") return null;
    const label = String(msg.author_name ?? msg.author ?? "").trim().toLowerCase();
    if (!label || label === "human" || label === "system") return null;
    const key = String(msg.author_id ?? msg.author_name ?? msg.author ?? "").trim();
    return key || null;
  }

  function recordThreadAgentActivity({ key, label, createdAtIso, activeThreadLastSeenMs, activeThreadLabelsByKey }) {
    if (!key) return;
    const parsed = createdAtIso ? Date.parse(createdAtIso) : NaN;
    const seenMs = Number.isFinite(parsed) ? parsed : Date.now();
    const prev = activeThreadLastSeenMs.get(key) || 0;
    if (seenMs > prev) activeThreadLastSeenMs.set(key, seenMs);
    if (label) activeThreadLabelsByKey.set(key, label);
  }

  function rebuildActiveThreadParticipants({ messages, getAgentPresenceKey, getAgentDisplayName, recordThreadAgentActivity, activeThreadLastSeenMs, activeThreadLabelsByKey }) {
    activeThreadLastSeenMs.clear();
    activeThreadLabelsByKey.clear();
    (messages || []).forEach((m) => {
      const key = getAgentPresenceKey(m);
      const label = getAgentDisplayName(m);
      if (key) {
        recordThreadAgentActivity({
          key,
          label,
          createdAtIso: m.created_at,
          activeThreadLastSeenMs,
          activeThreadLabelsByKey,
        });
      }
    });
  }

  async function refreshAgents({
    api,
    hideAgentTooltip,
    setCurrentAgents,
    onlineAgentKeys,
    onlineAgentLabelsByKey,
    updateOnlinePresence,
  }) {
    hideAgentTooltip();
    const allAgents = (await api("/api/agents")) || [];
    setCachedAgents(allAgents);
    setCurrentAgents(allAgents);
    onlineAgentKeys.clear();
    onlineAgentLabelsByKey.clear();

    allAgents.forEach((a) => {
      const key = String(a.id ?? a.agent_id ?? a.name ?? "").trim();
      const label = String(a.display_name ?? a.name ?? "").trim();
      if (a.is_online && key) {
        onlineAgentKeys.add(key);
        onlineAgentLabelsByKey.set(key, label || key);
      }
    });

    updateOnlinePresence();
  }

  async function updateStatusBar({
    api,
    setCurrentAgents,
    getActiveThreadId,
    getAgentState,
    getStateEmoji,
    getOfflineTime,
    isOfflineMoreThanHour,
    getCompressedOfflineChar,
    isStdioAgent,
    getTooltipText,
    escapeHtml,
    bindAgentTooltipEvents,
  }) {
    const activeThreadIdVal = getActiveThreadId();
    const agentsPath = activeThreadIdVal
      ? `/api/threads/${encodeURIComponent(activeThreadIdVal)}/agents`
      : "/api/agents";
    const allAgents = (await api(agentsPath)) || [];
    setCachedAgents(allAgents);
    setCurrentAgents(allAgents);
    const container = document.getElementById("agent-status-list");
    if (!container) return;

    let participants = [];
    const isThreadMode = Boolean(activeThreadIdVal);

    if (isThreadMode) {
      // Thread mode now receives a server-filtered list of thread participants.
      participants = allAgents;
    } else {
      // When no thread is selected, show only online agents
      participants = allAgents.filter((a) => a.is_online || a.is_sse_connected);
    }

    participants.sort((a, b) => {
      // First sort by online status (online first)
      if (a.is_online !== b.is_online) {
        return a.is_online ? -1 : 1;
      }
      // Then sort by name alphabetically for stable order
      const nameA = String(a.display_name ?? a.name ?? "").toLowerCase();
      const nameB = String(b.display_name ?? b.name ?? "").toLowerCase();
      return nameA.localeCompare(nameB);
    });

    container.innerHTML = "";
    if (participants.length === 0) {
      container.innerHTML = '<div style="color:var(--text-3);font-size:11px;padding:4px 12px;">No active agents</div>';
      return;
    }

    participants.forEach((a) => {
      const state = getAgentState(a);
      const avatarEmoji = String(a?.emoji || "").trim() || "🤖";
      const stateEmoji = getStateEmoji(state);
      const label = String(a.display_name ?? a.name ?? "").trim() || "Unknown";
      const offlineTime = getOfflineTime(a);
      const offlineDisplay = offlineTime ? ` (${offlineTime})` : "";
      const isLongOffline = isOfflineMoreThanHour(a);
      const compressedChar = getCompressedOfflineChar(offlineTime);
      const isStdio = isStdioAgent ? isStdioAgent(a) : false;
      const tooltipText = getTooltipText ? getTooltipText(a, state, offlineTime) : state;

      const item = document.createElement("acb-agent-status-item");
      item.setData({
        avatarEmoji,
        stateEmoji,
        label,
        state,
        offlineDisplay,
        isLongOffline,
        compressedChar,
        isStdio,
        tooltipText,
        skills: a.skills,
        escapeHtml,
      });

      if (a && a.id) {
        item.dataset.agentId = a.id;
        item.dataset.agentLabel = label;
        bindAgentTooltipEvents(item, a);
      } else if (a && a.agent_id) {
        item.dataset.agentId = a.agent_id;
        item.dataset.agentLabel = label;
      }
      container.appendChild(item);
    });
  }

  window.AcbAgents = {
    getCachedAgents,
    updateOnlinePresence,
    getAgentDisplayName,
    getAgentPresenceKey,
    recordThreadAgentActivity,
    rebuildActiveThreadParticipants,
    refreshAgents,
    updateStatusBar,
  };
})();
