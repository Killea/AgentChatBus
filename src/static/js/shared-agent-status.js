(function () {
  function getAgentState(agent) {
    const activityTime = agent.last_activity_time ? new Date(agent.last_activity_time) : null;
    const now = new Date();

    if (!activityTime) {
      return agent.is_online ? "Waiting" : "Offline";
    }

    const secondsAgo = (now - activityTime) / 1000;
    if (agent.last_activity === "msg_wait" && secondsAgo < 60) return "Waiting";
    if (secondsAgo < 30) return "Active";
    if (secondsAgo < 300) return "Idle";
    return agent.is_online ? "Idle" : "Offline";
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
    if (!offlineTimeStr) return "?";
    const match = offlineTimeStr.match(/([hdmony]+)/);
    if (match) {
      return match[1].substring(0, 1);
    }
    return "?";
  }

  function getStateEmoji(state) {
    const map = { Offline: "⚫", Waiting: "⏳", Active: "🟢", Idle: "🌙" };
    return map[state] || "❓";
  }

  window.AcbAgentStatus = {
    getAgentState,
    getOfflineTime,
    isOfflineMoreThanHour,
    getCompressedOfflineChar,
    getStateEmoji,
  };
})();
