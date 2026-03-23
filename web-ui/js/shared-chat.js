(function () {
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
    document.getElementById("compose").classList.toggle("visible", status !== "closed" && status !== "archived");

    const box = document.getElementById("messages");
    box.innerHTML = "";
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

  function summarizeNames(values) {
    const names = Array.isArray(values) ? values.filter(Boolean) : [];
    if (!names.length) {
      return "";
    }
    if (names.length <= 2) {
      return names.join(", ");
    }
    return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
  }

  function updateHumanDeliveryStateForRow(row, threadId) {
    if (!row || row.getAttribute("data-is-human") !== "1") {
      return;
    }

    const seq = Number(row.getAttribute("data-seq") || 0);
    const deliveryMetaEl = row.querySelector(".msg-human-delivery");
    const summary = window.AcbCliSessions?.getDeliverySummaryForSeq?.(seq, threadId);
    if (!summary || !summary.participantCount) {
      if (deliveryMetaEl) {
        deliveryMetaEl.remove();
      }
      return;
    }

    const waitingLabel = summarizeNames(summary.waiting);
    const deliveredLabel = summarizeNames(summary.delivered);
    const chips = [];
    if (summary.waiting.length) {
      chips.push(
        `<span class="msg-human-delivery__chip msg-human-delivery__chip--waiting" title="Waiting for: ${waitingLabel}">Waiting for ${waitingLabel}</span>`,
      );
    }
    if (summary.delivered.length) {
      chips.push(
        `<span class="msg-human-delivery__chip msg-human-delivery__chip--delivered" title="Delivered to: ${deliveredLabel}">Delivered to ${deliveredLabel}</span>`,
      );
    }
    if (!chips.length) {
      if (deliveryMetaEl) {
        deliveryMetaEl.remove();
      }
      return;
    }

    let target = deliveryMetaEl;
    if (!target) {
      target = document.createElement("div");
      target.className = "msg-human-delivery";
      const msgCol = row.querySelector(".msg-col");
      const reactionsEl = row.querySelector(".msg-reactions");
      if (msgCol) {
        msgCol.insertBefore(target, reactionsEl || null);
      }
    }
    target.innerHTML = `
      <span class="msg-human-delivery__label">Agent delivery</span>
      ${chips.join("")}
    `;
  }

  function refreshHumanDeliveryIndicators(threadId) {
    const activeThreadId = threadId || (window.currentThreadId || null);
    document.querySelectorAll("#messages .msg-row[data-is-human='1']").forEach((row) => {
      updateHumanDeliveryStateForRow(row, activeThreadId);
    });
  }

  window.AcbChat = {
    refreshThreadAdmin,
    selectThread,
    loadNewMessages,
    sendMessage,
    handleKey,
    refreshHumanDeliveryIndicators,
  };
})();
