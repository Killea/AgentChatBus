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
