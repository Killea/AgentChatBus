(function () {
  function setTheme(theme) {
    const effectiveTheme = theme === "light" ? "light" : "dark";
    document.body.setAttribute("data-theme", effectiveTheme);

    const btn = document.getElementById("btn-theme-toggle");
    if (btn) {
      // In dark mode → show sun (click = go light); in light mode → show moon (click = go dark)
      const sun = document.getElementById("theme-icon-sun");
      const moon = document.getElementById("theme-icon-moon");
      if (sun) sun.style.display = effectiveTheme === "dark" ? "" : "none";
      if (moon) moon.style.display = effectiveTheme === "light" ? "" : "none";
      btn.title = effectiveTheme === "light" ? "Switch to dark theme" : "Switch to light theme";
      btn.setAttribute("aria-label", btn.title);
    }
    localStorage.setItem("agentchatbus-theme", effectiveTheme);

    // Update all dynamic emoji avatars for the new theme
    if (window.AcbUtils && window.AcbUtils.getEmojiStyledBackground) {
      const isDark = effectiveTheme === 'dark';
      document.querySelectorAll('.msg-avatar[data-emoji], .ti-waiting-agent[data-emoji]').forEach(el => {
        const emoji = el.getAttribute('data-emoji');
        const styles = window.AcbUtils.getEmojiStyledBackground(emoji, isDark);
        el.style.background = styles.bg;
        el.style.border = `1px solid ${styles.border}`;
      });
      // Also update agent status items (custom elements will handle their own update via attribute or event)
      document.querySelectorAll('acb-agent-status-item').forEach(el => {
        if (typeof el._render === 'function') el._render();
      });
    }

    // Re-render any existing mermaid diagrams with the new theme
    if (window.AcbMessageRenderer && window.AcbMessageRenderer.reRenderAllMermaidBlocks) {
      window.AcbMessageRenderer.reRenderAllMermaidBlocks();
    }
  }

  function applySavedTheme() {
    const savedTheme = localStorage.getItem("agentchatbus-theme") || "dark";
    setTheme(savedTheme);
  }

  function toggleTheme() {
    const current = document.body.getAttribute("data-theme") || "dark";
    setTheme(current === "light" ? "dark" : "light");
  }

  window.AcbTheme = {
    applySavedTheme,
    setTheme,
    toggleTheme,
  };
})();
