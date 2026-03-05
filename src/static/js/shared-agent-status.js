(function () {
  /**
   * Determine agent state using SSE connection presence as the primary signal.
   *
   * States (priority order):
   *   Listening — SSE connected + last_activity is msg_wait              (⏳)
   *   Working   — SSE connected + NOT msg_wait + activity within 60s     (⚡)
   *   Idle      — SSE connected + NOT msg_wait + activity older than 60s (🔌)
   *               (SSE open but agent stopped responding — may be processing
   *               a long task or is a stale connection)
   *   Offline   — no SSE + heartbeat expired                             (⚫)
   *
   * For stdio agents (no SSE): fall back to heartbeat-based detection.
   * stdio agents will show Listening when is_online=true, Offline otherwise.
   */
  const WORKING_TIMEOUT_S = 60;

  function getAgentState(agent) {
    if (!agent) return "Offline";

    if (agent.is_sse_connected) {
      if (agent.last_activity === "msg_wait") return "Listening";
      // Check how long ago the last activity was
      const lastActivityTime = agent.last_activity_time ? new Date(agent.last_activity_time) : null;
      if (lastActivityTime) {
        const elapsedS = (Date.now() - lastActivityTime.getTime()) / 1000;
        if (elapsedS > WORKING_TIMEOUT_S) return "Idle";
      }
      return "Working";
    }

    // stdio or truly offline — rely on heartbeat
    if (agent.is_online) return "Listening";
    return "Offline";
  }

  /**
   * Return the state emoji for display in the card.
   * ⏳ Listening, ⚡ Working, 🔌 Idle, ⚫ Offline
   */
  function getStateEmoji(state) {
    const map = { Listening: "⏳", Working: "⚡", Idle: "🔌", Offline: "⚫" };
    return map[state] || "⚫";
  }

  /**
   * Return true if this agent is connected via stdio (no live SSE session).
   * Shown as 📥 badge in the card.
   */
  function isStdioAgent(agent) {
    if (!agent) return false;
    // If the server reports is_sse_connected explicitly, use it.
    if (typeof agent.is_sse_connected === "boolean") return !agent.is_sse_connected;
    // Fallback: unknown transport → don't show badge
    return false;
  }

  function getOfflineTime(agent) {
    const lastActivityTime = agent.last_activity_time ? new Date(agent.last_activity_time) : null;
    if (!lastActivityTime) return null;

    const now = new Date();
    const secondsAgo = (now - lastActivityTime) / 1000;
    const state = getAgentState(agent);
    if (state !== "Offline") return null;

    if (secondsAgo < 60) {
      return `${Math.round(secondsAgo)}s`;
    }
    if (secondsAgo < 3600) {
      const mins = Math.round((secondsAgo / 60) * 10) / 10;
      return `${mins}m`;
    }
    if (secondsAgo < 86400) {
      const hours = Math.round((secondsAgo / 3600) * 10) / 10;
      return `${hours}h`;
    }
    if (secondsAgo < 2592000) {
      const days = Math.round((secondsAgo / 86400) * 10) / 10;
      return `${days}d`;
    }
    if (secondsAgo < 31536000) {
      const months = Math.round((secondsAgo / 2592000) * 10) / 10;
      return `${months}mon`;
    }
    const years = Math.round((secondsAgo / 31536000) * 10) / 10;
    return `${years}y`;
  }

  function isOfflineMoreThanHour(agent) {
    const lastActivityTime = agent.last_activity_time ? new Date(agent.last_activity_time) : null;
    const state = getAgentState(agent);
    if (state !== "Offline") return false;
    if (!lastActivityTime) return true;

    const now = new Date();
    const secondsAgo = (now - lastActivityTime) / 1000;
    return secondsAgo >= 3600;
  }

  function getCompressedOfflineChar(offlineTimeStr) {
    if (!offlineTimeStr) return "∞";
    const match = offlineTimeStr.match(/([hdmony]+)/);
    if (match) {
      return match[1].substring(0, 1);
    }
    return "~";
  }

  /**
   * Build the tooltip text shown on hover of the agent card.
   * Format: "{stateEmoji} {state} — {transport}"
   */
  function getTooltipText(agent, state, offlineDisplay) {
    const stateEmoji = getStateEmoji(state);
    const transport = isStdioAgent(agent) ? "✡️ stdio" : "☸️ SSE";
    let text = `${stateEmoji} ${state} — ${transport}`;
    if (state === "Offline" && offlineDisplay) {
      text += ` — last seen ${offlineDisplay}`;
    }
    return text;
  }

  window.AcbAgentStatus = {
    getAgentState,
    getStateEmoji,
    isStdioAgent,
    getOfflineTime,
    isOfflineMoreThanHour,
    getCompressedOfflineChar,
    getTooltipText,
  };
})();
