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
    const content = input.value.trim();
    if (!content || !activeThreadId) return;

    updateOnlinePresence();
    input.value = "";
    autoResize(input);

    const m = await api(`/api/threads/${activeThreadId}/messages`, {
      method: "POST",
      body: JSON.stringify({ author, role: "user", content }),
    });

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
