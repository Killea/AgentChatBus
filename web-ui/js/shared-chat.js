(function () {
  const cliActivityConfig = {
    getActiveThreadId: null,
    scrollBottom: null,
    resolveActivityIdentity: null,
    hideTyping: null,
  };
  const cliActivityRows = new Map();
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

  function getActivityRow(sessionId) {
    const row = cliActivityRows.get(String(sessionId || ""));
    if (row && row.isConnected) {
      return row;
    }
    if (row) {
      cliActivityRows.delete(String(sessionId || ""));
    }
    return null;
  }

  function clearCliActivityRows(threadId = null) {
    const normalizedThreadId = String(threadId || "").trim();
    for (const [sessionId, row] of cliActivityRows.entries()) {
      if (!row) continue;
      if (!normalizedThreadId || String(row.dataset.threadId || "") === normalizedThreadId) {
        row.remove();
        cliActivityRows.delete(sessionId);
      }
    }
    if (!normalizedThreadId) {
      cliActivitySessionsByThread.clear();
      return;
    }
    cliActivitySessionsByThread.delete(normalizedThreadId);
  }

  function clearCliActivityForAuthor(authorId) {
    const targetAuthorId = String(authorId || "").trim();
    if (!targetAuthorId) {
      return;
    }
    for (const [sessionId, row] of cliActivityRows.entries()) {
      if (String(row?.dataset.authorId || "") !== targetAuthorId) {
        continue;
      }
      row?.remove();
      cliActivityRows.delete(sessionId);
    }
  }

  function isCliSessionBusy(session) {
    const interactive = String(session?.interactive_work_state || "").trim().toLowerCase();
    const replyCapture = String(session?.reply_capture_state || "").trim().toLowerCase();
    const automation = String(session?.automation_state || "").trim().toLowerCase();
    return interactive === "busy"
      || replyCapture === "waiting_for_reply"
      || replyCapture === "working"
      || replyCapture === "streaming"
      || automation.includes("delivery_prompt")
      || automation.includes("wake_prompt")
      || automation.includes("working");
  }

  function pickLatestActivity(events, predicate) {
    const matching = events.filter((entry) => predicate(entry));
    return matching.length ? matching[matching.length - 1] : null;
  }

  function parseActivityTime(value) {
    const stamp = String(value || "").trim();
    if (!stamp) {
      return 0;
    }
    const millis = Date.parse(stamp);
    return Number.isFinite(millis) ? millis : 0;
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

  function getSessionAuthorId(session) {
    return String(session?.participant_agent_id || session?.id || "").trim();
  }

  function getLatestVisibleThreadMessage(threadId) {
    const normalizedThreadId = String(threadId || "").trim();
    const activeThreadId = typeof cliActivityConfig.getActiveThreadId === "function"
      ? String(cliActivityConfig.getActiveThreadId() || "").trim()
      : "";
    if (!normalizedThreadId || !activeThreadId || normalizedThreadId !== activeThreadId) {
      return null;
    }
    const rows = Array.from(document.querySelectorAll("#messages .msg-row[data-seq]"));
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (!row || row.classList.contains("msg-row-cli-activity")) {
        continue;
      }
      const authorId = String(row.getAttribute("data-author-id") || "").trim();
      const authorLabel = String(row.querySelector(".msg-author-label")?.textContent || "").trim();
      return {
        authorId,
        authorLabel,
        isHuman: row.getAttribute("data-is-human") === "1",
      };
    }
    return null;
  }

  function deriveWaitSection(session, waitMarkerAt) {
    const latestToolEvents = Array.isArray(session?.recent_tool_events) ? session.recent_tool_events : [];
    const lastToolEvent = latestToolEvents.length ? latestToolEvents[latestToolEvents.length - 1] : null;
    const lastToolName = String(lastToolEvent?.tool_name || "").trim().toLowerCase();
    const state = String(session?.state || "").trim().toLowerCase();
    if (lastToolName !== "msg_wait" || (state !== "running" && state !== "starting")) {
      return null;
    }

    const latestMessage = getLatestVisibleThreadMessage(session?.thread_id);
    const sessionAuthorId = getSessionAuthorId(session);
    let summary = "Connected and waiting for the next visible message";
    if (latestMessage?.isHuman) {
      summary = `Waiting for ${latestMessage.authorLabel || "the human"} to reply`;
    } else if (latestMessage?.authorId && latestMessage.authorId === sessionAuthorId) {
      summary = "Waiting for a reply in the thread";
    }

    const afterSeqCandidates = [
      Number(session?.last_posted_seq),
      Number(session?.last_acknowledged_seq),
      Number(session?.last_delivered_seq),
    ].filter((value) => Number.isFinite(value) && value > 0);
    const afterSeq = afterSeqCandidates.length ? afterSeqCandidates[0] : null;
    const metaParts = ["msg_wait"];
    if (afterSeq !== null) {
      metaParts.push(`after seq ${afterSeq}`);
    }
    if (waitMarkerAt) {
      metaParts.push(`live since ${formatActivityTime(waitMarkerAt)}`);
    }

    return {
      key: "waiting",
      title: "Waiting",
      summary,
      meta: metaParts.join(" · "),
      tone: "waiting",
    };
  }

  function deriveCliActivityModel(session) {
    if (!session || !session.id) {
      return null;
    }
    const state = String(session.state || "").trim().toLowerCase();
    const latestByItem = new Map();
    const events = Array.isArray(session.recent_activity_events) ? session.recent_activity_events : [];
    events.forEach((entry) => {
      if (entry?.item_id) {
        latestByItem.set(String(entry.item_id), entry);
      }
    });
    const activeEvents = Array.from(latestByItem.values()).filter((entry) => entry?.status === "in_progress");
    const latestToolEvents = Array.isArray(session?.recent_tool_events) ? session.recent_tool_events : [];
    const lastToolEvent = latestToolEvents.length ? latestToolEvents[latestToolEvents.length - 1] : null;
    const lastToolName = String(lastToolEvent?.tool_name || "").trim().toLowerCase();
    const activeWaitEvent = pickLatestActivity(
      activeEvents,
      (entry) => (
        entry?.kind === "mcp_tool_call"
        || entry?.kind === "dynamic_tool_call"
      ) && String(entry?.tool || "").trim().toLowerCase() === "msg_wait",
    );
    const waitMarkerAt = parseActivityTime(activeWaitEvent?.at) || (
      lastToolName === "msg_wait" ? parseActivityTime(session?.last_tool_call_at || lastToolEvent?.at) : 0
    );
    const isStaleBeforeWait = (entry) => {
      if (!entry || !waitMarkerAt) {
        return false;
      }
      return parseActivityTime(entry.at) < waitMarkerAt;
    };
    const planEvent = pickLatestActivity(
      activeEvents,
      (entry) => entry?.kind === "plan" && !isStaleBeforeWait(entry),
    );
    const thinkingEvent = pickLatestActivity(
      activeEvents,
      (entry) => entry?.kind === "thinking" && !isStaleBeforeWait(entry),
    );
    const toolEvent = pickLatestActivity(
      activeEvents,
      (entry) => (
        entry?.kind === "mcp_tool_call" || entry?.kind === "dynamic_tool_call"
      ) && String(entry?.tool || "").trim().toLowerCase() !== "msg_wait" && !isStaleBeforeWait(entry),
    );
    const commandEvent = pickLatestActivity(
      activeEvents,
      (entry) => entry?.kind === "command_execution" && !isStaleBeforeWait(entry),
    );
    const fileEvent = pickLatestActivity(
      activeEvents,
      (entry) => entry?.kind === "file_change" && !isStaleBeforeWait(entry),
    );
    const sections = [];

    if (thinkingEvent || planEvent || (isCliSessionBusy(session) && !waitMarkerAt)) {
      const lines = [];
      if (thinkingEvent?.summary) {
        lines.push(thinkingEvent.summary);
      } else if (planEvent?.summary) {
        lines.push(planEvent.summary);
      } else {
        lines.push("Working through the next response");
      }
      sections.push({
        key: "thinking",
        title: "Thinking",
        summary: lines[0],
        planSteps: Array.isArray(planEvent?.plan_steps) ? planEvent.plan_steps : [],
      });
    }

    if (toolEvent) {
      const detailParts = [];
      if (toolEvent.server) detailParts.push(toolEvent.server);
      if (toolEvent.tool) detailParts.push(toolEvent.tool);
      sections.push({
        key: "tool",
        title: "Using tool",
        summary: toolEvent.summary || detailParts.join(" / ") || "Calling a tool",
        meta: detailParts.join(" / "),
      });
    }

    if (commandEvent) {
      sections.push({
        key: "command",
        title: "Running command",
        summary: commandEvent.summary || commandEvent.command || "Running a command",
        meta: [commandEvent.command, commandEvent.cwd].filter(Boolean).join(" @ "),
      });
    }

    if (fileEvent) {
      sections.push({
        key: "files",
        title: "Editing files",
        summary: fileEvent.summary || "Updating files",
        files: Array.isArray(fileEvent.files) ? fileEvent.files : [],
        diff: fileEvent.diff || "",
      });
    }

    const waitSection = deriveWaitSection(session, waitMarkerAt ? new Date(waitMarkerAt).toISOString() : "");
    if (waitSection && !toolEvent && !commandEvent && !fileEvent) {
      sections.push(waitSection);
    }

    if (!sections.length) {
      if (state === "running" || state === "starting") {
        return null;
      }
      return null;
    }

    return {
      updatedAt: formatActivityTime(
        session.last_tool_call_at || session.updated_at || session.last_output_at || session.created_at || "",
      ),
      sections,
    };
  }

  function buildPlanStepsHtml(steps) {
    if (!Array.isArray(steps) || !steps.length) {
      return "";
    }
    return `
      <div class="msg-cli-activity__plan">
        ${steps.slice(0, 4).map((step) => `
          <div class="msg-cli-activity__plan-step" data-status="${escapeHtml(step.status)}">
            <span class="msg-cli-activity__plan-dot"></span>
            <span>${escapeHtml(step.step)}</span>
          </div>
        `).join("")}
      </div>
    `;
  }

  function buildFileChipsHtml(files) {
    if (!Array.isArray(files) || !files.length) {
      return "";
    }
    return `
      <div class="msg-cli-activity__chips">
        ${files.slice(0, 6).map((file) => {
          const status = String(file?.change_type || "update").trim() || "update";
          return `<span class="msg-cli-activity__chip" data-kind="${escapeHtml(status)}">${escapeHtml(file.path)}</span>`;
        }).join("")}
      </div>
    `;
  }

  function buildCliActivityBubbleHtml(model) {
    return `
      <div class="msg-cli-activity__bubble">
        ${model.sections.map((section) => `
          <section class="msg-cli-activity__section" data-section="${escapeHtml(section.key)}" ${section.tone ? `data-tone="${escapeHtml(section.tone)}"` : ""}>
            <div class="msg-cli-activity__title">${escapeHtml(section.title)}</div>
            <div class="msg-cli-activity__summary">${escapeHtml(section.summary || "")}</div>
            ${section.meta ? `<div class="msg-cli-activity__meta">${escapeHtml(section.meta)}</div>` : ""}
            ${buildPlanStepsHtml(section.planSteps)}
            ${buildFileChipsHtml(section.files)}
            ${section.diff ? `<pre class="msg-cli-activity__diff">${escapeHtml(section.diff)}</pre>` : ""}
          </section>
        `).join("")}
      </div>
    `;
  }

  function renderCliActivitySession(session, shouldAutoscroll = false) {
    const threadId = String(session?.thread_id || "").trim();
    const activeThreadId = typeof cliActivityConfig.getActiveThreadId === "function"
      ? String(cliActivityConfig.getActiveThreadId() || "").trim()
      : "";
    if (!threadId || !activeThreadId || threadId !== activeThreadId) {
      return;
    }

    const model = deriveCliActivityModel(session);
    const existingRow = getActivityRow(session.id);
    if (!model) {
      if (existingRow) {
        existingRow.remove();
        cliActivityRows.delete(String(session.id));
      }
      return;
    }

    const identity = typeof cliActivityConfig.resolveActivityIdentity === "function"
      ? cliActivityConfig.resolveActivityIdentity(session) || {}
      : {};
    const authorId = String(identity.authorId || session.participant_agent_id || session.id || "").trim();
    if (authorId && typeof cliActivityConfig.hideTyping === "function") {
      cliActivityConfig.hideTyping(authorId);
    }
    const authorLabel = String(identity.authorLabel || session.participant_display_name || "Agent").trim();
    const avatarEmoji = String(identity.avatarEmoji || "🤖").trim() || "🤖";
    const color = String(identity.color || "var(--accent)").trim() || "var(--accent)";

    const row = existingRow || document.createElement("div");
    row.className = "msg-row msg-row-left msg-row-cli-activity";
    row.dataset.sessionId = String(session.id);
    row.dataset.threadId = threadId;
    row.dataset.authorId = authorId;
    row.innerHTML = `
      <div class="msg-avatar" style="background:${escapeHtml(color)}22;color:${escapeHtml(color)};border:1px solid ${escapeHtml(color)}44">${escapeHtml(avatarEmoji)}</div>
      <div class="msg-col">
        <div class="msg-header">
          <span class="msg-author-label" style="color:${escapeHtml(color)}">${escapeHtml(authorLabel)}</span>
          <span class="msg-time-label">${escapeHtml(model.updatedAt ? `working · ${model.updatedAt}` : "working")}</span>
        </div>
        ${buildCliActivityBubbleHtml(model)}
      </div>
    `;

    if (!existingRow) {
      const box = document.getElementById("messages");
      if (!box) return;
      box.appendChild(row);
      cliActivityRows.set(String(session.id), row);
    }

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
    clearCliActivityRows(threadId);
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
    renderCliActivitySession(session, type === "cli.session.activity");
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
    clearCliActivityRows,
    refreshThreadAdmin,
    selectThread,
    loadNewMessages,
    sendMessage,
    handleKey,
    refreshHumanDeliveryIndicators,
  };
})();
