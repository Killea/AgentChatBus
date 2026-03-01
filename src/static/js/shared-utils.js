(function () {
  // NOTE: Avatar emojis must not look like status indicators.
  // Avoid: colored circles/dots, hourglass/clock, moon, etc.
  const AGENT_AVATAR_EMOJI_POOL = [
    // animals
    "🦊",
    "🐼",
    "🐸",
    "🐙",
    "🦄",
    "🐯",
    "🦁",
    "🐵",
    "🐧",
    "🐢",
    "🦉",
    "🐳",
    "🐝",
    "🦋",
    "🪲",
    "🦀",
    "🐞",
    "🦎",
    "🐊",
    "🐠",
    "🐬",
    "🦖",
    "🦒",
    "🦓",
    "🦔",
    "🦦",
    "🦥",
    "🦩",
    "🐘",
    "🦛",
    "🐨",
    "🐹",
    "🐰",
    "🐮",
    "🐷",
    "🐔",
    "🐧",
    // plants & nature (avoid moon)
    "🌵",
    "🌲",
    "🌴",
    "🌿",
    "🍄",
    "🪴",
    "🍀",
    // food
    "🍉",
    "🍓",
    "🍒",
    "🍍",
    "🥑",
    "🌽",
    "🍕",
    "🍣",
    "🍜",
    "🍪",
    "🍩",
    "🍫",
    // objects & tools
    "⚡",
    "🔥",
    "💡",
    "🔭",
    "🧪",
    "🧬",
    "🧭",
    "🪐",
    "🛰️",
    "📡",
    "🔧",
    "🛠️",
    "🧰",
    "🧲",
    "🧯",
    "🔒",
    "🔑",
    "📌",
    "📎",
    "📚",
    "🗺️",
    "🧠",
    // games & music
    "🎯",
    "🧩",
    "🎲",
    "♟️",
    "🎸",
    "🎧",
    "🎷",
    // travel & misc
    "🚲",
    "🛶",
    "🏄",
    "🧳",
    "🏺",
    "🪁",
    "🪄",
    "🧵",
    "🧶",
    "🪙",
    "🗝️",
  ];

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

  function stableHash32(value) {
    const s = String(value ?? "");
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return h >>> 0;
  }

  function getAgentAvatarEmoji(input) {
    const key =
      typeof input === "string"
        ? String(input).trim()
        : String(input?.id ?? input?.agent_id ?? input?.name ?? input?.display_name ?? "").trim();

    if (!key) return "🤖";
    const lower = key.toLowerCase();
    if (lower === "human") return "👤";
    if (lower === "system") return "⚙️";

    const idx = stableHash32(key) % AGENT_AVATAR_EMOJI_POOL.length;
    return AGENT_AVATAR_EMOJI_POOL[idx] || "🤖";
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

  window.AcbUtils = {
    escapeHtml,
    esc,
    fmtTime,
    timeAgo,
    autoResize,
    copyTextWithFallback,
    authorColor,
    getAgentAvatarEmoji,
  };
})();
