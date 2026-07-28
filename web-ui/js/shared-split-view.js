(function () {
  const COMPARE_THREAD_STORAGE_KEY = "acb-compare-thread";
  const MIN_COMPARE_WIDTH_PX = 900;
  const TARGET_PRIMARY = "primary";
  const TARGET_COMPARE = "compare";

  let compareThreadId = null;
  let compareThreadTopic = "";
  let compareLastSeq = 0;
  let bannerTimer = null;

  function parseThreadHash(hash = location.hash) {
    const body = String(hash || "").replace(/^#/, "");
    if (!body) {
      return { threadId: "", compareId: "" };
    }
    const params = new URLSearchParams(body.includes("=") ? body : `thread=${body}`);
    return {
      threadId: String(params.get("thread") || "").trim(),
      compareId: String(params.get("compare") || "").trim(),
    };
  }

  function writeThreadHash({ threadId, compareId }) {
    const params = new URLSearchParams();
    if (threadId) {
      params.set("thread", threadId);
    }
    if (compareId) {
      params.set("compare", compareId);
    }
    const next = params.toString();
    history.replaceState(null, "", next ? `#${next}` : location.pathname);
  }

  function isCompareViewportOk() {
    return window.innerWidth >= MIN_COMPARE_WIDTH_PX;
  }

  function showCompareBlockedBanner(message = "Compare view needs a wider window") {
    const banner = document.getElementById("compare-banner");
    if (!banner) {
      return;
    }
    banner.textContent = message;
    banner.hidden = false;
    if (bannerTimer) {
      clearTimeout(bannerTimer);
    }
    bannerTimer = setTimeout(() => {
      banner.hidden = true;
      bannerTimer = null;
    }, 3000);
  }

  function saveCompareThread(id, topic = "") {
    try {
      const normalized = String(id || "").trim();
      if (!normalized) {
        return;
      }
      window.localStorage?.setItem(
        COMPARE_THREAD_STORAGE_KEY,
        JSON.stringify({
          id: normalized,
          topic: String(topic || "").trim(),
        }),
      );
    } catch {
      // Ignore storage failures.
    }
  }

  function loadCompareThread() {
    try {
      const raw = window.localStorage?.getItem(COMPARE_THREAD_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      const id = String(parsed.id || "").trim();
      if (!id) {
        return null;
      }
      return {
        id,
        topic: String(parsed.topic || "").trim(),
      };
    } catch {
      return null;
    }
  }

  function clearCompareThreadStorage() {
    try {
      window.localStorage?.removeItem(COMPARE_THREAD_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  }

  function getCompareThreadId() {
    return compareThreadId;
  }

  function getCompareThreadTopic() {
    return compareThreadTopic;
  }

  function setCompareLastSeq(seq) {
    const value = typeof seq === "function" ? seq(compareLastSeq) : seq;
    compareLastSeq = Number.isFinite(value) ? value : 0;
  }

  function getCompareLastSeq() {
    return compareLastSeq;
  }

  function isCompareMode() {
    return Boolean(compareThreadId);
  }

  function getMessageTargets(target = TARGET_PRIMARY) {
    if (target === TARGET_COMPARE) {
      return {
        messagesEl: document.getElementById("compare-messages"),
        sysPromptEl: document.getElementById("compare-sys-prompt-area"),
        messagesScrollEl: document.getElementById("compare-messages-scroll"),
      };
    }
    return {
      messagesEl: document.getElementById("messages"),
      sysPromptEl: document.getElementById("sys-prompt-area"),
      messagesScrollEl: document.getElementById("messages-scroll"),
    };
  }

  function applyCompareLayout(active) {
    const main = document.getElementById("main");
    const comparePanel = document.getElementById("compare-panel");
    if (main) {
      main.classList.toggle("compare-mode", active);
    }
    if (comparePanel) {
      comparePanel.hidden = !active;
    }
  }

  function updateComparePanelTitle(topic) {
    const titleEl = document.getElementById("compare-panel-title");
    if (titleEl) {
      const label = String(topic || compareThreadTopic || compareThreadId || "Compare").trim();
      titleEl.textContent = label ? `Compare: ${label}` : "Compare";
    }
  }

  function clearComparePanelDom() {
    const compareMessages = document.getElementById("compare-messages");
    const compareSys = document.getElementById("compare-sys-prompt-area");
    if (compareMessages) {
      compareMessages.innerHTML = "";
    }
    if (compareSys) {
      compareSys.innerHTML = "";
    }
  }

  function shouldCompareOnShiftClick(activeId, targetId, shiftKey) {
    const active = String(activeId || "").trim();
    const target = String(targetId || "").trim();
    return Boolean(shiftKey && active && target && active !== target);
  }

  function shouldRefreshCompare(eventThreadId, compareId = compareThreadId) {
    const eventId = String(eventThreadId || "").trim();
    const compare = String(compareId || "").trim();
    return Boolean(compare && eventId && eventId === compare);
  }

  async function enterCompare(compareId, deps = {}) {
    const id = String(compareId || "").trim();
    const activeThreadId = String(deps.activeThreadId || "").trim();
    if (!id || !activeThreadId || id === activeThreadId) {
      return false;
    }
    if (!isCompareViewportOk()) {
      showCompareBlockedBanner();
      return false;
    }

    compareThreadId = id;
    compareThreadTopic = String(deps.topic || "").trim();
    compareLastSeq = 0;
    saveCompareThread(id, compareThreadTopic);
    writeThreadHash({ threadId: activeThreadId, compareId: id });
    applyCompareLayout(true);
    updateComparePanelTitle(compareThreadTopic);

    if (typeof deps.onLoadTranscript === "function") {
      await deps.onLoadTranscript(id);
    }
    if (typeof deps.onEnter === "function") {
      deps.onEnter(id);
    }
    return true;
  }

  async function exitCompare(deps = {}) {
    const activeThreadId = String(deps.activeThreadId || "").trim();
    compareThreadId = null;
    compareThreadTopic = "";
    compareLastSeq = 0;
    clearCompareThreadStorage();
    applyCompareLayout(false);
    clearComparePanelDom();
    if (activeThreadId) {
      writeThreadHash({ threadId: activeThreadId, compareId: null });
    } else {
      writeThreadHash({ threadId: null, compareId: null });
    }
    if (typeof deps.onExit === "function") {
      deps.onExit();
    }
    return true;
  }

  window.AcbSplitView = {
    TARGET_PRIMARY,
    TARGET_COMPARE,
    parseThreadHash,
    writeThreadHash,
    isCompareViewportOk,
    showCompareBlockedBanner,
    saveCompareThread,
    loadCompareThread,
    clearCompareThreadStorage,
    getCompareThreadId,
    getCompareThreadTopic,
    setCompareLastSeq,
    getCompareLastSeq,
    isCompareMode,
    getMessageTargets,
    applyCompareLayout,
    updateComparePanelTitle,
    clearComparePanelDom,
    shouldCompareOnShiftClick,
    shouldRefreshCompare,
    enterCompare,
    exitCompare,
  };
})();
