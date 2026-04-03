(function () {

  function escapeHtml(text) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(text).replace(/[&<>"']/g, (ch) => map[ch]);
  }

  function esc(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function fmtTime(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function timeAgo(iso) {
    if (!iso) return "";
    const diff = (Date.now() - new Date(iso)) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return new Date(iso).toLocaleDateString();
  }

  function autoResize(el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }

  async function copyTextWithFallback(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "readonly");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  // ---- Color palette: 12 distinct, accessible hues ----------------------------------------------------
  const AUTHOR_PALETTE = [
    "#60a5fa", // blue
    "#34d399", // emerald
    "#f472b6", // pink
    "#fb923c", // orange
    "#a78bfa", // purple
    "#22d3ee", // cyan
    "#facc15", // yellow
    "#f87171", // red
    "#4ade80", // green
    "#38bdf8", // sky
    "#e879f9", // fuchsia
    "#a3e635", // lime
  ];
  const HUMAN_COLOR = "#fb923c"; // warm orange — always human
  const SYSTEM_COLOR = "#fbbf24"; // amber — system events
  const _colorCache = {};

  function getBackendAgentEmoji(input) {
    const provided =
      input && typeof input === "object"
        ? String(input.emoji || input.author_emoji || "").trim()
        : "";
    if (provided) return provided;

    const key = typeof input === "string" ? String(input).trim() : "";
    const lower = key.toLowerCase();
    if (lower === "human") return "👤";
    if (lower === "system") return "⚙️";
    return "🤖";
  }

  function authorColor(author) {
    if (author === "human") return HUMAN_COLOR;
    if (author === "system") return SYSTEM_COLOR;
    if (_colorCache[author]) return _colorCache[author];

    let h = 0;
    for (let i = 0; i < author.length; i++) {
      h = (Math.imul(31, h) + author.charCodeAt(i)) | 0;
    }
    const color = AUTHOR_PALETTE[Math.abs(h) % AUTHOR_PALETTE.length];
    _colorCache[author] = color;
    return color;
  }

  const _emojiAnalysisCache = {};
  /**
   * Analyzes an emoji by rendering it to a small canvas and calculating 
   * its average brightness and dominant colors.
   */
  function getEmojiAnalysis(emoji) {
    if (!emoji) return { brightness: 128, color: "transparent" };
    if (_emojiAnalysisCache[emoji]) return _emojiAnalysisCache[emoji];

    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { brightness: 128, color: "transparent" };

    // Standard emoji font stack for consistency (mostly uses system default)
    ctx.font = '24px "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(emoji, 16, 16);

    const data = ctx.getImageData(0, 0, 32, 32).data;
    let r = 0, g = 0, b = 0, a = 0;
    let count = 0;
    let lum = 0;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha > 40) { // Count visible pixels
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        // Relative luminance: https://www.w3.org/TR/WCAG20/#relativeluminancedef
        lum += (0.2126 * data[i]) + (0.7152 * data[i + 1]) + (0.0722 * data[i + 2]);
        count++;
      }
    }

    if (count === 0) return { brightness: 128, color: "transparent" };

    const avgR = Math.round(r / count);
    const avgG = Math.round(g / count);
    const avgB = Math.round(b / count);
    const avgLum = lum / count;

    const hex = "#" + ((1 << 24) + (avgR << 16) + (avgG << 8) + avgB).toString(16).slice(1);
    const analysis = { brightness: avgLum, color: hex };
    _emojiAnalysisCache[emoji] = analysis;
    return analysis;
  }

  /**
   * Returns background and border styles for an emoji based on its brightness 
   * and the current theme.
   */
  function getEmojiStyledBackground(emoji, isDark) {
    const analysis = getEmojiAnalysis(emoji);
    let bg, border;
    if (isDark) {
      if (analysis.brightness < 140) {
        // Softened contrast for dark emojis in dark mode
        bg = `linear-gradient(rgba(255,255,255,0.4), rgba(255,255,255,0.4)), ${analysis.color}`;
        border = 'rgba(255, 255, 255, 0.2)';
      } else {
        bg = analysis.color + '22';
        border = analysis.color + '44';
      }
    } else {
      if (analysis.brightness > 180) {
        bg = 'rgba(0, 0, 0, 0.08)';
        border = 'rgba(0, 0, 0, 0.15)';
      } else {
        bg = analysis.color + '15';
        border = analysis.color + '33';
      }
    }
    return { bg, border };
  }

  function shouldGroupWithPrevious(prevAuthorKey, prevTimestamp, currentAuthorKey, currentTimestamp, isSystem, isHuman) {

    if (isSystem || isHuman) return false;
    if (!prevAuthorKey || prevAuthorKey !== currentAuthorKey) return false;
    if (!prevTimestamp || !currentTimestamp) return false;
    const deltaMs = new Date(currentTimestamp) - new Date(prevTimestamp);
    return deltaMs < 5 * 60 * 1000;
  }

  window.AcbUtils = {
    escapeHtml,
    esc,
    fmtTime,
    timeAgo,
    autoResize,
    copyTextWithFallback,
    authorColor,
    getEmojiAnalysis,
    getEmojiStyledBackground,
    getBackendAgentEmoji,
    shouldGroupWithPrevious,
  };
})();
