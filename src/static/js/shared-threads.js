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
    const response = (await api("/api/threads?include_archived=1")) || { threads: [] };
    const allThreads = response.threads || [];
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

  function openThreadContextMenu(event, thread, options = {}) {
    event.preventDefault();
    event.stopPropagation();

    const menu = document.getElementById("thread-context-menu");
    const archiveBtn = document.getElementById("ctx-archive");
    const unarchiveBtn = document.getElementById("ctx-unarchive");
    const closeBtn = document.getElementById("ctx-close");
    const deleteBtn = document.getElementById("ctx-delete");
    if (!menu || !archiveBtn || !unarchiveBtn || !closeBtn || !deleteBtn) return thread;

    const adModeEnabled = !!options.showAd;

    closeBtn.disabled = adModeEnabled;
    closeBtn.textContent = adModeEnabled ? "Close (disabled by show_ad)" : "Close";
    archiveBtn.disabled = false;
    archiveBtn.textContent = "Archive";
    deleteBtn.disabled = adModeEnabled;
    deleteBtn.textContent = adModeEnabled ? "Delete (disabled by show_ad)" : "Delete";

    if (thread.status === "archived") {
      archiveBtn.style.display = "none";
      unarchiveBtn.style.display = "block";
      unarchiveBtn.disabled = false;
    } else {
      archiveBtn.style.display = "block";
      unarchiveBtn.style.display = "none";
    }

    menu.classList.add("visible");

    // Make menu visible temporarily to measure its actual height
    menu.style.visibility = 'hidden';
    menu.style.position = 'fixed';
    menu.style.left = '0';
    menu.style.top = '0';

    // Force layout to calculate dimensions
    const menuWidth = menu.offsetWidth || 170;
    const menuHeight = menu.offsetHeight || 84;
    const padding = 8;

    menu.style.visibility = 'visible';

    let x = event.clientX;
    let y = event.clientY;

    // Check if menu would overflow to the right
    if (x + menuWidth + padding > window.innerWidth) {
      x = window.innerWidth - menuWidth - padding;
    }

    // Check if menu would overflow to the bottom
    if (y + menuHeight + padding > window.innerHeight) {
      y = window.innerHeight - menuHeight - padding;
    }

    // Ensure menu stays within left and top boundaries
    x = Math.max(padding, x);
    y = Math.max(padding, y);

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const threadItems = document.querySelectorAll('.thread-item');
    threadItems.forEach(item => {
      if (item.getAttribute('data-thread-id') === String(thread.id)) {
        item.classList.add('context-highlight');
      } else {
        item.classList.remove('context-highlight');
      }
    });

    return thread;
  }

  function hideThreadContextMenu() {
    const menu = document.getElementById("thread-context-menu");
    const highlightedItems = document.querySelectorAll('.thread-item.context-highlight');
    highlightedItems.forEach(item => {
      item.classList.remove('context-highlight');
    });
    if (menu) menu.classList.remove("visible");
    return null;
  }

  async function closeThread({ threadId, api, refreshThreads, x = null, y = null }) {
    if (!threadId) return;

    const inputDialog = document.getElementById('input-dialog');
    if (!inputDialog) {
      console.error('[closeThread] Input dialog not found');
      return;
    }

    const summary = await inputDialog.show({
      title: 'Close Thread',
      message: 'Optional summary for this thread (leave blank to skip):',
      placeholder: 'Enter summary...',
      value: '',
      confirmText: 'Close',
      x,
      y,
    });

    // User cancelled the dialog
    if (summary === null) return;

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
    const { id, _clickX = null, _clickY = null } = ctx;
    hideThreadContextMenu();
    await closeThread(id, _clickX, _clickY);
  }

  async function exportThread({ threadId, topic }) {
    if (!threadId) return;
    try {
      const response = await fetch(`/api/threads/${threadId}/export`);
      if (!response.ok) {
        console.warn(`[ACB] Export failed: HTTP ${response.status}`);
        return;
      }
      const text = await response.text();
      const slug = (topic || threadId)
        .toLowerCase()
        .replace(/[^\w-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "thread";
      const filename = `${slug}.md`;
      const blob = new Blob([text], { type: "text/markdown; charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn("[ACB] Export error:", err);
    }
  }

  async function copyThreadNameFromMenu({
    getContextMenuThread,
    hideThreadContextMenu,
    copyTextWithFallback,
  }) {
    const ctx = getContextMenuThread();
    if (!ctx) return;
    const topic = ctx.topic || "";
    hideThreadContextMenu();
    const ok = await copyTextWithFallback(topic);
    if (ok) {
      console.log(`[copyThreadName] Copied: "${topic}"`);
    }
  }

  async function copyJoinPromptFromMenu({
    getContextMenuThread,
    hideThreadContextMenu,
    copyTextWithFallback,
  }) {
    const ctx = getContextMenuThread();
    if (!ctx) return;
    const topic = ctx.topic || "";
    hideThreadContextMenu();

    const prompt = `Please use AgentChatBus MCP tools to join the Thread. Enter the "${topic}" Thread, using bus_connect.
The Thread name must match exactly. Please follow the system prompt within the Thread. All agents should maintain a cooperative attitude. If you need to modify code, you must obtain consent from other agents. Because you are reading the same codebase. Everyone can see the source code. Please be polite and avoid code conflicts. Human programmers may also participate in the discussion and assist agents. But mainly agents should cooperate with each other.
The person who created the Thread is the Thread administrator and is responsible for administration and task coordination. If you are entering an existing Thread, wait for other agents to assign tasks. You need to confirm before making any changes.
Please make sure to keep calling msg_wait. Do not exit the agent process. Do not exit the agent process unless you receive a notification. msg_wait does not consume any resources, please use msg_wait to maintain the connection.
Task: After entering, stand by. Human programmers may need to publish requirements.`;

    const ok = await copyTextWithFallback(prompt);
    if (ok) {
      console.log(`[copyJoinPrompt] Copied join prompt for thread: "${topic}"`);
    }
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
    exportThread,
    copyThreadNameFromMenu,
    copyJoinPromptFromMenu,
  };
})();
