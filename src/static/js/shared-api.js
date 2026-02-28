(function () {
  async function api(path, opts) {
    const options = opts || {};
    try {
      const response = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
      return response.json();
    } catch {
      return null;
    }
  }

  async function inviteAgent(agentName, threadId) {
    return api("/api/agents/invite", {
      method: "POST",
      body: JSON.stringify({ agent_name: agentName, thread_id: threadId }),
    });
  }

  window.AcbApi = {
    api,
    inviteAgent,
  };
})();
