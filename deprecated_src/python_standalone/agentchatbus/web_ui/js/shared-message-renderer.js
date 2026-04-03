(function () {
  function normalizeMessageText(raw) {
    if (raw == null) return "";
    if (typeof raw !== "string") return String(raw);

    const s = raw.trim();
    if (!((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}")))) {
      return raw;
    }

    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) {
        const texts = [];
        for (const item of v) {
          if (!item || typeof item !== "object") continue;
          if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
        }
        if (texts.length) return texts.join("\n");
      }
    } catch {
      // Ignore non-JSON values.
    }
    return raw;
  }

  function tokenizeMessage(rawText) {
    const text = normalizeMessageText(rawText);
    const lines = String(text ?? "").split("\n");
    const tokens = [];

    let inCode = false;
    let codeLang = null;
    let codeLines = [];
    let textLines = [];

    function flushText() {
      if (!textLines.length) return;
      tokens.push({ type: "text", text: textLines.join("\n") });
      textLines = [];
    }

    function flushCode() {
      tokens.push({ type: "code_block", code: codeLines.join("\n"), lang: codeLang });
      codeLines = [];
      codeLang = null;
    }

    for (const line of lines) {
      const m = line.match(/^```(\S*)\s*$/);
      if (m) {
        if (!inCode) {
          flushText();
          inCode = true;
          codeLang = m[1] || null;
        } else {
          flushCode();
          inCode = false;
        }
        continue;
      }

      if (inCode) codeLines.push(line);
      else textLines.push(line);
    }

    if (inCode) {
      textLines.push("```" + (codeLang || ""));
      textLines.push(...codeLines);
    }
    flushText();

    return tokens;
  }

  function parseInlineCodeSegments(line) {
    const segs = [];
    let i = 0;
    while (i < line.length) {
      const start = line.indexOf("`", i);
      if (start === -1) {
        segs.push({ type: "text", text: line.slice(i) });
        break;
      }
      const end = line.indexOf("`", start + 1);
      if (end === -1) {
        segs.push({ type: "text", text: line.slice(i) });
        break;
      }
      if (start > i) segs.push({ type: "text", text: line.slice(i, start) });
      segs.push({ type: "inline_code", text: line.slice(start + 1, end) });
      i = end + 1;
    }
    return segs;
  }

  function esc(s) {
    if (window.AcbUtils && window.AcbUtils.esc) return window.AcbUtils.esc(s);
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/~~(.+?)~~/g, '<del>$1</del>');
  }

  function renderMarkdownToHTML(raw) {
    const s = String(raw ?? '');
    const lines = s.split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      if (line.trimStart().startsWith('```')) {
        const codeLines = [];
        i++;
        while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
          codeLines.push(esc(lines[i]));
          i++;
        }
        i++;
        out.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
        continue;
      }

      // Table: header row followed by separator row
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*[-:]+[-|:\s]+$/.test(lines[i + 1])) {
        const headerCells = line.split('|').map(c => c.trim()).filter(c => c !== '');
        let html = '<table><thead><tr>';
        headerCells.forEach(c => { html += `<th>${inlineMd(esc(c))}</th>`; });
        html += '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          const cells = lines[i].split('|').map(c => c.trim()).filter(c => c !== '');
          html += '<tr>';
          cells.forEach(c => { html += `<td>${inlineMd(esc(c))}</td>`; });
          html += '</tr>';
          i++;
        }
        out.push(html + '</tbody></table>');
        continue;
      }

      // Heading
      const hm = line.match(/^(#{1,6})\s+(.+)$/);
      if (hm) {
        const lvl = hm[1].length;
        out.push(`<h${lvl}>${inlineMd(esc(hm[2]))}</h${lvl}>`);
        i++;
        continue;
      }

      // Horizontal rule
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
        out.push('<hr/>');
        i++;
        continue;
      }

      // Unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        out.push('<ul>');
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          out.push(`<li>${inlineMd(esc(lines[i].replace(/^\s*[-*+]\s+/, '')))}</li>`);
          i++;
        }
        out.push('</ul>');
        continue;
      }

      // Ordered list
      if (/^\s*\d+[.)]\s+/.test(line)) {
        out.push('<ol>');
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          out.push(`<li>${inlineMd(esc(lines[i].replace(/^\s*\d+[.)]\s+/, '')))}</li>`);
          i++;
        }
        out.push('</ol>');
        continue;
      }

      // Blockquote
      if (/^\s*>/.test(line)) {
        const bqLines = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          bqLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${bqLines.map(l => inlineMd(esc(l))).join('<br/>')}</blockquote>`);
        continue;
      }

      // Empty line
      if (line.trim() === '') {
        out.push('<br/>');
        i++;
        continue;
      }

      // Regular paragraph line
      out.push(inlineMd(esc(line)));
      if (i + 1 < lines.length && lines[i + 1].trim() !== '') out.push('<br/>');
      i++;
    }

    return out.join('\n');
  }

  function renderTextWithMarkdown(containerEl, text) {
    const htmlStr = renderMarkdownToHTML(text);
    containerEl.insertAdjacentHTML("beforeend", htmlStr);
  }

  const MERMAID_ORIENTATION_RE = /^(\s*(graph|flowchart))(\s+(TD|TB|LR|RL))?\b/i;

  function getMermaidOrientationState(code) {
    const match = String(code ?? "").match(MERMAID_ORIENTATION_RE);
    if (!match) return null;
    const dir = (match[4] || "TD").toUpperCase();
    return {
      keyword: match[1],
      dir,
      isHorizontal: dir === "LR" || dir === "RL",
      isReverse: dir === "RL" || dir === "TB",
      label: dir === "LR" || dir === "RL" ? "Horizontal" : "Vertical",
      explicit: Boolean(match[4]),
    };
  }

  function getMermaidCodeForOrientation(code, targetOrientation) {
    const state = getMermaidOrientationState(code);
    if (!state) return String(code ?? "");

    const nextDir = targetOrientation === "horizontal"
      ? (state.isReverse ? "RL" : "LR")
      : (state.isReverse ? "TB" : "TD");

    return String(code ?? "").replace(MERMAID_ORIENTATION_RE, `$1 ${nextDir}`);
  }

  function toggleMermaidOrientation(code) {
    const state = getMermaidOrientationState(code);
    if (!state) return String(code ?? "");
    return getMermaidCodeForOrientation(code, state.isHorizontal ? "vertical" : "horizontal");
  }

  function canToggleMermaidOrientation(code) {
    return Boolean(getMermaidOrientationState(code));
  }

  function getMermaidOrientationButtonLabel(code) {
    const state = getMermaidOrientationState(code);
    return state ? state.label : "Vertical";
  }

  function getMermaidOrientationTooltip(code) {
    const state = getMermaidOrientationState(code);
    if (!state) {
      return "Orientation toggle is available for graph/flowchart diagrams. This diagram type keeps its own layout.";
    }
    const nextLabel = state.isHorizontal ? "Vertical" : "Horizontal";
    if (state.explicit) {
      return `Current orientation: ${state.label}. Click to switch to ${nextLabel}.`;
    }
    return `No direction was declared in the diagram source. Using ${state.label} by default. Click to switch to ${nextLabel}.`;
  }

  async function renderSingleMermaidDiagram(diagramDiv, code) {
    diagramDiv.innerHTML = "";
    diagramDiv.textContent = code;
    diagramDiv.removeAttribute("data-processed");
    diagramDiv.classList.remove("mermaid-error");

    try {
      await mermaid.run({ nodes: [diagramDiv] });
    } catch {
      if (!diagramDiv.querySelector("svg")) {
        diagramDiv.classList.add("mermaid-error");
        diagramDiv.setAttribute("data-processed", "true");
      }
    }
  }

  function getMermaidScriptUrl() {
    const scriptEl = document.querySelector('script[src*="mermaid.min.js"]');
    return scriptEl?.src || "/static/js/vendor/mermaid.min.js";
  }

  function getTooltipScriptUrl() {
    const scriptEl = document.querySelector('script[src*="shared-tooltip.js"]');
    return scriptEl?.src || "/static/js/shared-tooltip.js";
  }

  function buildMermaidViewerHtml(initialCode, theme) {
    const safeTheme = theme === "light" ? "light" : "dark";
    const safeCode = JSON.stringify(String(initialCode ?? "")).replace(/</g, "\\u003c");
    const safeMermaidScriptUrl = JSON.stringify(getMermaidScriptUrl()).replace(/</g, "\\u003c");
    const safeTooltipScriptUrl = JSON.stringify(getTooltipScriptUrl()).replace(/</g, "\\u003c");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mermaid Diagram</title>
  <style>
    :root {
      color-scheme: dark;
      --viewer-bg: #0b1220;
      --viewer-panel: #111a2c;
      --viewer-panel-2: #172136;
      --viewer-border: rgba(148, 163, 184, 0.24);
      --viewer-text: #e2e8f0;
      --viewer-text-muted: #94a3b8;
      --viewer-btn-bg: rgba(30, 41, 59, 0.88);
      --viewer-btn-hover: rgba(37, 99, 235, 0.18);
      --viewer-btn-active: rgba(37, 99, 235, 0.3);
      --viewer-btn-active-border: rgba(96, 165, 250, 0.85);
      --viewer-canvas: #0f172a;
      --viewer-canvas-shell: rgba(15, 23, 42, 0.72);
      --viewer-source-bg: rgba(15, 23, 42, 0.78);
      --viewer-shadow: 0 28px 80px rgba(2, 6, 23, 0.45);
    }

    body[data-theme="light"] {
      color-scheme: light;
      --viewer-bg: #edf3fb;
      --viewer-panel: rgba(255, 255, 255, 0.92);
      --viewer-panel-2: #f8fbff;
      --viewer-border: rgba(148, 163, 184, 0.35);
      --viewer-text: #0f172a;
      --viewer-text-muted: #475569;
      --viewer-btn-bg: rgba(226, 232, 240, 0.95);
      --viewer-btn-hover: rgba(59, 130, 246, 0.14);
      --viewer-btn-active: rgba(59, 130, 246, 0.18);
      --viewer-btn-active-border: rgba(37, 99, 235, 0.75);
      --viewer-canvas: #ffffff;
      --viewer-canvas-shell: rgba(248, 250, 252, 0.88);
      --viewer-source-bg: #f8fafc;
      --viewer-shadow: 0 24px 70px rgba(15, 23, 42, 0.12);
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      font-family: Inter, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top, rgba(59, 130, 246, 0.12), transparent 28%),
        linear-gradient(180deg, var(--viewer-bg), color-mix(in srgb, var(--viewer-bg) 85%, #000000 15%));
      color: var(--viewer-text);
      padding: 24px;
    }

    .viewer-shell {
      width: min(1440px, 100%);
      margin: 0 auto;
      background: var(--viewer-panel);
      border: 1px solid var(--viewer-border);
      border-radius: 18px;
      box-shadow: var(--viewer-shadow);
      overflow: hidden;
      backdrop-filter: blur(16px);
    }

    .viewer-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--viewer-border);
      background: var(--viewer-panel-2);
    }

    .viewer-title {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--viewer-text-muted);
    }

    .viewer-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    }

    .viewer-btn {
      appearance: none;
      border: 1px solid var(--viewer-border);
      background: var(--viewer-btn-bg);
      color: var(--viewer-text);
      border-radius: 10px;
      padding: 7px 12px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: background .15s ease, border-color .15s ease, color .15s ease, transform .15s ease;
    }

    .viewer-btn:hover {
      background: var(--viewer-btn-hover);
      border-color: var(--viewer-btn-active-border);
      color: var(--viewer-text);
      transform: translateY(-1px);
    }

    .viewer-btn.is-active {
      background: var(--viewer-btn-active);
      border-color: var(--viewer-btn-active-border);
      color: var(--viewer-text);
    }

    .viewer-btn:disabled {
      opacity: 0.46;
      cursor: not-allowed;
      transform: none;
    }

    .viewer-btn svg {
      width: 15px;
      height: 15px;
      flex-shrink: 0;
      pointer-events: none;
    }

    .viewer-canvas {
      padding: 24px;
      overflow: auto;
      background: var(--viewer-canvas-shell);
    }

    .viewer-diagram {
      display: flex;
      justify-content: center;
      align-items: flex-start;
      min-height: calc(100vh - 180px);
      background: var(--viewer-canvas);
      border: 1px solid var(--viewer-border);
      border-radius: 16px;
      padding: 28px;
      overflow: auto;
    }

    .viewer-diagram svg {
      max-width: none;
      height: auto;
    }

    .viewer-source {
      display: none;
      margin: 0 24px 24px;
      padding: 16px;
      border: 1px solid var(--viewer-border);
      border-radius: 14px;
      background: var(--viewer-source-bg);
      overflow: auto;
    }

    .viewer-source pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: "JetBrains Mono", Consolas, monospace;
      font-size: 12px;
      line-height: 1.6;
      color: var(--viewer-text);
    }

    .viewer-help {
      padding: 0 24px 24px;
      font-size: 12px;
      color: var(--viewer-text-muted);
    }

    .viewer-error {
      color: #ef4444;
      font-family: "JetBrains Mono", Consolas, monospace;
      white-space: pre-wrap;
      padding: 12px;
      border-radius: 10px;
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.28);
    }

    @media (max-width: 720px) {
      body { padding: 12px; }
      .viewer-toolbar { align-items: flex-start; flex-direction: column; }
      .viewer-actions { width: 100%; justify-content: flex-start; }
      .viewer-canvas { padding: 12px; }
      .viewer-diagram { min-height: 60vh; padding: 16px; }
      .viewer-source { margin: 0 12px 12px; }
      .viewer-help { padding: 0 12px 12px; }
    }
  </style>
</head>
<body data-theme="${safeTheme}">
  <div class="viewer-shell">
    <div class="viewer-toolbar">
      <div class="viewer-title">Mermaid Diagram Viewer</div>
      <div class="viewer-actions">
        <button type="button" id="viewer-theme-toggle" class="viewer-btn" aria-label="Switch theme">
          <svg id="viewer-theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="5"></circle>
            <line x1="12" y1="1" x2="12" y2="3"></line>
            <line x1="12" y1="21" x2="12" y2="23"></line>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
            <line x1="1" y1="12" x2="3" y2="12"></line>
            <line x1="21" y1="12" x2="23" y2="12"></line>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
          </svg>
          <svg id="viewer-theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:none">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
          </svg>
        </button>
        <button type="button" id="viewer-orientation-toggle" class="viewer-btn">Vertical</button>
        <button type="button" id="viewer-copy" class="viewer-btn">Copy</button>
        <button type="button" id="viewer-source-toggle" class="viewer-btn">Source</button>
      </div>
    </div>
    <div class="viewer-canvas">
      <div id="viewer-diagram" class="viewer-diagram"></div>
    </div>
    <div id="viewer-source" class="viewer-source"><pre id="viewer-source-code"></pre></div>
    <div class="viewer-help">This viewer is front-end only. It does not change chat history or save anything to the database.</div>
  </div>
  <script src=${safeMermaidScriptUrl}></script>
  <script src=${safeTooltipScriptUrl}></script>
  <script>
    (function () {
      if (window.AcbTooltip && typeof window.AcbTooltip.init === "function") {
        window.AcbTooltip.init();
      }

      const themeToggleBtn = document.getElementById("viewer-theme-toggle");
      const themeIconSun = document.getElementById("viewer-theme-icon-sun");
      const themeIconMoon = document.getElementById("viewer-theme-icon-moon");
      const sourceToggleBtn = document.getElementById("viewer-source-toggle");
      const copyBtn = document.getElementById("viewer-copy");
      const orientationToggleBtn = document.getElementById("viewer-orientation-toggle");
      const sourceBox = document.getElementById("viewer-source");
      const sourceCodeEl = document.getElementById("viewer-source-code");
      const diagramEl = document.getElementById("viewer-diagram");

      const ORIENTATION_RE = /^(\\s*(graph|flowchart))(\\s+(TD|TB|LR|RL))?\\b/i;
      let currentCode = ${safeCode};

      function getOrientationState(code) {
        const match = String(code || "").match(ORIENTATION_RE);
        if (!match) return null;
        const dir = (match[4] || "TD").toUpperCase();
        return {
          dir,
          isHorizontal: dir === "LR" || dir === "RL",
          isReverse: dir === "RL" || dir === "TB",
          label: dir === "LR" || dir === "RL" ? "Horizontal" : "Vertical",
          explicit: Boolean(match[4]),
        };
      }

      function getCodeForOrientation(code, targetOrientation) {
        const state = getOrientationState(code);
        if (!state) return String(code || "");
        const nextDir = targetOrientation === "horizontal"
          ? (state.isReverse ? "RL" : "LR")
          : (state.isReverse ? "TB" : "TD");
        return String(code || "").replace(ORIENTATION_RE, "$1 " + nextDir);
      }

      function toggleOrientation(code) {
        const state = getOrientationState(code);
        if (!state) return String(code || "");
        return getCodeForOrientation(code, state.isHorizontal ? "vertical" : "horizontal");
      }

      function getOrientationButtonLabel(code) {
        const state = getOrientationState(code);
        return state ? state.label : "Vertical";
      }

      function getOrientationTooltip(code) {
        const state = getOrientationState(code);
        if (!state) {
          return "Orientation toggle is available for graph/flowchart diagrams. This diagram type keeps its own layout.";
        }
        const nextLabel = state.isHorizontal ? "Vertical" : "Horizontal";
        if (state.explicit) {
          return "Current orientation: " + state.label + ". Click to switch to " + nextLabel + ".";
        }
        return "No direction was declared in the diagram source. Using " + state.label + " by default. Click to switch to " + nextLabel + ".";
      }

      function setTooltip(el, text) {
        if (!el) return;
        if (window.AcbTooltip && typeof window.AcbTooltip.setTooltip === "function") {
          window.AcbTooltip.setTooltip(el, text);
        } else {
          el.setAttribute("data-tooltip", text || "");
        }
      }

      function refreshButtons() {
        const canToggle = Boolean(getOrientationState(currentCode));
        orientationToggleBtn.textContent = getOrientationButtonLabel(currentCode);
        orientationToggleBtn.disabled = !canToggle;
        orientationToggleBtn.setAttribute("aria-disabled", canToggle ? "false" : "true");
        orientationToggleBtn.classList.toggle("is-active", canToggle);
        setTooltip(orientationToggleBtn, getOrientationTooltip(currentCode));
      }

      function refreshThemeButton() {
        const isLight = document.body.getAttribute("data-theme") === "light";
        if (themeIconSun) themeIconSun.style.display = isLight ? "none" : "";
        if (themeIconMoon) themeIconMoon.style.display = isLight ? "" : "none";
        const tooltip = isLight ? "Switch viewer to dark theme" : "Switch viewer to light theme";
        themeToggleBtn.title = tooltip;
        themeToggleBtn.setAttribute("aria-label", tooltip);
        setTooltip(themeToggleBtn, tooltip);
      }

      async function renderDiagram() {
        sourceCodeEl.textContent = currentCode;
        refreshButtons();
        refreshThemeButton();
        diagramEl.classList.remove("viewer-error");
        diagramEl.innerHTML = "";
        diagramEl.textContent = currentCode;
        diagramEl.removeAttribute("data-processed");
        try {
          const mermaidTheme = document.body.getAttribute("data-theme") === "light" ? "default" : "dark";
          window.mermaid.initialize({ startOnLoad: false, theme: mermaidTheme, securityLevel: "strict" });
          await window.mermaid.run({ nodes: [diagramEl] });
        } catch {
          if (!diagramEl.querySelector("svg")) {
            diagramEl.classList.add("viewer-error");
            diagramEl.setAttribute("data-processed", "true");
          }
        }
      }

      async function copyCurrentCode() {
        try {
          await navigator.clipboard.writeText(currentCode);
          return true;
        } catch {
          const textarea = document.createElement("textarea");
          textarea.value = currentCode;
          textarea.setAttribute("readonly", "readonly");
          textarea.style.position = "fixed";
          textarea.style.left = "-9999px";
          document.body.appendChild(textarea);
          textarea.select();
          let ok = false;
          try {
            ok = document.execCommand("copy");
          } catch {
            ok = false;
          }
          textarea.remove();
          return ok;
        }
      }

      function flashButton(btn, okText) {
        const original = btn.textContent;
        btn.textContent = okText;
        btn.disabled = true;
        window.setTimeout(() => {
          btn.textContent = original;
          btn.disabled = false;
        }, 1200);
      }

      orientationToggleBtn.addEventListener("click", async () => {
        if (orientationToggleBtn.disabled) return;
        currentCode = toggleOrientation(currentCode);
        await renderDiagram();
      });

      themeToggleBtn.addEventListener("click", async () => {
        const nextTheme = document.body.getAttribute("data-theme") === "light" ? "dark" : "light";
        document.body.setAttribute("data-theme", nextTheme);
        await renderDiagram();
      });

      copyBtn.addEventListener("click", async () => {
        const ok = await copyCurrentCode();
        flashButton(copyBtn, ok ? "Copied" : "Failed");
      });

      setTooltip(copyBtn, "Copy the current Mermaid source");
      setTooltip(sourceToggleBtn, "Toggle between diagram and source view");

      sourceToggleBtn.addEventListener("click", () => {
        const hidden = sourceBox.style.display === "none" || !sourceBox.style.display;
        sourceBox.style.display = hidden ? "block" : "none";
        sourceToggleBtn.textContent = hidden ? "Diagram" : "Source";
      });

      window.opener = null;
      void renderDiagram();
    })();
  </script>
</body>
</html>`;
  }

  function openMermaidViewer(code) {
    const viewerWindow = window.open("", "_blank");
    if (!viewerWindow) return false;

    const theme = document.body.getAttribute("data-theme") === "light" ? "light" : "dark";
    viewerWindow.document.open();
    viewerWindow.document.write(buildMermaidViewerHtml(code, theme));
    viewerWindow.document.close();
    return true;
  }

  function renderMessageContent(containerEl, rawText, metadata = null) {
    containerEl.textContent = "";
    const tokens = tokenizeMessage(rawText);

    // Parse mentions from metadata for the pill-rendering logic
    let mentions = [];
    let mentionLabels = {};
    if (metadata) {
      const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
      mentions = meta.mentions || [];
      mentionLabels = meta.mention_labels || {};
    }

    for (const tok of tokens) {
      if (tok.type === "code_block") {
        const codeText = tok.code || "";

        // ── Mermaid diagram rendering ──
        if (tok.lang === "mermaid" && window.mermaid) {
          let currentCode = codeText;
          const mermaidBlock = document.createElement("div");
          mermaidBlock.className = "mermaid-block";

          const toolbarDiv = document.createElement("div");
          toolbarDiv.className = "mermaid-toolbar";

          const diagramDiv = document.createElement("div");
          diagramDiv.className = "mermaid";
          diagramDiv.textContent = currentCode;

          const sourceCode = document.createElement("code");

          const orientationToggleBtn = document.createElement("button");
          orientationToggleBtn.type = "button";
          orientationToggleBtn.className = "mermaid-btn";

          function syncOrientationButtons() {
            const canToggle = canToggleMermaidOrientation(currentCode);
            orientationToggleBtn.textContent = getMermaidOrientationButtonLabel(currentCode);
            orientationToggleBtn.disabled = !canToggle;
            orientationToggleBtn.setAttribute("aria-disabled", canToggle ? "false" : "true");
            orientationToggleBtn.classList.toggle("is-active", canToggle);
            if (window.AcbTooltip && typeof window.AcbTooltip.setTooltip === "function") {
              window.AcbTooltip.setTooltip(orientationToggleBtn, getMermaidOrientationTooltip(currentCode));
            } else {
              orientationToggleBtn.setAttribute("data-tooltip", getMermaidOrientationTooltip(currentCode));
            }
          }

          // Orientation toggle (single-button; flowchart/graph defaults to Vertical if direction omitted)
          orientationToggleBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (orientationToggleBtn.disabled) return;
            currentCode = toggleMermaidOrientation(currentCode);
            sourceCode.textContent = currentCode;
            syncOrientationButtons();
            await renderSingleMermaidDiagram(diagramDiv, currentCode);
          });

          syncOrientationButtons();
          toolbarDiv.appendChild(orientationToggleBtn);

          // Copy button
          const copyBtn = document.createElement("button");
          copyBtn.type = "button";
          copyBtn.className = "mermaid-btn";
          copyBtn.textContent = "Copy";
          if (window.AcbTooltip && typeof window.AcbTooltip.setTooltip === "function") {
            window.AcbTooltip.setTooltip(copyBtn, "Copy the current Mermaid source");
          } else {
            copyBtn.setAttribute("data-tooltip", "Copy the current Mermaid source");
          }
          copyBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const original = copyBtn.textContent;
            const ok = await window.AcbUtils.copyTextWithFallback(currentCode);
            copyBtn.textContent = ok ? "Copied" : "Failed";
            if (ok) copyBtn.disabled = true;
            setTimeout(() => {
              copyBtn.textContent = original;
              copyBtn.disabled = false;
            }, 1200);
          });
          toolbarDiv.appendChild(copyBtn);

          const openBtn = document.createElement("button");
          openBtn.type = "button";
          openBtn.className = "mermaid-btn";
          openBtn.textContent = "New Tab";
          if (window.AcbTooltip && typeof window.AcbTooltip.setTooltip === "function") {
            window.AcbTooltip.setTooltip(openBtn, "Open this diagram in a larger viewer tab");
          } else {
            openBtn.setAttribute("data-tooltip", "Open this diagram in a larger viewer tab");
          }
          openBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const original = openBtn.textContent;
            const ok = openMermaidViewer(currentCode);
            openBtn.textContent = ok ? "Opened" : "Blocked";
            if (ok) openBtn.disabled = true;
            setTimeout(() => {
              openBtn.textContent = original;
              openBtn.disabled = false;
            }, 1200);
          });
          toolbarDiv.appendChild(openBtn);

          // Source toggle button
          const sourceToggleBtn = document.createElement("button");
          sourceToggleBtn.type = "button";
          sourceToggleBtn.className = "mermaid-btn";
          sourceToggleBtn.textContent = "Source";
          if (window.AcbTooltip && typeof window.AcbTooltip.setTooltip === "function") {
            window.AcbTooltip.setTooltip(sourceToggleBtn, "Toggle between diagram and source view");
          } else {
            sourceToggleBtn.setAttribute("data-tooltip", "Toggle between diagram and source view");
          }
          
          const sourceDiv = document.createElement("div");
          sourceDiv.className = "mermaid-source";
          sourceDiv.style.display = "none";
          const sourcePre = document.createElement("pre");
          
          sourceCode.textContent = currentCode;
          sourcePre.appendChild(sourceCode);
          sourceDiv.appendChild(sourcePre);

          sourceToggleBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const hidden = sourceDiv.style.display === "none";
            sourceDiv.style.display = hidden ? "block" : "none";
            sourceToggleBtn.textContent = hidden ? "Diagram" : "Source";
          });
          toolbarDiv.appendChild(sourceToggleBtn);

          mermaidBlock.appendChild(toolbarDiv);
          mermaidBlock.appendChild(diagramDiv);
          mermaidBlock.appendChild(sourceDiv);
          containerEl.appendChild(mermaidBlock);
          continue;
        }

        // ── Normal code block ──
        const wrap = document.createElement("div");
        wrap.className = "code-block";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "code-copy";
        btn.textContent = "Copy";
        btn.setAttribute("aria-label", "Copy code");

        const pre = document.createElement("pre");
        const code = document.createElement("code");
        if (tok.lang) code.setAttribute("data-lang", tok.lang);
        code.textContent = codeText;
        pre.appendChild(code);

        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const original = btn.textContent;
          const ok = await window.AcbUtils.copyTextWithFallback(codeText);
          btn.textContent = ok ? "Copied" : "Failed";
          if (ok) btn.disabled = true;
          setTimeout(() => {
            btn.textContent = original;
            btn.disabled = false;
          }, 1200);
        });

        wrap.appendChild(btn);
        wrap.appendChild(pre);
        containerEl.appendChild(wrap);
      } else {
        // High-quality mention pill rendering
        const text = tok.text;
        const html = renderMarkdownToHTML(text);

        // Wrap the HTML in a temporary element to process mentions
        const temp = document.createElement("div");
        temp.innerHTML = html;

        // Find and replace @Mentions with pills if they exist in metadata
        if (Object.keys(mentionLabels).length > 0) {
          // Identify all labels we know about
          const labels = Object.values(mentionLabels);
          if (labels.length > 0) {
            // Simple regex for all @Nickname occurrences
            // Note: This is an approximation. Reliable matching usually requires more metadata about positions.
            // But this matches the user request for "carrying names".

            // Create a map of Label -> ID for reverse lookup
            const labelToId = {};
            for (const [id, label] of Object.entries(mentionLabels)) {
              labelToId[label] = id;
            }

            // Correctly handle multiple mentions in text nodes without breaking the walker
            const walker = document.createTreeWalker(temp, NodeFilter.SHOW_TEXT);
            const textNodes = [];
            let n;
            while (n = walker.nextNode()) textNodes.push(n);

            // Regex that matches any of our known labels
            const escapedLabels = labels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            // Sort long labels first for correct matching
            escapedLabels.sort((a, b) => b.length - a.length);
            const regex = new RegExp(`@(${escapedLabels.join('|')})`, 'g');

            for (const textNode of textNodes) {
              const text = textNode.textContent;
              let lastIndex = 0;
              let match;
              let hasMatch = false;
              const fragment = document.createDocumentFragment();

              while ((match = regex.exec(text)) !== null) {
                hasMatch = true;
                // Text before the mention
                if (match.index > lastIndex) {
                  fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
                }

                // The mention pill
                const matchedLabel = match[1];
                const mid = labelToId[matchedLabel];
                const pill = document.createElement('span');
                pill.className = 'mention-pill-sent';
                pill.style.cssText = 'background: rgba(59,130,246,0.15); color: #3b82f6; padding: 1px 5px; border-radius: 4px; margin: 0 2px; font-weight: 500; border: 1px solid rgba(59,130,246,0.3); font-size: 0.95em; cursor: default;';
                pill.textContent = match[0];
                pill.title = `Agent ID: ${mid}`;
                fragment.appendChild(pill);

                lastIndex = regex.lastIndex;
              }

              if (hasMatch) {
                // Remaining text
                if (lastIndex < text.length) {
                  fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
                }
                textNode.parentNode.replaceChild(fragment, textNode);
              }
            }
          }
        }

        while (temp.firstChild) {
          containerEl.appendChild(temp.firstChild);
        }
      }
    }
  }

  async function renderMermaidBlocks(root) {
    if (!window.mermaid) return;
    
    // Always sync theme right before parsing
    const mermaidTheme = document.body.getAttribute('data-theme') === 'light' ? 'default' : 'dark';
    mermaid.initialize({ startOnLoad: false, theme: mermaidTheme, securityLevel: 'strict' });

    const container = root || document;
    const nodes = container.querySelectorAll(".mermaid:not([data-processed])");
    if (!nodes.length) return;
    try {
      await mermaid.run({ nodes: Array.from(nodes) });
    } catch {
      // On bulk failure, mark each as error fallback
      nodes.forEach((el) => {
        if (!el.querySelector("svg")) {
          el.classList.add("mermaid-error");
          el.setAttribute("data-processed", "true");
        }
      });
    }
  }

  async function reRenderAllMermaidBlocks() {
    if (!window.mermaid) return;
    const blocks = document.querySelectorAll(".mermaid-block");
    if (!blocks.length) return;

    // Force theme initialization
    const mermaidTheme = document.body.getAttribute('data-theme') === 'light' ? 'default' : 'dark';
    mermaid.initialize({ startOnLoad: false, theme: mermaidTheme, securityLevel: 'strict' });

    const nodesToRun = [];
    blocks.forEach(block => {
      const diagramDiv = block.querySelector(".mermaid");
      const sourceCode = block.querySelector(".mermaid-source code");
      if (diagramDiv && sourceCode) {
        diagramDiv.innerHTML = "";
        diagramDiv.textContent = sourceCode.textContent;
        diagramDiv.removeAttribute("data-processed");
        diagramDiv.classList.remove("mermaid-error");
        nodesToRun.push(diagramDiv);
      }
    });

    if (nodesToRun.length) {
      try {
        await mermaid.run({ nodes: nodesToRun });
      } catch {
        nodesToRun.forEach(el => {
          if (!el.querySelector("svg")) {
            el.classList.add("mermaid-error");
            el.setAttribute("data-processed", "true");
          }
        });
      }
    }
  }

  window.AcbMessageRenderer = {
    normalizeMessageText,
    tokenizeMessage,
    parseInlineCodeSegments,
    renderTextWithMarkdown,
    renderMessageContent,
    renderMermaidBlocks,
    reRenderAllMermaidBlocks,
    esc,
    inlineMd,
    renderMarkdownToHTML,
  };
})();
