(function () {
  async function selectThread({
    id,
    topic,
    status,
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
    setLastSeq(0);
    clearThreadParticipants();

    document.querySelectorAll(".thread-item").forEach((el) => el.classList.remove("active"));
    const ti = document.getElementById(`ti-${id}`);
    if (ti) ti.classList.add("active");

    document.getElementById("thread-header").style.display = "flex";
    document.getElementById("thread-title").textContent = topic;
    document.getElementById("compose").classList.add("visible");

    const box = document.getElementById("messages");
    box.innerHTML = "";
    box.classList.add("loading-history");

    const msgs =
      (await api(`/api/threads/${id}/messages?after_seq=0&limit=300&include_system_prompt=1`)) ||
      [];
    rebuildActiveThreadParticipants(msgs);
    msgs.forEach(appendBubble);
    updateOnlinePresence();
    await updateStatusBar();
    if (msgs.length) setLastSeq(msgs[msgs.length - 1].seq);
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

    if (msgs.length) scrollBottom(true);
  }

  async function sendMessage({
    getActiveThreadId,
    updateOnlinePresence,
    autoResize,
    api,
    setLastSeq,
    appendBubble,
    scrollBottom,
  }) {
    const activeThreadId = getActiveThreadId();
    const input = document.getElementById("compose-input");
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

    if ((!content && images.length === 0) || !activeThreadId) return;

    console.log(`[SendMessage] Sending message with ${mentions.length} mentions and ${images.length} images`);

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
    console.log(`[SendMessage] Payload:`, JSON.stringify(payload));

    const m = await api(`/api/threads/${activeThreadId}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    console.log(`[SendMessage] Response:`, m);
    if (m && m.metadata) {
      console.log(`[SendMessage] Message metadata:`, m.metadata);
    }

    if (m) {
      setLastSeq((prev) => Math.max(prev, m.seq));
      appendBubble({ ...m, created_at: new Date().toISOString() });
      scrollBottom(true);
    }
  }

  function handleKey(e, sendMessageFn) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessageFn();
    }
  }

  window.AcbChat = {
    selectThread,
    loadNewMessages,
    sendMessage,
    handleKey,
  };
})();
