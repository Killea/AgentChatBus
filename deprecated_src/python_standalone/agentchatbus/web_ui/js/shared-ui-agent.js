// UI-14: Auto-register a browser-session agent so the UI can create threads.
// Session credentials are in sessionStorage; user-chosen identity lives in localStorage.
(function () {
  const SESSION_KEY = "acb-ui-agent";
  const IDENTITY_KEY = "acb-ui-identity";

  function _loadIdentity() {
    try {
      const raw = localStorage.getItem(IDENTITY_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) { /* ignore */ }
    return { display_name: "Browser User", emoji: "" };
  }

  function _saveIdentity(identity) {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  }

  async function ensureUiAgent() {
    const identity = _loadIdentity();
    const cached = sessionStorage.getItem(SESSION_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed.agent_id && parsed.token) return parsed;
      } catch (_) {
        // corrupted -- fall through to re-register
      }
    }

    try {
      const body = {
        name: "ui-human",
        display_name: identity.display_name || "Browser User",
        ide: "browser",
        model: "human",
      };
      if (identity.emoji) body.emoji = identity.emoji;

      const res = await fetch("/api/agents/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

  async function updateUiAgentIdentity(displayName, emoji) {
    const prev = _loadIdentity();
    const next = {
      display_name: (displayName || "").trim() || "Browser User",
      emoji: (emoji || "").trim(),
    };
    _saveIdentity(next);

    const cached = sessionStorage.getItem(SESSION_KEY);
    if (!cached) return { ok: false, reason: "no_session" };

    let parsed;
    try { parsed = JSON.parse(cached); } catch (_) { return { ok: false, reason: "corrupted_session" }; }
    if (!parsed.agent_id || !parsed.token) return { ok: false, reason: "missing_credentials" };

    try {
      const body = { token: parsed.token, display_name: next.display_name };
      if (next.emoji) body.emoji = next.emoji;

      const res = await fetch(`/api/agents/${parsed.agent_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { ok: false, reason: "api_error", status: res.status };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: "network_error", message: err.message };
    }
  }

  function getUiIdentity() {
    return _loadIdentity();
  }

  window.AcbUiAgent = { ensureUiAgent, updateUiAgentIdentity, getUiIdentity };
})();
