(function () {
  function setTheme(theme) {
    const effectiveTheme = theme === "light" ? "light" : "dark";
    document.body.setAttribute("data-theme", effectiveTheme);
    const btn = document.getElementById("btn-theme-toggle");
    if (btn) {
      btn.textContent = effectiveTheme === "light" ? "Dark" : "Light";
      btn.title =
        effectiveTheme === "light"
          ? "Switch to dark theme"
          : "Switch to light theme";
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
