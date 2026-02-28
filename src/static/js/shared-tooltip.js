(function () {
  let tooltipEl = null;
  let activeTarget = null;
  let hideTimer = null;
  let manualMode = false;

  function ensureTooltipEl() {
    if (tooltipEl) return tooltipEl;

    tooltipEl = document.createElement("div");
    tooltipEl.id = "acb-global-tooltip";
    tooltipEl.setAttribute("role", "tooltip");
    tooltipEl.style.position = "fixed";
    tooltipEl.style.zIndex = "10000";
    tooltipEl.style.maxWidth = "320px";
    tooltipEl.style.padding = "8px 10px";
    tooltipEl.style.borderRadius = "8px";
    tooltipEl.style.border = "1px solid var(--border-light)";
    tooltipEl.style.background = "var(--bg-card)";
    tooltipEl.style.color = "var(--text-1)";
    tooltipEl.style.fontSize = "12px";
    tooltipEl.style.lineHeight = "1.45";
    tooltipEl.style.boxShadow = "var(--shadow)";
    tooltipEl.style.pointerEvents = "none";
    tooltipEl.style.display = "none";
    tooltipEl.style.whiteSpace = "normal";
    tooltipEl.style.wordBreak = "break-word";
    tooltipEl.style.opacity = "0";
    tooltipEl.style.transform = "translateY(2px)";
    tooltipEl.style.transition = "opacity .12s ease, transform .12s ease";

    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function clearHideTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function getTooltipText(target) {
    if (!target) return "";
    const dataText = target.getAttribute("data-tooltip");
    if (dataText && dataText.trim()) return dataText.trim();

    const titleText = target.getAttribute("title");
    if (titleText && titleText.trim()) return titleText.trim();
    return "";
  }

  function suppressNativeTitle(target) {
    if (!target) return;
    const title = target.getAttribute("title");
    if (!title) return;
    if (!target.hasAttribute("data-title-backup")) {
      target.setAttribute("data-title-backup", title);
    }
    target.removeAttribute("title");
  }

  function restoreNativeTitle(target) {
    if (!target) return;
    if (!target.hasAttribute("data-title-backup")) return;
    const backup = target.getAttribute("data-title-backup") || "";
    target.removeAttribute("data-title-backup");
    if (backup) target.setAttribute("title", backup);
  }

  function positionTooltip(target) {
    if (!tooltipEl || !target) return;
    const rect = target.getBoundingClientRect();
    const pad = 10;
    const gap = 8;

    const w = tooltipEl.offsetWidth || 220;
    const h = tooltipEl.offsetHeight || 44;

    let left = rect.left + rect.width / 2 - w / 2;
    let top = rect.top - h - gap;

    if (left < pad) left = pad;
    if (left + w > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - w - pad);
    }

    if (top < pad) {
      top = rect.bottom + gap;
    }

    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
  }

  function showTooltip(target) {
    const text = getTooltipText(target);
    if (!text) return;

    ensureTooltipEl();
    manualMode = false;
    suppressNativeTitle(target);
    activeTarget = target;
    tooltipEl.className = "";
    tooltipEl.style.width = "";
    tooltipEl.style.maxWidth = "320px";
    tooltipEl.style.pointerEvents = "none";
    tooltipEl.textContent = text;
    tooltipEl.style.display = "block";
    positionTooltip(target);

    requestAnimationFrame(() => {
      if (!tooltipEl) return;
      tooltipEl.style.opacity = "1";
      tooltipEl.style.transform = "translateY(0)";
    });
  }

  function hideTooltip() {
    clearHideTimer();
    if (!tooltipEl) return;
    manualMode = false;
    tooltipEl.style.opacity = "0";
    tooltipEl.style.transform = "translateY(2px)";
    setTimeout(() => {
      if (!tooltipEl) return;
      tooltipEl.style.display = "none";
    }, 120);

    if (activeTarget) {
      restoreNativeTitle(activeTarget);
    }
    activeTarget = null;
  }

  function scheduleHide(delay) {
    clearHideTimer();
    hideTimer = setTimeout(() => hideTooltip(), delay || 120);
  }

  function setTooltipContentHtml(html) {
    ensureTooltipEl();
    tooltipEl.innerHTML = html || "";
  }

  function showRich(anchorEl, html, options) {
    ensureTooltipEl();
    manualMode = true;
    activeTarget = anchorEl || null;
    clearHideTimer();

    const opts = options || {};
    tooltipEl.className = opts.className || "";
    tooltipEl.style.pointerEvents = opts.interactive ? "auto" : "none";
    tooltipEl.style.maxWidth = opts.maxWidth || "380px";
    tooltipEl.style.width = opts.width || "";
    setTooltipContentHtml(html || "");
    tooltipEl.style.display = "block";

    if (activeTarget) {
      positionTooltip(activeTarget);
    }

    requestAnimationFrame(() => {
      if (!tooltipEl) return;
      tooltipEl.style.opacity = "1";
      tooltipEl.style.transform = "translateY(0)";
    });
  }

  function findTooltipTarget(node) {
    if (!(node instanceof Element)) return null;
    const target = node.closest("[data-tooltip], [title]");
    if (!target) return null;

    return target;
  }

  function init() {
    ensureTooltipEl();

    document.addEventListener("mouseover", (e) => {
      if (manualMode) return;
      const target = findTooltipTarget(e.target);
      if (!target) return;
      if (activeTarget === target) return;
      showTooltip(target);
    });

    document.addEventListener("mouseout", (e) => {
      if (manualMode) return;
      if (!activeTarget) return;
      const toEl = e.relatedTarget;
      if (toEl instanceof Element && activeTarget.contains(toEl)) return;
      hideTooltip();
    });

    document.addEventListener("focusin", (e) => {
      if (manualMode) return;
      const target = findTooltipTarget(e.target);
      if (!target) return;
      showTooltip(target);
    });

    document.addEventListener("focusout", () => {
      hideTooltip();
    });

    window.addEventListener("scroll", () => {
      if (activeTarget) positionTooltip(activeTarget);
    }, true);

    window.addEventListener("resize", () => {
      if (activeTarget) positionTooltip(activeTarget);
    });

    tooltipEl.addEventListener("mouseenter", () => {
      clearHideTimer();
    });
    tooltipEl.addEventListener("mouseleave", () => {
      if (manualMode) scheduleHide(120);
    });
  }

  window.AcbTooltip = {
    init,
    showTooltip,
    showRich,
    hideTooltip,
    scheduleHide,
    clearHideTimer,
    getTooltipElement: function () {
      return ensureTooltipEl();
    },
    setTooltip: function (el, text) {
      if (!el) return;
      if (!text) {
        el.removeAttribute("data-tooltip");
        return;
      }
      el.setAttribute("data-tooltip", String(text));
    },
  };
})();
