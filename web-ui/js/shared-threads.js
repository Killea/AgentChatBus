(function () {
  const PINNED_THREADS_STORAGE_KEY = "acb.pinnedThreads.v1";
  const THREAD_TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

  let activeTagFilter = null;
  let cachedAllThreads = [];

  function normalizeThreadTagInput(tag) {
    const normalized = String(tag || "").trim().toLowerCase();
    if (!normalized || !THREAD_TAG_PATTERN.test(normalized)) {
      return null;
    }
    return normalized;
  }

  function getActiveTagFilter() {
    return activeTagFilter;
  }

  function setActiveTagFilter(tag) {
    activeTagFilter = tag ? normalizeThreadTagInput(tag) : null;
    updateTagFilterUI(deriveKnownTags(cachedAllThreads));
  }

  function clearActiveTagFilter() {
    setActiveTagFilter(null);
  }

  function deriveKnownTags(threads) {
    const tags = new Set();
    for (const thread of Array.isArray(threads) ? threads : []) {
      for (const tag of Array.isArray(thread?.tags) ? thread.tags : []) {
        const normalized = normalizeThreadTagInput(tag);
        if (normalized) {
          tags.add(normalized);
        }
      }
    }
    return Array.from(tags).sort();
  }

  function updateTagFilterUI(knownTags) {
    const container = document.getElementById("thread-tag-filter-list");
    if (!container) return;

    const tags = Array.isArray(knownTags) ? knownTags : [];
    if (!tags.length && !activeTagFilter) {
      container.innerHTML = `<div class="thread-tag-filter-empty">No tags yet</div>`;
      return;
    }

    const chips = tags
      .map((tag) => {
        const activeClass = activeTagFilter === tag ? " is-active" : "";
        return `<button type="button" class="thread-tag-filter-chip${activeClass}" data-tag="${tag}" onclick="setThreadTagFilter('${tag}')">${tag}</button>`;
      })
      .join("");

    const clearButton = activeTagFilter
      ? `<button type="button" class="thread-tag-filter-clear" onclick="clearThreadTagFilter()">Clear tag filter</button>`
      : "";

    container.innerHTML = `${chips}${clearButton}`;
  }

  function filterThreadsForDisplay(allThreads, selectedStatuses, tagFilter) {
    return (Array.isArray(allThreads) ? allThreads : []).filter((thread) => {
      if (!selectedStatuses.has(thread.status)) {
        return false;
      }
      if (tagFilter && !(Array.isArray(thread.tags) ? thread.tags : []).includes(tagFilter)) {
        return false;
      }
      return true;
    });
  }

  function loadPinnedThreadIds() {
    try {
      const raw = window.localStorage?.getItem(PINNED_THREADS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.map((id) => String(id || "").trim()).filter(Boolean) : []);
    } catch {
      return new Set();
    }
  }

  function savePinnedThreadIds(ids) {
    try {
      const values = Array.from(ids).map((id) => String(id || "").trim()).filter(Boolean);
      window.localStorage?.setItem(PINNED_THREADS_STORAGE_KEY, JSON.stringify(values));
    } catch {
      // Ignore storage write failures and keep the UI functional.
    }
  }

  function isThreadPinned(threadId) {
    return loadPinnedThreadIds().has(String(threadId || "").trim());
  }

  function setThreadPinned(threadId, pinned) {
    const resolvedId = String(threadId || "").trim();
    if (!resolvedId) {
      return false;
    }
    const ids = loadPinnedThreadIds();
    if (pinned) {
      ids.add(resolvedId);
    } else {
      ids.delete(resolvedId);
    }
    savePinnedThreadIds(ids);
    return ids.has(resolvedId);
  }

  function toggleThreadPinned(threadId) {
    const resolvedId = String(threadId || "").trim();
    const nextPinned = !isThreadPinned(resolvedId);
    setThreadPinned(resolvedId, nextPinned);
    return nextPinned;
  }

  function decorateThreads(threads) {
    const pinnedIds = loadPinnedThreadIds();
    return (Array.isArray(threads) ? threads : []).map((thread) => ({
      ...thread,
      isPinned: pinnedIds.has(String(thread?.id || "").trim()),
    }));
  }

  function sortThreadsForDisplay(threads) {
    return [...threads].sort((left, right) => {
      const leftPinned = left?.isPinned ? 0 : 1;
      const rightPinned = right?.isPinned ? 0 : 1;
      if (leftPinned !== rightPinned) {
        return leftPinned - rightPinned;
      }
      return String(right?.created_at || "").localeCompare(String(left?.created_at || ""));
    });
  }

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
    onCompareWithCurrent,
    onTogglePin,
    onOpenContextMenu,
    onTagFilter,
    onTagRemove,
    esc,
    timeAgo,
    activeTagFilter: activeTag = null,
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
        activeTagFilter: activeTag,
      });
      item.addEventListener("thread-select", (e) => {
        const d = e.detail || {};
        if (
          d.shiftKey &&
          activeThreadId &&
          d.id &&
          d.id !== activeThreadId &&
          typeof onCompareWithCurrent === "function"
        ) {
          onCompareWithCurrent(d.id, d.topic, d.status);
          return;
        }
        onSelectThread(d.id, d.topic, d.status);
      });
      item.addEventListener("thread-context", (e) => {
        const d = e.detail || {};
        if (d.event && d.thread) {
          onOpenContextMenu(d.event, d.thread);
        }
      });
      item.addEventListener("thread-pin-toggle", (e) => {
        const d = e.detail || {};
        if (!d.id) {
          return;
        }
        if (typeof onTogglePin === "function") {
          onTogglePin(d.id, d.pinned !== false);
        }
      });
      item.addEventListener("thread-tag-filter", (e) => {
        const d = e.detail || {};
        if (!d.tag || typeof onTagFilter !== "function") {
          return;
        }
        onTagFilter(d.tag);
      });
      item.addEventListener("thread-tag-remove", (e) => {
        const d = e.detail || {};
        if (!d.id || !d.tag || typeof onTagRemove !== "function") {
          return;
        }
        onTagRemove(d.id, d.tag);
      });
      pane.appendChild(item);
    });
  }

  async function refreshThreads({
    api,
    getSelectedStatuses,
    getActiveThreadId,
    onActiveThreadStatus,
    resetThreadSelection,
    onSelectThread,
    onCompareWithCurrent,
    onTogglePin,
    onOpenContextMenu,
    onTagFilter,
    onTagRemove,
    esc,
    timeAgo,
    updateThreadFilterButton,
    onThreadsRefreshed,
  }) {
    const response = (await api("/api/threads?include_archived=1")) || { threads: [] };
    cachedAllThreads = sortThreadsForDisplay(decorateThreads((response && response.threads) || []));
    updateTagFilterUI(deriveKnownTags(cachedAllThreads));
    const selectedStatuses = getSelectedStatuses();
    const activeThreadId = getActiveThreadId();
    const threads = filterThreadsForDisplay(cachedAllThreads, selectedStatuses, activeTagFilter);
    if (activeThreadId && typeof onActiveThreadStatus === "function") {
      const activeThread = cachedAllThreads.find((t) => t.id === activeThreadId) || null;
      onActiveThreadStatus(activeThread ? normalizeThreadStatus(activeThread.status) : null);
    }

    const hasActiveThread = activeThreadId && threads.some((t) => t.id === activeThreadId);
    if (activeThreadId && !hasActiveThread) {
      resetThreadSelection();
    }

    renderThreadList({
      threads,
      activeThreadId,
      onSelectThread,
      onCompareWithCurrent,
      onTogglePin,
      onOpenContextMenu,
      onTagFilter,
      onTagRemove,
      esc,
      timeAgo,
      activeTagFilter,
    });

    updateThreadFilterButton();
    if (typeof onThreadsRefreshed === "function") {
      onThreadsRefreshed(cachedAllThreads);
    }
  }

  function normalizeThreadStatus(value) {
    return String(value || "").trim() || null;
  }

  function openThreadContextMenu(event, thread, options = {}) {
    event.preventDefault();
    event.stopPropagation();

    const menu = document.getElementById("thread-context-menu");
    const renameBtn = document.getElementById("ctx-rename");
    const compareBtn = document.getElementById("ctx-compare");
    const archiveBtn = document.getElementById("ctx-archive");
    const unarchiveBtn = document.getElementById("ctx-unarchive");
    const closeBtn = document.getElementById("ctx-close");
    const pinBtn = document.getElementById("ctx-pin");
    const deleteBtn = document.getElementById("ctx-delete");
    if (!menu || !renameBtn || !archiveBtn || !unarchiveBtn || !closeBtn || !pinBtn || !deleteBtn) return thread;

    const adModeEnabled = !!options.showAd;

    closeBtn.disabled = adModeEnabled;
    closeBtn.textContent = adModeEnabled ? "🔒 Close (disabled by show_ad)" : "🔒 Close";
    renameBtn.disabled = false;
    renameBtn.textContent = "✏️ Rename";
    archiveBtn.disabled = false;
    archiveBtn.textContent = "🗄️ Archive";
    pinBtn.disabled = false;
    pinBtn.textContent = thread?.isPinned ? "📍 Unpin" : "📌 Pin";
    deleteBtn.disabled = adModeEnabled;
    deleteBtn.textContent = adModeEnabled ? "🗑️ Delete (disabled by show_ad)" : "🗑️ Delete";

    const activeThreadId = String(options.activeThreadId || "").trim();
    if (compareBtn) {
      const canCompare = activeThreadId && String(thread?.id || "").trim() !== activeThreadId;
      compareBtn.style.display = canCompare ? "block" : "none";
    }

    if (thread.status === "archived") {
      archiveBtn.style.display = "none";
      unarchiveBtn.style.display = "block";
      unarchiveBtn.disabled = false;
      unarchiveBtn.textContent = "📂 Unarchive";
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

    const confirmDialog = document.getElementById('confirm-dialog');
    const inputDialog = document.getElementById('input-dialog');
    if (!confirmDialog || !inputDialog) {
      console.error('[closeThread] Confirm dialog or input dialog not found');
      return;
    }

    const confirmed = await confirmDialog.show({
      title: 'Close Thread',
      message: `
        <strong>Closing a thread stops automatic coordination.</strong><br><br>
        AgentChatBus will stop automatically waking offline CLI agents for this thread and stop relaying new discussion turns through the CLI meeting coordinator.<br><br>
        Any running CLI sessions attached to this thread will also be stopped.<br><br>
        Existing messages are preserved, and human participants can still keep chatting after closure. This action does not delete the thread.
      `,
      confirmText: 'Continue',
      confirmClass: 'btn-destructive',
      x,
      y,
    });

    if (!confirmed) return;

    const summary = await inputDialog.show({
      title: 'Close Thread',
      message: 'Optional closing summary for this thread (leave blank to skip):',
      placeholder: 'Enter summary...',
      value: '',
      confirmText: 'Close Thread',
      x,
      y,
    });

    // User cancelled the dialog
    if (summary === null) return;

    const result = await api(`/api/threads/${threadId}/close`, {
      method: "POST",
      body: JSON.stringify({ summary: summary || null }),
    });
    await refreshThreads();
    if (window.AcbCliSessions && typeof window.AcbCliSessions.refreshThread === "function") {
      await window.AcbCliSessions.refreshThread(threadId, api);
    }
    return result;
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
After bus_connect, treat the returned role metadata and thread administrator metadata as the source of truth for coordination.
Please make sure to keep calling msg_wait. Do not exit the agent process. Do not exit the agent process unless you receive a notification. msg_wait does not consume any resources, please use msg_wait to maintain the connection.
Task: After entering, stand by. Human programmers may need to publish requirements.`;

    const ok = await copyTextWithFallback(prompt);
    if (ok) {
      console.log(`[copyJoinPrompt] Copied join prompt for thread: "${topic}"`);
    }
  }

  async function renameThreadFromMenu({
    getContextMenuThread,
    hideThreadContextMenu,
    api,
    refreshThreads,
    getActiveThreadId,
    onActiveThreadRenamed,
  }) {
    const ctx = getContextMenuThread();
    if (!ctx?.id) return null;
    const inputDialog = document.getElementById("input-dialog");
    if (!inputDialog || typeof inputDialog.show !== "function") {
      console.error("[renameThreadFromMenu] Input dialog not found");
      return null;
    }

    const { id, topic = "", status = "discuss", _clickX = null, _clickY = null } = ctx;
    hideThreadContextMenu();

    const nextTopic = await inputDialog.show({
      title: "Rename Thread",
      message: "Enter a new thread name:",
      placeholder: "Thread name",
      value: topic,
      confirmText: "Rename",
      x: _clickX,
      y: _clickY,
    });

    if (nextTopic === null) {
      return null;
    }

    const normalizedTopic = String(nextTopic || "").trim();
    if (!normalizedTopic || normalizedTopic === String(topic || "").trim()) {
      return null;
    }

    const result = await api(`/api/threads/${id}/rename`, {
      method: "POST",
      body: JSON.stringify({ topic: normalizedTopic }),
    });
    if (!result || result.ok !== true || !result.thread) {
      if (result?.detail) {
        alert(result.detail);
      }
      return result || null;
    }

    await refreshThreads();
    if (getActiveThreadId() === id && typeof onActiveThreadRenamed === "function") {
      onActiveThreadRenamed({
        id,
        topic: String(result.thread.topic || normalizedTopic),
        status: String(result.thread.status || status),
      });
    }
    return result;
  }

  async function addThreadTag(threadId, tag, api) {
    const normalized = normalizeThreadTagInput(tag);
    if (!normalized) {
      return { ok: false, detail: "Invalid tag: use lowercase letters, numbers, underscore, or hyphen (max 32 chars)." };
    }
    return api(`/api/threads/${threadId}/tags`, {
      method: "POST",
      body: JSON.stringify({ tag: normalized }),
    });
  }

  async function removeThreadTag(threadId, tag, api) {
    const normalized = normalizeThreadTagInput(tag) || String(tag || "").trim().toLowerCase();
    if (!normalized) {
      return { ok: false, detail: "Invalid tag" };
    }
    return api(`/api/threads/${threadId}/tags/${encodeURIComponent(normalized)}`, {
      method: "DELETE",
    });
  }

  async function addTagFromMenu({
    getContextMenuThread,
    hideThreadContextMenu,
    api,
    refreshThreads,
  }) {
    const ctx = getContextMenuThread();
    if (!ctx?.id) return null;
    const inputDialog = document.getElementById("input-dialog");
    if (!inputDialog || typeof inputDialog.show !== "function") {
      console.error("[addTagFromMenu] Input dialog not found");
      return null;
    }

    const { id, _clickX = null, _clickY = null } = ctx;
    hideThreadContextMenu();

    const nextTag = await inputDialog.show({
      title: "Add Tag",
      message: "Enter a tag slug (lowercase letters, numbers, underscore, hyphen):",
      placeholder: "feature-alpha",
      value: "",
      confirmText: "Add Tag",
      x: _clickX,
      y: _clickY,
    });

    if (nextTag === null) {
      return null;
    }

    const result = await addThreadTag(id, nextTag, api);
    if (!result || result.ok !== true) {
      if (result?.detail) {
        alert(result.detail);
      }
      return result || null;
    }

    await refreshThreads();
    return result;
  }

  async function pinThreadFromMenu({
    getContextMenuThread,
    hideThreadContextMenu,
    refreshThreads,
  }) {
    const ctx = getContextMenuThread();
    if (!ctx?.id) return;
    setThreadPinned(ctx.id, !Boolean(ctx.isPinned));
    hideThreadContextMenu();
    await refreshThreads();
  }

  function getCachedAllThreads() {
    return cachedAllThreads.slice();
  }

  window.AcbThreads = {
    toggleThreadFilterPanel,
    hideThreadFilterPanel,
    selectedStatusListFromUI,
    updateThreadFilterButton,
    refreshThreads,
    getCachedAllThreads,
    openThreadContextMenu,
    hideThreadContextMenu,
    closeThread,
    archiveThreadFromMenu,
    unarchiveThreadFromMenu,
    closeThreadFromMenu,
    exportThread,
    copyThreadNameFromMenu,
    copyJoinPromptFromMenu,
    renameThreadFromMenu,
    isThreadPinned,
    setThreadPinned,
    toggleThreadPinned,
    pinThreadFromMenu,
    getActiveTagFilter,
    setActiveTagFilter,
    clearActiveTagFilter,
    deriveKnownTags,
    normalizeThreadTagInput,
    addThreadTag,
    removeThreadTag,
    addTagFromMenu,
    filterThreadsForDisplay,
  };
})();
