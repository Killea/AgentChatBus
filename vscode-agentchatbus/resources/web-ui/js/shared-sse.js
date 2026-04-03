(function () {
  let _isConnected = false;

  function setConnectedUI(connected) {
    _isConnected = connected;
    const dot = document.getElementById("status-dot");
    const label = document.getElementById("status-label");
    if (!dot || !label) return;

    dot.style.background = connected ? "var(--green)" : "var(--red)";
    dot.style.boxShadow = connected ? "0 0 8px var(--green)" : "0 0 8px var(--red)";
    label.textContent = connected ? "Connected" : "Reconnecting…";
  }

  function startSSE(deps) {
    const {
      getActiveThreadId,
      onMsgNew,
      onTranscriptUpdate,
      onMsgEdit,
      onThreadEvent,
      onAgentPresence,
      onCliSessionEvent,
      onTyping,
      setConnected,
    } = deps;

    const es = new EventSource("/events");
    es.onopen = () => { _isConnected = true; setConnected(true); };
    es.onerror = () => {
      _isConnected = false;
      setConnected(false);
      setTimeout(() => startSSE(deps), 3000);
      es.close();
    };

    es.onmessage = async (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch (err) {
        console.warn('[SSE] Failed to parse event data:', e.data, err);
        return;
      }
      const p = ev.payload || {};
      const activeThreadId = getActiveThreadId();

      if (ev.type === "msg.new") {
        if (p.thread_id === activeThreadId && onMsgNew) {
          await onMsgNew();
        }
        if (onThreadEvent) {
          await onThreadEvent();
        }
      }

      if (ev.type === "thread.transcript.updated") {
        if (p.thread_id === activeThreadId && onTranscriptUpdate) {
          await onTranscriptUpdate();
        }
      }

      if (ev.type === "msg.edit") {
        if (p.thread_id === activeThreadId && onMsgEdit) {
          await onMsgEdit(p);
        }
      }

      if (
        ev.type === "thread.new" ||
        ev.type === "thread.state" ||
        ev.type === "thread.closed" ||
        ev.type === "thread.archived" ||
        ev.type === "thread.unarchived" ||
        ev.type === "thread.deleted"
      ) {
        if (onThreadEvent) {
          await onThreadEvent();
        }
      }

      if (ev.type === "agent.online" || ev.type === "agent.offline" || ev.type === "agent.updated") {
        if (onAgentPresence) {
          await onAgentPresence();
        }
      }

      if (String(ev.type || "").startsWith("cli.session.") && onCliSessionEvent) {
        await onCliSessionEvent(ev);
      }

      if (ev.type === "agent.typing" && p.thread_id === activeThreadId && onTyping) {
        onTyping(p.agent_id, Boolean(p.is_typing));
      }
    };
  }

  window.AcbSSE = {
    setConnectedUI,
    startSSE,
    isConnected: () => _isConnected,
  };
})();
