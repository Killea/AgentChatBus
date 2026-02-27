(function () {
  function toggleThreadFilterPanel(event) {
    if (event) event.stopPropagation();
    const panel = document.getElementById("thread-filter-panel");
    if (panel) panel.classList.toggle("visible");
  }

  function hideThreadFilterPanel() {
    const panel = document.getElementById("thread-filter-panel");
    if (panel) panel.classList.remove("visible");
  }

  function selectedStatusListFromUI() {
    const checkboxes = document.querySelectorAll("#thread-filter-panel input[data-status]");
    return Array.from(checkboxes)
      .filter((cb) => cb.checked)
      .map((cb) => cb.getAttribute("data-status"));
  }

  function updateThreadFilterButton(allStatuses, normalStatuses, selectedStatuses) {
    const btn = document.getElementById("btn-thread-filter");
    if (!btn) return;

    const selected = allStatuses.filter((s) => selectedStatuses.has(s));
    const normalOnly =
      selected.length === normalStatuses.length &&
      normalStatuses.every((s) => selectedStatuses.has(s)) &&
      !selectedStatuses.has("archived");

    if (normalOnly) {
      btn.textContent = "Filter: normal (5)";
      return;
    }
    if (selected.length === allStatuses.length) {
      btn.textContent = "Filter: all (6)";
      return;
    }
    btn.textContent = `Filter: ${selected.join(", ")}`;
  }

  function renderThreadList({
    threads,
    activeThreadId,
    onSelectThread,
    onOpenContextMenu,
    esc,
    timeAgo,
  }) {
    const pane = document.getElementById("thread-pane");
    if (!pane) return;

    pane.innerHTML = threads.length
      ? ""
      : `
    <div style="padding:24px 16px;color:var(--text-3);font-size:13px;text-align:center">
      No threads match current filter.
    </div>`;

    threads.forEach((t) => {
      const item = document.createElement("acb-thread-item");
      item.setData({
        thread: t,
        active: t.id === activeThreadId,
        timeAgo,
        esc,
      });
      item.addEventListener("thread-select", (e) => {
        const d = e.detail || {};
        onSelectThread(d.id, d.topic, d.status);
      });
      item.addEventListener("thread-context", (e) => {
        const d = e.detail || {};
        if (d.event && d.thread) {
          onOpenContextMenu(d.event, d.thread);
        }
      });
      pane.appendChild(item);
    });
  }

  async function refreshThreads({
    api,
    getSelectedStatuses,
    getActiveThreadId,
    resetThreadSelection,
    onSelectThread,
    onOpenContextMenu,
    esc,
    timeAgo,
    updateThreadFilterButton,
  }) {
    const allThreads = (await api("/api/threads?include_archived=1")) || [];
    const selectedStatuses = getSelectedStatuses();
    const activeThreadId = getActiveThreadId();
    const threads = allThreads.filter((t) => selectedStatuses.has(t.status));

    const hasActiveThread = activeThreadId && threads.some((t) => t.id === activeThreadId);
    if (activeThreadId && !hasActiveThread) {
      resetThreadSelection();
    }

    renderThreadList({
      threads,
      activeThreadId,
      onSelectThread,
      onOpenContextMenu,
      esc,
      timeAgo,
    });

    updateThreadFilterButton();
  }

  function openThreadContextMenu(event, thread) {
    event.preventDefault();
    event.stopPropagation();

    const menu = document.getElementById("thread-context-menu");
    const archiveBtn = document.getElementById("ctx-archive");
    const unarchiveBtn = document.getElementById("ctx-unarchive");
    const closeBtn = document.getElementById("ctx-close");
    if (!menu || !archiveBtn || !unarchiveBtn || !closeBtn) return thread;

    closeBtn.disabled = false;
    closeBtn.textContent = "Close";
    archiveBtn.disabled = false;
    archiveBtn.textContent = "Archive";

    if (thread.status === "archived") {
      archiveBtn.style.display = "none";
      unarchiveBtn.style.display = "block";
      unarchiveBtn.disabled = false;
    } else {
      archiveBtn.style.display = "block";
      unarchiveBtn.style.display = "none";
    }

    menu.classList.add("visible");
    const menuWidth = 170;
    const menuHeight = 84;
    const x = Math.min(event.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(event.clientY, window.innerHeight - menuHeight - 8);
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;

    return thread;
  }

  function hideThreadContextMenu() {
    const menu = document.getElementById("thread-context-menu");
    if (menu) menu.classList.remove("visible");
    return null;
  }

  async function closeThread({ threadId, api, refreshThreads }) {
    if (!threadId) return;
    const summary = prompt("Optional summary for this thread (leave blank to skip):");
    await api(`/api/threads/${threadId}/close`, {
      method: "POST",
      body: JSON.stringify({ summary: summary || null }),
    });
    await refreshThreads();
  }

  async function archiveThreadFromMenu({
    getContextMenuThread,
    hideThreadContextMenu,
    api,
    getActiveThreadId,
    resetThreadSelection,
    refreshThreads,
  }) {
    const ctx = getContextMenuThread();
    if (!ctx) return;
    const id = ctx.id;

    hideThreadContextMenu();
    const result = await api(`/api/threads/${id}/archive`, { method: "POST" });
    if (!result || result.ok !== true) return;

    if (getActiveThreadId() === id) {
      resetThreadSelection();
    }
    await refreshThreads();
  }

  async function unarchiveThreadFromMenu({
    getContextMenuThread,
    hideThreadContextMenu,
    api,
    getActiveThreadId,
    resetThreadSelection,
    refreshThreads,
  }) {
    const ctx = getContextMenuThread();
    if (!ctx) return;
    const id = ctx.id;

    hideThreadContextMenu();
    const result = await api(`/api/threads/${id}/unarchive`, { method: "POST" });
    if (!result || result.ok !== true) return;

    if (getActiveThreadId() === id) {
      resetThreadSelection();
    }
    await refreshThreads();
  }

  async function closeThreadFromMenu({
    getContextMenuThread,
    hideThreadContextMenu,
    closeThread,
  }) {
    const ctx = getContextMenuThread();
    if (!ctx) return;
    const id = ctx.id;
    hideThreadContextMenu();
    await closeThread(id);
  }

  window.AcbThreads = {
    toggleThreadFilterPanel,
    hideThreadFilterPanel,
    selectedStatusListFromUI,
    updateThreadFilterButton,
    refreshThreads,
    openThreadContextMenu,
    hideThreadContextMenu,
    closeThread,
    archiveThreadFromMenu,
    unarchiveThreadFromMenu,
    closeThreadFromMenu,
  };
})();
