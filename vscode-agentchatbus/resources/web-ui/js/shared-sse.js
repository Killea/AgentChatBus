(function () {
  let _isConnected = false;
  let _agentTransport = '';
  let _bindHost = '';

  function _updateLabelText(connected) {
    const label = document.getElementById("status-label");
    if (!label) return;
    if (!connected) {
      label.textContent = "Reconnecting…";
      return;
    }
    const isV2 = _agentTransport === 'v2-socket';
    const isLan = _bindHost === '0.0.0.0' || _bindHost === '::' || _bindHost === '';
    if (isV2 && isLan) {
      label.textContent = "Connected · V2 Socket + LAN HTTP";
    } else if (isV2) {
      label.textContent = "Connected · V2 Socket";
    } else if (_agentTransport === 'v1-http') {
      label.textContent = "Connected · V1 HTTP";
    } else {
      label.textContent = "Connected";
    }
  }

  function setConnectedUI(connected) {
    _isConnected = connected;
    const dot = document.getElementById("status-dot");
    if (!dot) return;

    dot.style.background = connected ? "var(--green)" : "var(--red)";
    dot.style.boxShadow = connected ? "0 0 8px var(--green)" : "0 0 8px var(--red)";
    _updateLabelText(connected);
  }

  // Fetch agent_transport + bind_host from /api/metrics to enrich the status label.
  async function _fetchTransportInfo() {
    try {
      const res = await fetch('/api/metrics');
      if (!res.ok) return;
      const data = await res.json();
      _agentTransport = String(data?.agent_transport || '').trim().toLowerCase();
      _bindHost = String(data?.bind_host || '').trim();
      _updateLabelText(_isConnected);
    } catch { /* ignore */ }
  }
  _fetchTransportInfo();
  setInterval(_fetchTransportInfo, 30000);

  function startSSE(deps) {
    const {
      getActiveThreadId,
      getCompareThreadId,
      onMsgNew,
      onTranscriptUpdate,
      onMsgEdit,
      onCompareMsgNew,
      onCompareTranscriptUpdate,
      onCompareMsgEdit,
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
      const compareThreadId = typeof getCompareThreadId === "function" ? getCompareThreadId() : null;

      if (ev.type === "msg.new") {
        if (p.thread_id === activeThreadId && onMsgNew) {
          await onMsgNew();
        }
        if (compareThreadId && p.thread_id === compareThreadId && onCompareMsgNew) {
          await onCompareMsgNew();
        }
        if (onThreadEvent) {
          await onThreadEvent();
        }
      }

      if (ev.type === "thread.transcript.updated") {
        if (p.thread_id === activeThreadId && onTranscriptUpdate) {
          await onTranscriptUpdate();
        }
        if (compareThreadId && p.thread_id === compareThreadId && onCompareTranscriptUpdate) {
          await onCompareTranscriptUpdate();
        }
      }

      if (ev.type === "msg.edit") {
        if (p.thread_id === activeThreadId && onMsgEdit) {
          await onMsgEdit(p);
        }
        if (compareThreadId && p.thread_id === compareThreadId && onCompareMsgEdit) {
          await onCompareMsgEdit(p);
        }
      }

      if (
        ev.type === "thread.new" ||
        ev.type === "thread.state" ||
        ev.type === "thread.closed" ||
        ev.type === "thread.archived" ||
        ev.type === "thread.unarchived" ||
        ev.type === "thread.deleted" ||
        ev.type === "thread.tag" ||
        ev.type === "thread.untag"
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
