// UI-14: Auto-register a browser-session agent so the UI can create threads.
// Token is stored in sessionStorage (cleared on tab close).
(function () {
  const SESSION_KEY = "acb-ui-agent";

  async function ensureUiAgent() {
    const cached = sessionStorage.getItem(SESSION_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed.agent_id && parsed.token) return parsed;
      } catch (_) {
        // corrupted — fall through to re-register
      }
    }

    try {
      const res = await fetch("/api/agents/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "ui-human",
          display_name: "Browser User",
          ide: "browser",
          model: "human",
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.agent_id || !data.token) return null;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ agent_id: data.agent_id, token: data.token }));
      return { agent_id: data.agent_id, token: data.token };
    } catch (_) {
      return null;
    }
  }

  window.AcbUiAgent = { ensureUiAgent };
})();
