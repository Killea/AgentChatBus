(function () {
  function setConnectedUI(connected) {
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
      onThreadEvent,
      onAgentPresence,
      onTyping,
      setConnected,
    } = deps;

    const es = new EventSource("/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      setTimeout(() => startSSE(deps), 3000);
      es.close();
    };

    es.onmessage = async (e) => {
      const ev = JSON.parse(e.data);
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

      if (ev.type === "agent.online" || ev.type === "agent.offline") {
        if (onAgentPresence) {
          await onAgentPresence();
        }
      }

      if (ev.type === "agent.typing" && p.thread_id === activeThreadId && onTyping) {
        onTyping(p.agent_id, Boolean(p.is_typing));
      }
    };
  }

  window.AcbSSE = {
    setConnectedUI,
    startSSE,
  };
})();
