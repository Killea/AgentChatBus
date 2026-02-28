(function () {
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
    const threadOnlineKeys = Array.from(activeThreadLastSeenMs.entries())
      .filter(
        ([key, lastSeenMs]) =>
          onlineAgentKeys.has(key) || nowMs - lastSeenMs <= threadActivityWindowMs
      )
      .map(([key]) => key);

    const threadOnlineAgents = threadOnlineKeys
      .map((key) => String(activeThreadLabelsByKey.get(key) || onlineAgentLabelsByKey.get(key) || key))
      .sort((a, b) => a.localeCompare(b));

    const showingThreadScoped = Boolean(activeThreadId);
    const total = showingThreadScoped ? threadOnlineKeys.length : onlineAgentEntries.length;

    countEl.textContent = showingThreadScoped ? `Thread online ${total}` : `Online agents ${total}`;

    const tooltip = showingThreadScoped
      ? `Thread online: ${threadOnlineAgents.length ? threadOnlineAgents.join(", ") : "(none)"} | Global online: ${onlineAgents.length ? onlineAgents.join(", ") : "(none)"}`
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
    escapeHtml,
    bindAgentTooltipEvents,
  }) {
    const allAgents = (await api("/api/agents")) || [];
    setCurrentAgents(allAgents);
    const container = document.getElementById("agent-status-list");
    if (!container) return;

    let participants = [];
    let isThreadMode = false;

    if (getActiveThreadId()) {
      const participantIdMap = new Map();
      const msgArea = document.getElementById("messages");
      if (msgArea) {
        const rows = msgArea.querySelectorAll("[data-author-id]");
        rows.forEach((row) => {
          const authorId = row.getAttribute("data-author-id");
          if (authorId && authorId !== "system" && authorId !== "human" && !participantIdMap.has(authorId)) {
            const agent = allAgents.find((a) => a.id === authorId || a.agent_id === authorId);
            if (agent) {
              participantIdMap.set(authorId, agent);
            } else {
              participantIdMap.set(authorId, {
                id: authorId,
                display_name: authorId,
                name: authorId,
                is_online: false,
              });
            }
          }
        });
      }

      participants = Array.from(participantIdMap.values());
      isThreadMode = participants.length > 0;
    }

    if (!isThreadMode) {
      participants = allAgents.filter((a) => getAgentState(a) !== "Offline");
      isThreadMode = false;
    }

    participants.sort((a, b) => {
      if (a.is_online !== b.is_online) {
        return a.is_online ? -1 : 1;
      }
      if (a.is_online && b.is_online) {
        const timeA = a.last_activity_time ? new Date(a.last_activity_time) : new Date(0);
        const timeB = b.last_activity_time ? new Date(b.last_activity_time) : new Date(0);
        return timeB - timeA;
      }
      return 0;
    });

    container.innerHTML = "";
    if (participants.length === 0) {
      container.innerHTML = '<div style="color:var(--text-3);font-size:11px;padding:4px 12px;">No active agents</div>';
      return;
    }

    participants.forEach((a) => {
      const state = getAgentState(a);
      const emoji = getStateEmoji(state);
      const label = String(a.display_name ?? a.name ?? "").trim() || "Unknown";
      const offlineTime = getOfflineTime(a);
      const offlineDisplay = offlineTime ? ` (${offlineTime})` : "";
      const isLongOffline = isOfflineMoreThanHour(a);

      const compressedChar = getCompressedOfflineChar(offlineTime);
      const item = document.createElement("acb-agent-status-item");
      item.setData({
        emoji,
        label,
        state,
        offlineDisplay,
        isLongOffline,
        compressedChar,
        escapeHtml,
      });

      if (a && a.id) {
        item.dataset.agentId = a.id;
        bindAgentTooltipEvents(item, a);
      } else if (a && a.agent_id) {
        item.dataset.agentId = a.agent_id;
      }
      container.appendChild(item);
    });
  }

  window.AcbAgents = {
    updateOnlinePresence,
    getAgentDisplayName,
    getAgentPresenceKey,
    recordThreadAgentActivity,
    rebuildActiveThreadParticipants,
    refreshAgents,
    updateStatusBar,
  };
})();
