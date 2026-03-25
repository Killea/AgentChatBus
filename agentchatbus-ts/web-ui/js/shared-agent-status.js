(function () {
  const BUS_CONNECTED_ACTIVITIES = new Set(["bus_connect", "msg_wait", "msg_received", "msg_post"]);
  const MCP_STATUS_LABELS = new Set(["bus_connect", "msg_wait", "msg_post"]);
  const STREAM_LABEL_MAP = new Map([
    ["thinking", "Thinking"],
    ["streaming", "Streaming"],
  ]);
  const INTERNAL_STATUS_LABELS = new Map([
    ["working", "Thinking"],
    ["streaming", "Streaming"],
    ["waiting_for_reply", "Waiting"],
    ["busy", "Thinking"],
    ["codex_working", "Thinking"],
    ["claude_working", "Thinking"],
    ["cursor_working", "Thinking"],
    ["gemini_working", "Thinking"],
    ["copilot_working", "Thinking"],
  ]);
  const PRIMARY_STATE_EMOJI = {
    Starting: "🚀",
    Connecting: "🟡",
    Connected: "🟢",
    Disconnected: "⚫",
  };

  function normalizeLower(value) {
    return String(value || "").trim().toLowerCase();
  }

  function pushUnique(target, value) {
    const normalized = String(value || "").trim();
    if (!normalized || target.includes(normalized)) {
      return;
    }
    target.push(normalized);
  }

  function formatAgentFallbackLabel(agent, session) {
    const sessionName = String(session?.participant_display_name || "").trim();
    if (sessionName) {
      return sessionName;
    }
    const agentName = String(agent?.preferred_display_name ?? agent?.display_name ?? agent?.name ?? "").trim();
    if (agentName) {
      return agentName;
    }
    return "Agent";
  }

  function resolveAvatarEmoji({ agent, session, identityResolved }) {
    if (!identityResolved) {
      return "❓";
    }

    const sessionEmoji = String(session?.participant_emoji || "").trim();
    if (sessionEmoji) {
      return sessionEmoji;
    }

    const agentEmoji = String(agent?.emoji || "").trim();
    if (agentEmoji) {
      return agentEmoji;
    }

    const label = formatAgentFallbackLabel(agent, session).replace(/[^A-Za-z0-9]/g, "");
    return String(label.charAt(0) || String(session?.adapter || "A").charAt(0) || "A").toUpperCase();
  }

  function mapStreamLabel(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }
    return STREAM_LABEL_MAP.get(raw.toLowerCase()) || raw;
  }

  function getRecentToolEntries(session) {
    return Array.isArray(session?.recent_tool_events) ? session.recent_tool_events : [];
  }

  function getRecentStreamEntries(session) {
    return Array.isArray(session?.recent_stream_events) ? session.recent_stream_events : [];
  }

  function hasBusConnectedParticipant({ agent, session }) {
    const participantActivity = normalizeLower(agent?.last_activity);
    if (BUS_CONNECTED_ACTIVITIES.has(participantActivity)) {
      return true;
    }

    if (session?.connected_at) {
      return true;
    }

    return getRecentToolEntries(session).some((entry) => normalizeLower(entry?.tool_name) === "bus_connect");
  }

  function buildSecondaryLabels({ agent, session, identityResolved, primaryLabel, isDisconnected }) {
    const secondaryLabels = [];

    if (isDisconnected) {
      const sessionState = normalizeLower(session?.state);
      if (sessionState === "failed" || sessionState === "stopped" || sessionState === "completed") {
        pushUnique(secondaryLabels, sessionState);
      }
      return secondaryLabels;
    }

    const participantActivity = normalizeLower(agent?.last_activity);
    if (identityResolved && MCP_STATUS_LABELS.has(participantActivity)) {
      pushUnique(secondaryLabels, participantActivity);
    }

    getRecentToolEntries(session).forEach((entry) => {
      const toolName = normalizeLower(entry?.tool_name);
      if (toolName === "bus_connect" && primaryLabel === "Connected") {
        pushUnique(secondaryLabels, "bus_connect");
        return;
      }
      if (toolName === "msg_wait" || toolName === "msg_post") {
        pushUnique(secondaryLabels, toolName);
      }
    });

    const replyCapture = normalizeLower(session?.reply_capture_state);
    const meetingPost = normalizeLower(session?.meeting_post_state);
    const interactiveWork = normalizeLower(session?.interactive_work_state);
    const automationState = normalizeLower(session?.automation_state);

    if (meetingPost === "posting") {
      pushUnique(secondaryLabels, "msg_post");
    }

    [replyCapture, interactiveWork, automationState].forEach((value) => {
      const mapped = INTERNAL_STATUS_LABELS.get(value);
      if (mapped) {
        pushUnique(secondaryLabels, mapped);
      }
    });

    getRecentStreamEntries(session).forEach((entry) => {
      pushUnique(secondaryLabels, mapStreamLabel(entry?.stream));
    });

    return secondaryLabels;
  }

  function buildDetail({ agent, session, primaryLabel, identityResolved, threadStatus }) {
    const state = normalizeLower(session?.state);
    const participantActivity = normalizeLower(agent?.last_activity);
    const threadClosed = normalizeLower(threadStatus) === "closed";

    if (state === "failed") {
      return "CLI launch failed before the agent could stay connected.";
    }
    if (state === "stopped") {
      return "CLI stopped. The session can be resumed later.";
    }
    if (state === "completed") {
      return "CLI run completed and is no longer waiting in msg_wait.";
    }
    if (threadClosed) {
      return "Thread is closed. Coordination stopped until you reconnect manually.";
    }
    if (!identityResolved) {
      if (state === "created" || state === "starting") {
        return "Starting the CLI process and preparing bus_connect.";
      }
      if (state === "running") {
        return "CLI is running, but bus_connect has not completed yet.";
      }
      if (agent?.is_online === false) {
        return "Agent is offline and not listening right now.";
      }
      return "Waiting for the CLI session to reach bus_connect.";
    }
    if (participantActivity === "msg_post") {
      return "Posting a reply to the thread now.";
    }
    if (participantActivity === "msg_wait") {
      return "Waiting in msg_wait for new messages.";
    }
    if (primaryLabel === "Connected") {
      return "Connected to the bus and actively processing session work.";
    }
    return "Agent session status is available.";
  }

  function deriveUnifiedStatus({ agent = null, session = null, threadStatus = "", now = new Date() } = {}) {
    const sessionState = normalizeLower(session?.state);
    const participantActivity = normalizeLower(agent?.last_activity);
    const threadState = normalizeLower(threadStatus);
    const identityResolved = hasBusConnectedParticipant({ agent, session });

    let primaryLabel = "Disconnected";
    let tone = "warn";
    let connectionPhase = "disconnected";

    if (sessionState === "failed") {
      primaryLabel = "Disconnected";
      tone = "error";
      connectionPhase = "disconnected";
    } else if (sessionState === "stopped" || sessionState === "completed" || threadState === "closed") {
      primaryLabel = "Disconnected";
      tone = "warn";
      connectionPhase = "disconnected";
    } else if (sessionState === "created" || sessionState === "starting") {
      primaryLabel = "Starting";
      tone = "pending";
      connectionPhase = "starting";
    } else if (sessionState === "running" && !identityResolved) {
      primaryLabel = "Connecting";
      tone = "pending";
      connectionPhase = "connecting";
    } else if (identityResolved) {
      primaryLabel = "Connected";
      if (participantActivity === "msg_wait") {
        tone = "ready";
      } else if (participantActivity === "msg_post") {
        tone = "active";
      } else {
        tone = "active";
      }
      connectionPhase = "connected";
    } else if (agent?.is_online || agent?.is_sse_connected) {
      primaryLabel = "Connecting";
      tone = "pending";
      connectionPhase = "connecting";
    } else {
      primaryLabel = "Disconnected";
      tone = "warn";
      connectionPhase = "disconnected";
    }

    const isDisconnected = primaryLabel === "Disconnected";
    const secondaryLabels = buildSecondaryLabels({
      agent,
      session,
      identityResolved,
      primaryLabel,
      isDisconnected,
    });
    const statusText = [primaryLabel, ...secondaryLabels].join(" · ");
    const detail = buildDetail({
      agent,
      session,
      primaryLabel,
      identityResolved,
      threadStatus,
    });
    const avatarEmoji = resolveAvatarEmoji({
      agent,
      session,
      identityResolved,
    });
    const tooltipText = detail ? `${statusText} — ${detail}` : statusText;
    const debugSignals = {
      sessionState,
      participantActivity,
      replyCaptureState: normalizeLower(session?.reply_capture_state),
      meetingPostState: normalizeLower(session?.meeting_post_state),
      automationState: normalizeLower(session?.automation_state),
      streamLabels: getRecentStreamEntries(session).map((entry) => mapStreamLabel(entry?.stream)).filter(Boolean),
      toolLabels: getRecentToolEntries(session).map((entry) => normalizeLower(entry?.tool_name)).filter(Boolean),
      evaluatedAt: now instanceof Date ? now.toISOString() : new Date().toISOString(),
    };

    return {
      avatarEmoji,
      identityResolved,
      connectionPhase,
      primaryLabel,
      secondaryLabels,
      tone,
      isDisconnected,
      isConnectedToBus: identityResolved,
      statusText,
      tooltipText,
      detail,
      debugSignals,
      stateEmoji: PRIMARY_STATE_EMOJI[primaryLabel] || "⚫",
    };
  }

  function getAgentState(agent, options = {}) {
    return deriveUnifiedStatus({ agent, ...options }).primaryLabel;
  }

  function getStateEmoji(state) {
    return PRIMARY_STATE_EMOJI[String(state || "").trim()] || "⚫";
  }

  function isStdioAgent(agent) {
    if (!agent) return false;
    if (typeof agent.is_sse_connected === "boolean") return !agent.is_sse_connected;
    return false;
  }

  function getOfflineTime(agent, options = {}) {
    const lastActivityTime = agent?.last_activity_time ? new Date(agent.last_activity_time) : null;
    if (!lastActivityTime || Number.isNaN(lastActivityTime.getTime())) return null;

    const now = options.now instanceof Date ? options.now : new Date();
    const secondsAgo = (now - lastActivityTime) / 1000;
    const state = deriveUnifiedStatus({ agent, ...options }).primaryLabel;
    if (state !== "Disconnected") return null;

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

  function isOfflineMoreThanHour(agent, options = {}) {
    const lastActivityTime = agent?.last_activity_time ? new Date(agent.last_activity_time) : null;
    const state = deriveUnifiedStatus({ agent, ...options }).primaryLabel;
    if (state !== "Disconnected") return false;
    if (!lastActivityTime || Number.isNaN(lastActivityTime.getTime())) return true;

    const now = options.now instanceof Date ? options.now : new Date();
    const secondsAgo = (now - lastActivityTime) / 1000;
    return secondsAgo >= 3600;
  }

  function getCompressedOfflineChar(offlineTimeStr) {
    if (!offlineTimeStr) return "∞";
    const match = String(offlineTimeStr).match(/([hdmony]+)/);
    if (match) {
      return match[1].substring(0, 1);
    }
    return "~";
  }

  function getTooltipText(agent, state, offlineDisplay, options = {}) {
    const unified = deriveUnifiedStatus({ agent, ...options });
    if (unified.primaryLabel === "Disconnected" && offlineDisplay) {
      return `${unified.tooltipText} — last seen ${offlineDisplay}`;
    }
    return unified.tooltipText || `${getStateEmoji(state)} ${String(state || "Unknown").trim()}`;
  }

  window.AcbAgentStatus = {
    deriveUnifiedStatus,
    hasBusConnectedParticipant,
    getAgentState,
    getStateEmoji,
    isStdioAgent,
    getOfflineTime,
    isOfflineMoreThanHour,
    getCompressedOfflineChar,
    getTooltipText,
  };
})();
