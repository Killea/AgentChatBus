(function () {
  const cliActivityConfig = {
    getActiveThreadId: null,
    scrollBottom: null,
    resolveActivityIdentity: null,
    hideTyping: null,
  };
  const cliActivityCards = new Map();
  const cliActivityPendingRows = new Map();
  const cliActivitySessionsByThread = new Map();

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getThreadActivityCache(threadId) {
    const key = String(threadId || "").trim();
    if (!key) {
      return null;
    }
    let bucket = cliActivitySessionsByThread.get(key);
    if (!bucket) {
      bucket = new Map();
      cliActivitySessionsByThread.set(key, bucket);
    }
    return bucket;
  }

  function setCliActivityConfig(config = {}) {
    Object.assign(cliActivityConfig, config || {});
  }

  function getNativeCard(sessionId) {
    const card = cliActivityCards.get(String(sessionId || ""));
    if (card && card.isConnected) {
      return card;
    }
    if (card) {
      cliActivityCards.delete(String(sessionId || ""));
    }
    return null;
  }

  function getPendingRow(sessionId) {
    const row = cliActivityPendingRows.get(String(sessionId || ""));
    if (row && row.isConnected) {
      return row;
    }
    if (row) {
      cliActivityPendingRows.delete(String(sessionId || ""));
    }
    return null;
  }

  function clearCliActivityRows(threadId = null, clearCache = true) {
    const normalizedThreadId = String(threadId || "").trim();
    for (const [sessionId, card] of cliActivityCards.entries()) {
      if (!card) continue;
      if (!normalizedThreadId || String(card.dataset.threadId || "") === normalizedThreadId) {
        card.remove();
        cliActivityCards.delete(sessionId);
      }
    }
    for (const [sessionId, row] of cliActivityPendingRows.entries()) {
      if (!row) continue;
      if (!normalizedThreadId || String(row.dataset.threadId || "") === normalizedThreadId) {
        row.remove();
        cliActivityPendingRows.delete(sessionId);
      }
    }
    if (!normalizedThreadId) {
      if (!clearCache) {
        return;
      }
      cliActivitySessionsByThread.clear();
      return;
    }
    if (clearCache) {
      cliActivitySessionsByThread.delete(normalizedThreadId);
    }
  }

  function clearCliActivityForAuthor(authorId) {
    const targetAuthorId = String(authorId || "").trim();
    if (!targetAuthorId) {
      return;
    }
    const activeThreadId = typeof cliActivityConfig.getActiveThreadId === "function"
      ? String(cliActivityConfig.getActiveThreadId() || "").trim()
      : "";
    const cache = getThreadActivityCache(activeThreadId);
    if (!cache) {
      return;
    }
    for (const session of cache.values()) {
      const sessionAuthorId = String(session?.participant_agent_id || session?.id || "").trim();
      if (sessionAuthorId !== targetAuthorId) {
        continue;
      }
      renderCliActivitySession(session, false);
    }
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(value || ""));
    }
    return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function formatActivityTime(value) {
    const stamp = String(value || "").trim();
    if (!stamp) {
      return "";
    }
    const parsed = new Date(stamp);
    if (Number.isNaN(parsed.getTime())) {
      return stamp;
    }
    return parsed.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function normalizeShellStatusText(session) {
    const card = session?.native_activity_card;
    if (card?.shell_status_text) {
      return String(card.shell_status_text).trim();
    }
    const state = String(session?.state || "").trim().toLowerCase();
    if (state === "failed") return "Failed";
    if (state === "stopped") return "Stopped";
    if (state === "completed") return "Completed";
    if (state === "starting" || state === "created") return "Starting Codex";
    if (session?.connected_at) return "Connected";
    return "Running";
  }

  function buildFallbackNativeCard(session) {
    const shellStatusText = normalizeShellStatusText(session);
    const shellStatus = String(session?.state || "").trim().toLowerCase();
    return {
      anchor_message_id: String(session?.last_posted_message_id || "").trim() || "",
      shell_status: (
        shellStatus === "failed"
          ? "failed"
          : shellStatus === "stopped"
            ? "stopped"
            : shellStatus === "completed"
              ? "completed"
              : session?.connected_at
                ? "connected"
                : shellStatus === "starting" || shellStatus === "created"
                  ? "starting"
                  : "running"
      ),
      shell_status_text: shellStatusText,
      updated_at: String(
        session?.updated_at
        || session?.last_output_at
        || session?.last_tool_call_at
        || session?.created_at
        || "",
      ),
      placeholder_visible: true,
      content_sections: [
        {
          kind: "placeholder",
          title: "Activity",
          summary: "No active Codex activity to display.",
          status: "placeholder",
          meta: shellStatusText,
        },
      ],
    };
  }

  function getNativeCardModel(session) {
    if (!session || !session.id) {
      return null;
    }
    const card = session.native_activity_card && typeof session.native_activity_card === "object"
      ? session.native_activity_card
      : buildFallbackNativeCard(session);
    const sections = Array.isArray(card.content_sections) ? card.content_sections : [];
    if (!sections.length) {
      return buildFallbackNativeCard(session);
    }
    return {
      ...card,
      shell_status_text: String(card.shell_status_text || normalizeShellStatusText(session)).trim(),
      updated_at: String(
        card.updated_at
        || session.updated_at
        || session.last_output_at
        || session.last_tool_call_at
        || session.created_at
        || "",
      ).trim(),
      content_sections: sections,
    };
  }

  function getNativeCardAction(session) {
    const runtime = session?.native_turn_runtime;
    const phase = String(runtime?.phase || "").trim();
    const flags = Array.isArray(runtime?.thread_active_flags) ? runtime.thread_active_flags : [];
    const active = phase === "starting" || phase === "running" || phase === "interrupting";
    const detail = flags.includes("waitingOnApproval")
      ? "Waiting on approval"
      : flags.includes("waitingOnUserInput")
        ? "Waiting on input"
        : phase === "interrupting"
          ? "Interrupting"
          : active
            ? "Running"
            : "Idle";
    return {
      label: active ? "Stop" : "Send",
      tone: active ? "stop" : "send",
      detail,
    };
  }

  function buildSectionItemsHtml(section) {
    const items = Array.isArray(section?.items) ? section.items : [];
    if (!items.length) {
      return "";
    }
    if (section.kind === "files") {
      return `
        <div class="msg-native-card__chips">
          ${items.map((item) => `
            <span class="msg-native-card__chip" data-kind="${escapeHtml(item.kind || "update")}">${escapeHtml(item.label || "")}</span>
          `).join("")}
        </div>
      `;
    }
    if (section.kind === "plan") {
      return `
        <div class="msg-native-card__plan">
          ${items.map((item) => `
            <div class="msg-native-card__plan-step" data-status="${escapeHtml(item.status || "")}">
              <span class="msg-native-card__plan-dot"></span>
              <span>${escapeHtml(item.label || "")}</span>
            </div>
          `).join("")}
        </div>
      `;
    }
    return `
      <div class="msg-native-card__items">
        ${items.map((item) => `
          <div class="msg-native-card__item">
            <span class="msg-native-card__item-label">${escapeHtml(item.label || "")}</span>
            ${item.value ? `<span class="msg-native-card__item-value">${escapeHtml(item.value)}</span>` : ""}
          </div>
        `).join("")}
      </div>
    `;
  }

  function buildSectionHtml(section) {
    if (!section || typeof section !== "object") {
      return "";
    }
    const summary = String(section.summary || "").trim();
    const meta = String(section.meta || "").trim();
    return `
      <section class="msg-native-card__section" data-kind="${escapeHtml(section.kind || "placeholder")}" data-status="${escapeHtml(section.status || "placeholder")}">
        <div class="msg-native-card__section-title">${escapeHtml(section.title || "Activity")}</div>
        <div class="msg-native-card__section-summary">${escapeHtml(summary || "No active Codex activity to display.")}</div>
        ${meta ? `<div class="msg-native-card__section-meta">${escapeHtml(meta)}</div>` : ""}
        ${section.kind === "diff" ? `<pre class="msg-native-card__diff">${escapeHtml(summary || "")}</pre>` : ""}
        ${buildSectionItemsHtml(section)}
      </section>
    `;
  }

  function buildNativeCardHtml(model, actionState) {
    return `
      <div class="msg-native-card__header">
        <span class="msg-native-card__status">${escapeHtml(model.shell_status_text || "Connected")}</span>
        <span class="msg-native-card__time">${escapeHtml(model.updated_at ? formatActivityTime(model.updated_at) : "")}</span>
      </div>
      <div class="msg-native-card__body">
        ${model.content_sections.map((section) => buildSectionHtml(section)).join("")}
      </div>
      <div class="msg-native-card__footer">
        <span class="msg-native-card__footer-note">${escapeHtml(actionState?.detail || "Idle")}</span>
        <button
          type="button"
          class="msg-native-card__action"
          data-tone="${escapeHtml(actionState?.tone || "send")}"
          disabled
          aria-disabled="true"
          tabindex="-1"
          title="Read-only status copied from Codex runtime"
        >${escapeHtml(actionState?.label || "Send")}</button>
      </div>
    `;
  }

  function resolveActivityIdentity(session) {
    return typeof cliActivityConfig.resolveActivityIdentity === "function"
      ? cliActivityConfig.resolveActivityIdentity(session) || {}
      : {};
  }

  function getLatestMessageRow(threadId, authorId, anchorMessageId) {
    const activeThreadId = typeof cliActivityConfig.getActiveThreadId === "function"
      ? String(cliActivityConfig.getActiveThreadId() || "").trim()
      : "";
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId || normalizedThreadId !== activeThreadId) {
      return null;
    }
    const anchorId = String(anchorMessageId || "").trim();
    if (anchorId) {
      const anchoredRow = document.querySelector(`#messages .msg-row[data-msg-id="${cssEscape(anchorId)}"]`);
      if (anchoredRow) {
        return anchoredRow;
      }
    }
    const normalizedAuthorId = String(authorId || "").trim();
    if (!normalizedAuthorId) {
      return null;
    }
    const rows = Array.from(document.querySelectorAll(`#messages .msg-row[data-seq][data-author-id="${cssEscape(normalizedAuthorId)}"]`));
    return rows.length ? rows[rows.length - 1] : null;
  }

  function ensurePendingRow(session, identity) {
    const existing = getPendingRow(session.id);
    if (existing) {
      return existing;
    }
    const box = document.getElementById("messages");
    if (!box) {
      return null;
    }
    const color = String(identity.color || "var(--accent)").trim() || "var(--accent)";
    const avatarEmoji = String(identity.avatarEmoji || "🤖").trim() || "🤖";
    const authorLabel = String(identity.authorLabel || session?.participant_display_name || "Agent").trim() || "Agent";
    const authorId = String(identity.authorId || session?.participant_agent_id || session?.id || "").trim();
    const row = document.createElement("div");
    row.className = "msg-row msg-row-left msg-row-cli-native-pending";
    row.dataset.threadId = String(session?.thread_id || "").trim();
    row.dataset.sessionId = String(session?.id || "").trim();
    row.dataset.authorId = authorId;
    row.innerHTML = `
      <div class="msg-avatar" style="background:${escapeHtml(color)}22;color:${escapeHtml(color)};border:1px solid ${escapeHtml(color)}44">${escapeHtml(avatarEmoji)}</div>
      <div class="msg-col">
        <div class="msg-header">
          <span class="msg-author-label" style="color:${escapeHtml(color)}">${escapeHtml(authorLabel)}</span>
          <span class="msg-time-label">connected</span>
        </div>
      </div>
    `;
    box.appendChild(row);
    cliActivityPendingRows.set(String(session.id), row);
    return row;
  }

  function resolveAnchorRow(session, identity, model) {
    const authorId = String(identity.authorId || session?.participant_agent_id || session?.id || "").trim();
    const messageRow = getLatestMessageRow(session?.thread_id, authorId, model?.anchor_message_id);
    if (messageRow) {
      const pendingRow = getPendingRow(session.id);
      if (pendingRow) {
        pendingRow.remove();
        cliActivityPendingRows.delete(String(session.id));
      }
      if (authorId && typeof cliActivityConfig.hideTyping === "function") {
        cliActivityConfig.hideTyping(authorId);
      }
      return messageRow;
    }
    const typingRow = authorId ? document.getElementById(`typing-${authorId}`) : null;
    if (typingRow) {
      return typingRow;
    }
    return ensurePendingRow(session, identity);
  }

  function attachCardToRow(row, cardEl) {
    if (!row || !cardEl) {
      return;
    }
    const col = row.querySelector(".msg-col");
    if (!col) {
      return;
    }
    const anchor = col.querySelector(".bubble-v2, .typing-bubble");
    if (cardEl.parentElement === col) {
      if (!anchor) {
        col.appendChild(cardEl);
      }
      return;
    }
    if (cardEl.parentElement) {
      cardEl.parentElement.removeChild(cardEl);
    }
    if (!anchor) {
      col.appendChild(cardEl);
      return;
    }
    const nextSibling = anchor.nextSibling;
    if (nextSibling) {
      col.insertBefore(cardEl, nextSibling);
    } else {
      col.appendChild(cardEl);
    }
  }

  function renderCliActivitySession(session, shouldAutoscroll = false) {
    const threadId = String(session?.thread_id || "").trim();
    const activeThreadId = typeof cliActivityConfig.getActiveThreadId === "function"
      ? String(cliActivityConfig.getActiveThreadId() || "").trim()
      : "";
    if (!threadId || !activeThreadId || threadId !== activeThreadId) {
      return;
    }

    const model = getNativeCardModel(session);
    if (!model) {
      return;
    }
    const actionState = getNativeCardAction(session);

    const identity = resolveActivityIdentity(session);
    const row = resolveAnchorRow(session, identity, model);
    if (!row) {
      return;
    }

    const cardEl = getNativeCard(session.id) || document.createElement("div");
    cardEl.className = "msg-native-card";
    cardEl.dataset.sessionId = String(session.id);
    cardEl.dataset.threadId = threadId;
    cardEl.dataset.authorId = String(identity.authorId || session?.participant_agent_id || session?.id || "").trim();
    cardEl.dataset.shellStatus = String(model.shell_status || "connected");
    cardEl.innerHTML = buildNativeCardHtml(model, actionState);
    attachCardToRow(row, cardEl);
    cliActivityCards.set(String(session.id), cardEl);

    if (shouldAutoscroll && typeof cliActivityConfig.scrollBottom === "function") {
      cliActivityConfig.scrollBottom(true);
    }
  }

  function syncThreadCliSessions(threadId, sessions) {
    const cache = getThreadActivityCache(threadId);
    if (!cache) {
      clearCliActivityRows();
      return;
    }
    cache.clear();
    (Array.isArray(sessions) ? sessions : []).forEach((session) => {
      if (session?.id) {
        cache.set(String(session.id), session);
      }
    });
    clearCliActivityRows(threadId, false);
    for (const session of cache.values()) {
      renderCliActivitySession(session, false);
    }
  }

  function handleCliSessionEvent(event) {
    const payload = event?.payload || {};
    const type = String(event?.type || "");
    if (!type.startsWith("cli.session.") || type === "cli.session.output") {
      return;
    }
    const session = payload?.session;
    if (!session || typeof session !== "object" || !session.id || !session.thread_id) {
      return;
    }
    const cache = getThreadActivityCache(session.thread_id);
    if (!cache) {
      return;
    }
    cache.set(String(session.id), session);
    renderCliActivitySession(session, type === "cli.session.activity" || type === "cli.session.native_card");
  }

  function refreshCliCardsForAuthor(authorId) {
    const targetAuthorId = String(authorId || "").trim();
    if (!targetAuthorId) {
      return;
    }
    const activeThreadId = typeof cliActivityConfig.getActiveThreadId === "function"
      ? String(cliActivityConfig.getActiveThreadId() || "").trim()
      : "";
    const cache = getThreadActivityCache(activeThreadId);
    if (!cache) {
      return;
    }
    for (const session of cache.values()) {
      const sessionAuthorId = String(session?.participant_agent_id || session?.id || "").trim();
      if (sessionAuthorId !== targetAuthorId) {
        continue;
      }
      renderCliActivitySession(session, false);
    }
  }

  function setActiveThreadAdminCache(admin) {
    try {
      window.__acbActiveThreadAdmin = admin && typeof admin === "object" ? { ...admin } : null;
    } catch {
      // Ignore cache write failures and keep UI functional.
    }
  }

  function setThreadAdminLabel(admin) {
    const adminEl = document.getElementById("thread-admin-label");
    if (!adminEl) return;
    const adminName = String(admin?.admin_name || "").trim();
    if (!adminName) {
      adminEl.hidden = true;
      adminEl.textContent = "";
      return;
    }
    const emoji = String(admin?.admin_emoji || "").trim() || "🤖";
    const adminType = String(admin?.admin_type || "").trim();
    const suffix = adminType === "creator"
      ? "creator admin"
      : (adminType === "auto_assigned" ? "meeting admin" : "admin");
    adminEl.hidden = false;
    adminEl.textContent = `Admin: ${emoji} ${adminName} (${suffix})`;
  }

  async function refreshThreadAdmin(threadId, api) {
    if (!threadId) {
      setActiveThreadAdminCache(null);
      setThreadAdminLabel(null);
      return null;
    }
    try {
      const admin = await api(`/api/threads/${threadId}/admin`);
      setActiveThreadAdminCache(admin);
      setThreadAdminLabel(admin);
      return admin;
    } catch {
      setActiveThreadAdminCache(null);
      setThreadAdminLabel(null);
      return null;
    }
  }

  async function selectThread({
    id,
    topic,
    status,
    initialSyncContext,
    setThreadSyncContext,
    setActiveThread,
    clearThreadParticipants,
    api,
    rebuildActiveThreadParticipants,
    appendBubble,
    updateOnlinePresence,
    updateStatusBar,
    setLastSeq,
    scrollBottom,
  }) {
    setActiveThread(id, status);
    window.currentThreadId = id;  // Set global currentThreadId for modals
    if (setThreadSyncContext) {
      setThreadSyncContext(id, initialSyncContext || null);
    }
    setLastSeq(0);
    clearThreadParticipants();

    document.querySelectorAll(".thread-item").forEach((el) => el.classList.remove("active"));
    const ti = document.getElementById(`ti-${id}`);
    if (ti) ti.classList.add("active");

    document.getElementById("thread-header").style.display = "flex";
    document.getElementById("thread-title").textContent = topic;
    document.getElementById("compose").classList.toggle("visible", status !== "archived");

    const box = document.getElementById("messages");
    box.innerHTML = "";
    clearCliActivityRows(id);
    const sysPromptAreaEl = document.getElementById("sys-prompt-area");
    if (sysPromptAreaEl) sysPromptAreaEl.innerHTML = "";
    box.classList.add("loading-history");

    const msgs =
      (await api(`/api/threads/${id}/messages?after_seq=0&limit=300&include_system_prompt=1`)) ||
      [];
    // DEBUG: Log first few messages to check author fields
    console.log('[DEBUG] Loaded messages:', msgs.slice(0, 3).map(m => ({
      seq: m.seq,
      author: m.author,
      author_name: m.author_name,
      author_id: m.author_id,
      role: m.role,
      content_preview: m.content?.slice(0, 50)
    })));
    rebuildActiveThreadParticipants(msgs);
    msgs.forEach(appendBubble);
    updateOnlinePresence();
    await updateStatusBar();
    await refreshThreadAdmin(id, api);
    if (msgs.length) setLastSeq(msgs[msgs.length - 1].seq);
    // Render any mermaid diagrams in loaded history
    if (window.AcbMessageRenderer?.renderMermaidBlocks) {
      await window.AcbMessageRenderer.renderMermaidBlocks(box);
    }
    scrollBottom(false);
    // Remove loading-history class to re-enable animations for new messages
    box.classList.remove("loading-history");
  }

  async function loadNewMessages({
    getActiveThreadId,
    getLastSeq,
    api,
    getAgentPresenceKey,
    getAgentDisplayName,
    recordThreadAgentActivity,
    appendBubble,
    updateOnlinePresence,
    updateStatusBar,
    setLastSeq,
    scrollBottom,
  }) {
    const activeThreadId = getActiveThreadId();
    if (!activeThreadId) return;

    const cursor = getLastSeq();
    const msgs =
      (await api(`/api/threads/${activeThreadId}/messages?after_seq=${cursor}&limit=100`)) || [];

    msgs.forEach((m) => {
      const key = getAgentPresenceKey(m);
      const label = getAgentDisplayName(m);
      if (key) recordThreadAgentActivity(key, label, m.created_at);
    });

    msgs.forEach(appendBubble);
    updateOnlinePresence();
    await updateStatusBar();

    msgs.forEach((m) => {
      setLastSeq((prev) => Math.max(prev, m.seq));
    });

    // Render any mermaid diagrams in new messages
    if (msgs.length && window.AcbMessageRenderer?.renderMermaidBlocks) {
      await window.AcbMessageRenderer.renderMermaidBlocks();
    }

    if (msgs.length) scrollBottom(true);
  }

  async function sendMessage({
    getActiveThreadId,
    getLastSeq,
    getThreadSyncContext,
    setThreadSyncContext,
    updateOnlinePresence,
    autoResize,
    api,
    setLastSeq,
    appendBubble,
    scrollBottom,
  }) {
    const activeThreadId = getActiveThreadId();
    const input = document.getElementById("compose-input");
    if (!input || !activeThreadId) return;
    const author = document.getElementById("compose-author").value.trim() || "human";
    const acb = document.querySelector('acb-compose-shell');

    // Extract content and mentions with full recursion for nested structures
    const mentions = [];
    const mentionLabels = {};
    function extractRichContent(root) {
      let text = '';
      for (const node of root.childNodes) {
        if (node.nodeType === 3) {
          text += node.textContent;
        } else if (node.nodeType === 1) {
          // If it's a mention pill
          if (node.hasAttribute('data-mention-id')) {
            const mid = node.getAttribute('data-mention-id');
            const mlabel = node.getAttribute('data-mention-label') || node.textContent.replace(/^@/, '');
            if (!mentions.includes(mid)) {
              mentions.push(mid);
              mentionLabels[mid] = mlabel;
            }
            text += node.textContent; // Include "@Nickname" in plain text
          } else {
            // Normal element (like a div from Enter or a br)
            const innerText = extractRichContent(node);
            text += innerText;
            if (node.tagName === 'DIV' || node.tagName === 'P' || node.tagName === 'BR') {
              if (text && !text.endsWith('\n')) text += '\n';
            }
          }
        }
      }
      return text;
    }

    const content = extractRichContent(input).trim();
    // Get uploaded images first so image-only messages can be sent.
    const images = acb?.uploadedImages || [];

    if (!content && images.length === 0) return;

    updateOnlinePresence();
    input.innerHTML = '';
    const messageBar = document.getElementById("mentions-bar");
    if (messageBar) messageBar.style.display = 'none';
    if (acb && acb.uploadedImages) acb.uploadedImages = [];
    if (acb && acb.renderImagePreview) acb.renderImagePreview();

    const payload = {
      author,
      role: "user",
      content,
      mentions: mentions.length > 0 ? mentions : undefined,
      metadata: mentions.length > 0 ? { mention_labels: mentionLabels } : undefined,
      images: images.length > 0 ? images : undefined
    };

    const loadFreshSyncContext = async () => {
      return await api(`/api/threads/${activeThreadId}/sync-context`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    };

    const isValidSyncContext = (sync) =>
      sync && typeof sync.current_seq === "number" && typeof sync.reply_token === "string" && sync.reply_token;

    const isValidMessageResponse = (message) =>
      message && typeof message.id === "string" && typeof message.seq === "number" && typeof message.content === "string";

    let sync = getThreadSyncContext ? getThreadSyncContext(activeThreadId) : null;
    const knownLastSeq = typeof getLastSeq === "function" ? Number(getLastSeq()) || 0 : 0;
    if (isValidSyncContext(sync) && Number(sync.current_seq) < knownLastSeq) {
      sync = null;
    }
    if (!isValidSyncContext(sync)) {
      sync = await loadFreshSyncContext();
    }
    if (!isValidSyncContext(sync)) {
      console.warn("[Chat] Unable to obtain sync context for human message.");
      return;
    }

    let response = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      payload.expected_last_seq = sync.current_seq;
      payload.reply_token = sync.reply_token;

      response = await api(`/api/threads/${activeThreadId}/messages`, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (isValidMessageResponse(response)) {
        break;
      }

      if (response?.error === "SEQ_MISMATCH" && attempt === 0) {
        sync = await loadFreshSyncContext();
        if (!isValidSyncContext(sync)) {
          console.warn("[Chat] Unable to refresh sync context after SEQ_MISMATCH.");
          return;
        }
        continue;
      }

      console.warn("[Chat] Message send failed:", response);
      return;
    }

    if (isValidMessageResponse(response)) {
      if (setThreadSyncContext) {
        setThreadSyncContext(activeThreadId, null);
      }
      setLastSeq((prev) => Math.max(prev, response.seq));
      appendBubble(response);
      scrollBottom(true);
    }
  }

  function handleKey(e, sendMessageFn) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessageFn();
    }
  }

  function refreshHumanDeliveryIndicators(threadId) {
    void threadId;
    document.querySelectorAll("#messages .msg-row[data-is-human='1']").forEach((row) => {
      const deliveryMetaEl = row.querySelector(".msg-human-delivery");
      if (deliveryMetaEl) {
        deliveryMetaEl.remove();
      }
    });
  }

  window.AcbChat = {
    configureCliActivity: setCliActivityConfig,
    handleCliSessionEvent,
    syncThreadCliSessions,
    clearCliActivityForAuthor,
    refreshCliCardsForAuthor,
    clearCliActivityRows,
    refreshThreadAdmin,
    selectThread,
    loadNewMessages,
    sendMessage,
    handleKey,
    refreshHumanDeliveryIndicators,
  };
})();
