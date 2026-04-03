(function () {
  const bridgeState = {
    baseUrl: "",
    threadId: "",
    currentSeq: 0,
    eventSource: null,
    extensionState: {},
    started: false,
    uiAgentAuth: null,
  };
  const UI_AGENT_SESSION_KEY = "acb-ui-agent";

  function readConfig() {
    const root = document.body;
    const baseUrlRaw = String(root?.dataset.baseUrl || "").trim();
    const baseUrl = baseUrlRaw.replace(/\/+$/, "") || `${window.location.protocol}//${window.location.host}`;
    const threadId = String(root?.dataset.threadId || "").trim();
    return { baseUrl, threadId };
  }

  function hostToWebview(message) {
    window.postMessage(message, "*");
  }

  async function requestJson(url, init) {
    const response = await fetch(url, init);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status} ${text}`);
    }
    return response.json();
  }

  async function ensureUiAgentAuth() {
    if (bridgeState.uiAgentAuth?.agent_id && bridgeState.uiAgentAuth?.token) {
      return bridgeState.uiAgentAuth;
    }

    const cached = sessionStorage.getItem(UI_AGENT_SESSION_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed?.agent_id && parsed?.token) {
          bridgeState.uiAgentAuth = {
            agent_id: String(parsed.agent_id),
            token: String(parsed.token),
          };
          return bridgeState.uiAgentAuth;
        }
      } catch {
        // Ignore corrupted cache and re-register.
      }
    }

    const response = await fetch(`${bridgeState.baseUrl}/api/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "ui-human",
        display_name: "Browser User",
        ide: "browser",
        model: "human",
      }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} registering UI agent`);
    }
    const payload = await response.json();
    if (!payload?.agent_id || !payload?.token) {
      throw new Error("Invalid UI agent registration payload");
    }
    bridgeState.uiAgentAuth = {
      agent_id: String(payload.agent_id),
      token: String(payload.token),
    };
    sessionStorage.setItem(UI_AGENT_SESSION_KEY, JSON.stringify(bridgeState.uiAgentAuth));
    return bridgeState.uiAgentAuth;
  }

  async function resolveThread() {
    if (bridgeState.threadId) {
      return bridgeState.threadId;
    }

    const payload = await requestJson(`${bridgeState.baseUrl}/api/threads?include_archived=false`);
    const threads = Array.isArray(payload) ? payload : (payload.threads || []);
    const first = threads[0];
    if (!first || !first.id) {
      throw new Error("No thread found. Create a thread in the main web UI first.");
    }
    bridgeState.threadId = String(first.id);
    document.body.dataset.threadId = bridgeState.threadId;
    document.body.dataset.threadTopic = String(first.topic || bridgeState.threadId.slice(0, 8));
    document.body.dataset.threadStatus = String(first.status || "discuss");
    return bridgeState.threadId;
  }

  function parseMessagesEnvelope(envelope) {
    const messages = Array.isArray(envelope) ? envelope : (envelope.messages || []);
    const sorted = messages.slice().sort((a, b) => {
      const leftIndex = Number.isFinite(Number(a?.transcript_index)) ? Number(a.transcript_index) : null;
      const rightIndex = Number.isFinite(Number(b?.transcript_index)) ? Number(b.transcript_index) : null;
      if (leftIndex !== null || rightIndex !== null) {
        return (leftIndex ?? Number(a?.seq || 0)) - (rightIndex ?? Number(b?.seq || 0));
      }
      return Number(a?.seq || 0) - Number(b?.seq || 0);
    });
    bridgeState.currentSeq = sorted.reduce((maxSeq, message) => {
      const seq = Number(message?.seq || 0);
      return Number.isFinite(seq) ? Math.max(maxSeq, seq) : maxSeq;
    }, 0);
    return sorted;
  }

  async function loadInitialMessages() {
    const threadId = await resolveThread();
    const envelope = await requestJson(
      `${bridgeState.baseUrl}/api/threads/${encodeURIComponent(threadId)}/transcript?include_system_prompt=1`
    );
    const messages = parseMessagesEnvelope(envelope);
    hostToWebview({ command: "loadMessages", messages });
  }

  async function loadNewMessages() {
    const threadId = await resolveThread();
    const envelope = await requestJson(
      `${bridgeState.baseUrl}/api/threads/${encodeURIComponent(threadId)}/messages?after_seq=${bridgeState.currentSeq}`
    );
    const messages = parseMessagesEnvelope(envelope).filter(
      (message) => Number(message.seq || 0) > bridgeState.currentSeq
    );
    if (messages.length === 0) {
      return;
    }
    bridgeState.currentSeq = Number(messages[messages.length - 1].seq || bridgeState.currentSeq);
    hostToWebview({ command: "appendMessages", messages });
  }

  async function getSyncContext(threadId) {
    return requestJson(`${bridgeState.baseUrl}/api/threads/${encodeURIComponent(threadId)}/sync-context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  }

  async function sendMessage(payload) {
    const threadId = await resolveThread();
    let sync = await getSyncContext(threadId);
    const body = {
      author: payload?.author || "human",
      content: payload?.content || "",
      mentions: payload?.mentions,
      metadata: payload?.metadata,
      images: payload?.images,
      reply_to_msg_id: payload?.reply_to_msg_id,
      expected_last_seq: sync.current_seq,
      reply_token: sync.reply_token,
    };

    let response = await fetch(
      `${bridgeState.baseUrl}/api/threads/${encodeURIComponent(threadId)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const raw = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }

      const shouldRetry =
        response.status === 400 &&
        parsed &&
        parsed.detail &&
        parsed.detail.action === "CALL_SYNC_CONTEXT_THEN_RETRY";
      if (!shouldRetry) {
        throw new Error(`Failed to send message: HTTP ${response.status} ${raw}`);
      }

      sync = await getSyncContext(threadId);
      body.expected_last_seq = sync.current_seq;
      body.reply_token = sync.reply_token;
      response = await fetch(
        `${bridgeState.baseUrl}/api/threads/${encodeURIComponent(threadId)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (!response.ok) {
        const retryRaw = await response.text();
        throw new Error(`Failed to send message: HTTP ${response.status} ${retryRaw}`);
      }
    }

    const message = await response.json();
    bridgeState.currentSeq = Math.max(bridgeState.currentSeq, Number(message?.seq || 0));
    hostToWebview({ command: "newMessage", message });
    hostToWebview({ command: "sendResult", ok: true });
  }

  async function uploadImage(requestId, payload) {
    const fileName = typeof payload?.name === "string" ? payload.name : "image";
    const mimeType = typeof payload?.type === "string" ? payload.type : "application/octet-stream";
    const data = Array.isArray(payload?.data) ? Uint8Array.from(payload.data) : null;
    if (!data || data.length === 0) {
      throw new Error("Image payload is empty.");
    }

    const blob = new Blob([data.buffer], { type: mimeType });
    const formData = new FormData();
    formData.append("file", blob, fileName);
    const response = await fetch(`${bridgeState.baseUrl}/api/upload/image`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status} uploading image: ${text}`);
    }
    const image = await response.json();
    hostToWebview({ command: "uploadResult", requestId, ok: true, image });
  }

  async function loadAgents(requestId) {
    const threadId = await resolveThread();
    const payload = await requestJson(
      `${bridgeState.baseUrl}/api/threads/${encodeURIComponent(threadId)}/agents`
    );
    const agents = Array.isArray(payload) ? payload : (payload.agents || []);
    hostToWebview({ command: "agentsResult", requestId, ok: true, agents });
  }

  async function createThread(topicRaw) {
    const topic = String(topicRaw || "").trim() || `New Thread ${new Date().toLocaleString()}`;
    const auth = await ensureUiAgentAuth();
    const response = await fetch(`${bridgeState.baseUrl}/api/threads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Token": auth.token,
      },
      body: JSON.stringify({
        topic,
        creator_agent_id: auth.agent_id,
      }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} creating thread: ${await response.text()}`);
    }
    const thread = await response.json();
    const next = new URL(window.location.href);
    next.searchParams.set("threadId", String(thread.id));
    next.searchParams.set("threadTopic", String(thread.topic || topic));
    next.searchParams.set("threadStatus", String(thread.status || "discuss"));
    window.location.assign(next.toString());
  }

  async function getServerIndicators(requestId) {
    const metrics = await requestJson(`${bridgeState.baseUrl}/api/metrics`);
    hostToWebview({
      command: "serverIndicatorsResult",
      requestId,
      ok: true,
      connected: true,
      engine: String(metrics?.engine || "node"),
    });
  }

  function wireEventStream() {
    if (bridgeState.eventSource) {
      bridgeState.eventSource.close();
      bridgeState.eventSource = null;
    }
    bridgeState.eventSource = new EventSource(`${bridgeState.baseUrl}/events`);
    bridgeState.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data?.type === "msg.new" && data?.payload?.thread_id === bridgeState.threadId) {
          void loadNewMessages();
        }
        if (data?.type === "thread.transcript.updated" && data?.payload?.thread_id === bridgeState.threadId) {
          void loadInitialMessages();
        }
      } catch {
        // Ignore malformed events in browser bridge mode.
      }
    };
  }

  function createVsCodeApi() {
    return {
      postMessage(message) {
        const command = message?.command;
        if (command === "sendMessage") {
          void sendMessage(message.payload).catch((error) => {
            hostToWebview({ command: "sendResult", ok: false, error: String(error?.message || error) });
          });
          return;
        }
        if (command === "uploadImage") {
          void uploadImage(message.requestId, message.payload).catch((error) => {
            hostToWebview({
              command: "uploadResult",
              requestId: message.requestId,
              ok: false,
              error: String(error?.message || error),
            });
          });
          return;
        }
        if (command === "loadAgents") {
          void loadAgents(message.requestId).catch((error) => {
            hostToWebview({
              command: "agentsResult",
              requestId: message.requestId,
              ok: false,
              error: String(error?.message || error),
            });
          });
          return;
        }
        if (command === "createThread") {
          void createThread(message.topic).catch((error) => {
            hostToWebview({
              command: "createThreadResult",
              ok: false,
              error: String(error?.message || error),
            });
          });
          return;
        }
        if (command === "getServerIndicators") {
          void getServerIndicators(message.requestId).catch((error) => {
            hostToWebview({
              command: "serverIndicatorsResult",
              requestId: message.requestId,
              ok: false,
              connected: false,
              error: String(error?.message || error),
            });
          });
        }
      },
      setState(value) {
        bridgeState.extensionState = value || {};
      },
      getState() {
        return bridgeState.extensionState;
      },
    };
  }

  async function startBridge() {
    if (bridgeState.started) {
      return;
    }
    bridgeState.started = true;

    const config = readConfig();
    bridgeState.baseUrl = config.baseUrl;
    bridgeState.threadId = config.threadId;

    await resolveThread();
    await loadInitialMessages();
    wireEventStream();
  }

  const api = createVsCodeApi();
  window.acquireVsCodeApi = function acquireVsCodeApi() {
    return api;
  };
  window.__ACB_EXTENSION_BROWSER_BRIDGE__ = {
    startBridge,
    loadInitialMessages,
    loadNewMessages,
  };

  window.addEventListener("load", () => {
    void startBridge().catch((error) => {
      hostToWebview({
        command: "sendResult",
        ok: false,
        error: `Browser bridge failed: ${String(error?.message || error)}`,
      });
    });
  });
})();
