/**
 * UI-07: Message Navigation Sidebar (Emoji Minimap)
 * Fixed-width scrollable column to the right of the chat area.
 * One emoji entry per message, compact, with timestamp.
 * Click → smooth scroll to message. IntersectionObserver highlights active entry.
 * Toggle via Settings > UI Preferences (localStorage).
 */
(function () {
  const STORAGE_KEY = "acb-minimap-enabled";
  let _observer = null;

  // ─── Enabled state ────────────────────────────────────────────────────────

  function isEnabled() {
    const val = localStorage.getItem(STORAGE_KEY);
    return val === null ? true : val === "true";
  }

  function applyEnabledState() {
    document.body.classList.toggle("minimap-hidden", !isEnabled());
  }

  function setEnabled(enabled) {
    localStorage.setItem(STORAGE_KEY, String(enabled));
    document.body.classList.toggle("minimap-hidden", !enabled);
  }

  // ─── Build sidebar ────────────────────────────────────────────────────────

  function buildSidebar() {
    const sidebar = document.getElementById("nav-sidebar");
    const messagesEl = document.getElementById("messages-scroll");
    const messagesInner = document.getElementById("messages");
    if (!sidebar || !messagesEl || !messagesInner) return;

    // Disconnect previous observer
    if (_observer) { _observer.disconnect(); _observer = null; }

    sidebar.innerHTML = "";

    const rows = messagesInner.querySelectorAll(".msg-row[data-seq]");
    if (rows.length === 0) {
      sidebar.classList.add("nav-sidebar-empty");
      return;
    }
    sidebar.classList.remove("nav-sidebar-empty");

    rows.forEach((row) => {
      const seq = row.getAttribute("data-seq");
      const authorId = row.getAttribute("data-author-id") || "unknown";

      // Emoji from avatar
      const avatarEl = row.querySelector(".msg-avatar");
      const emoji = avatarEl ? avatarEl.textContent.trim() : "💬";

      // Author name
      const authorNameEl = row.querySelector(".msg-author-label");
      const authorName = authorNameEl ? authorNameEl.textContent.trim() : authorId;

      // Timestamp
      const timeEl = row.querySelector(".msg-time-label");
      const rawTime = timeEl ? timeEl.textContent.trim() : "";
      // Keep only the time part (strip "seq N " prefix)
      const timeLabel = rawTime.replace(/^seq\s*\d+\s*/i, "").trim();

      const entry = document.createElement("button");
      entry.className = "nav-entry";
      entry.setAttribute("data-seq", seq);
      entry.setAttribute("data-author-id", authorId);
      entry.setAttribute("title", `${authorName}${timeLabel ? " · " + timeLabel : ""} (seq ${seq})`);
      entry.setAttribute("aria-label", `Jump to message ${seq} from ${authorName}`);

      entry.innerHTML =
        `<span class="nav-entry-emoji">${emoji}</span>` +
        `<span class="nav-entry-meta">` +
          `<span class="nav-entry-name">${_esc(authorName)}</span>` +
          (timeLabel ? `<span class="nav-entry-time">${_esc(timeLabel)}</span>` : "") +
        `</span>`;

      entry.addEventListener("click", () => {
        // Scroll #messages-scroll to align the top of the row with the top of the viewport
        const scrollEl = document.getElementById("messages-scroll");
        if (scrollEl) {
          const rowTop = row.offsetTop;
          scrollEl.scrollTo({ top: rowTop - 12, behavior: "smooth" });
        } else {
          row.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        row.classList.add("nav-highlight");
        setTimeout(() => row.classList.remove("nav-highlight"), 1200);
      });

      sidebar.appendChild(entry);
    });

    // IntersectionObserver: highlight entry for visible messages.
    // Guard: ignore the first batch of callbacks fired immediately on observe()
    // (browser fires for all elements before any scroll has occurred).
    let _ready = false;
    setTimeout(() => { _ready = true; }, 300);

    _observer = new IntersectionObserver((entries) => {
      if (!_ready) return;
      entries.forEach((e) => {
        const seq = e.target.getAttribute("data-seq");
        const entry = sidebar.querySelector(`.nav-entry[data-seq="${seq}"]`);
        if (entry) entry.classList.toggle("nav-entry-active", e.isIntersecting);
      });
    }, { root: messagesEl, threshold: 0.3 });

    rows.forEach((row) => _observer.observe(row));
  }

  function _esc(str) {
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  window.AcbNavSidebar = {
    rebuild()      { buildSidebar(); },
    onNewMessage() { buildSidebar(); },
    setEnabled,
    isEnabled,
    applyEnabledState,
  };

  applyEnabledState();
})();
