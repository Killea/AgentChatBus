/**
 * AgentChatBus Consolidated Message Renderer
 * Targets: VS Code Webview Environment
 */

(function () {
  // --- Minimal Utils ---
  const Utils = {
    esc(s) {
      return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
    async copyTextWithFallback(text) {
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
  };

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
          codeLines.push(Utils.esc(lines[i]));
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
        headerCells.forEach(c => { html += `<th>${inlineMd(Utils.esc(c))}</th>`; });
        html += '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          const cells = lines[i].split('|').map(c => c.trim()).filter(c => c !== '');
          html += '<tr>';
          cells.forEach(c => { html += `<td>${inlineMd(Utils.esc(c))}</td>`; });
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
        out.push(`<h${lvl}>${inlineMd(Utils.esc(hm[2]))}</h${lvl}>`);
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
          out.push(`<li>${inlineMd(Utils.esc(lines[i].replace(/^\s*[-*+]\s+/, '')))}</li>`);
          i++;
        }
        out.push('</ul>');
        continue;
      }

      // Ordered list
      if (/^\s*\d+[.)]\s+/.test(line)) {
        out.push('<ol>');
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          out.push(`<li>${inlineMd(Utils.esc(lines[i].replace(/^\s*\d+[.)]\s+/, '')))}</li>`);
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
        out.push(`<blockquote>${bqLines.map(l => inlineMd(Utils.esc(l))).join('<br/>')}</blockquote>`);
        continue;
      }

      // Empty line
      if (line.trim() === '') {
        out.push('<br/>');
        i++;
        continue;
      }

      // Regular paragraph line
      out.push(inlineMd(Utils.esc(line)));
      if (i + 1 < lines.length && lines[i + 1].trim() !== '') out.push('<br/>');
      i++;
    }

    return out.join('\n');
  }

  function renderMessageContent(containerEl, rawText, metadata = null) {
    containerEl.textContent = "";
    const tokens = tokenizeMessage(rawText);

    // Parse mentions from metadata
    let mentionLabels = {};
    if (metadata) {
      const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
      mentionLabels = meta.mention_labels || {};
    }

    for (const tok of tokens) {
      if (tok.type === "code_block") {
        const codeText = tok.code || "";

        // -- Mermaid diagram rendering --
        if (tok.lang === "mermaid") {
          let currentCode = codeText;
          const mermaidBlock = document.createElement("div");
          mermaidBlock.className = "mermaid-block";

          const toolbarDiv = document.createElement("div");
          toolbarDiv.className = "mermaid-toolbar";

          const diagramDiv = document.createElement("div");
          diagramDiv.className = "mermaid";
          diagramDiv.textContent = currentCode;

          const sourceCode = document.createElement("code");

          // Orientation toggle
          let currentOrientationMatch = currentCode.trim().match(/^(graph|flowchart)\s+(TD|TB|LR|RL)\b/i);
          if (currentOrientationMatch) {
            const orientationBtn = document.createElement("button");
            orientationBtn.type = "button";
            orientationBtn.className = "mermaid-btn";
            let dir = currentOrientationMatch[2].toUpperCase();
            orientationBtn.textContent = ["LR", "RL"].includes(dir) ? "Vertical" : "Horizontal";
            
            orientationBtn.addEventListener("click", async (e) => {
              e.preventDefault();
              e.stopPropagation();
              const match = currentCode.trim().match(/^(graph|flowchart)\s+(TD|TB|LR|RL)\b/i);
              if (!match) return;
              const oldDir = match[2].toUpperCase();
              const dirMap = { 'TD': 'LR', 'TB': 'LR', 'LR': 'TD', 'RL': 'TB' };
              const newDir = dirMap[oldDir] || 'LR';
              
              const newText = ["LR", "RL"].includes(newDir) ? "Vertical" : "Horizontal";
              orientationBtn.textContent = newText;
              
              currentCode = currentCode.replace(new RegExp(`^(\\s*${match[1]})\\s+${oldDir}\\b`, 'i'), `$1 ${newDir}`);
              sourceCode.textContent = currentCode;
              
              diagramDiv.innerHTML = "";
              diagramDiv.textContent = currentCode;
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
            });
            toolbarDiv.appendChild(orientationBtn);
          }

          // Copy button
          const copyBtn = document.createElement("button");
          copyBtn.type = "button";
          copyBtn.className = "mermaid-btn";
          copyBtn.textContent = "Copy";
          copyBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const original = copyBtn.textContent;
            const ok = await Utils.copyTextWithFallback(currentCode);
            copyBtn.textContent = ok ? "Copied" : "Failed";
            if (ok) copyBtn.disabled = true;
            setTimeout(() => {
              copyBtn.textContent = original;
              copyBtn.disabled = false;
            }, 1200);
          });
          toolbarDiv.appendChild(copyBtn);

          // Source toggle button
          const sourceToggleBtn = document.createElement("button");
          sourceToggleBtn.type = "button";
          sourceToggleBtn.className = "mermaid-btn";
          sourceToggleBtn.textContent = "Source";
          
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

        // -- Normal code block --
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
          const ok = await Utils.copyTextWithFallback(codeText);
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
        // Markdown + Mentions
        const text = tok.text;
        const html = renderMarkdownToHTML(text);

        const temp = document.createElement("div");
        temp.innerHTML = html;

        // Find and replace @Mentions with pills
        const labels = Object.values(mentionLabels);
        if (labels.length > 0) {
          const labelToId = {};
          for (const [id, label] of Object.entries(mentionLabels)) {
            labelToId[label] = id;
          }

          const walker = document.createTreeWalker(temp, NodeFilter.SHOW_TEXT);
          const textNodes = [];
          let n;
          while (n = walker.nextNode()) textNodes.push(n);

          const escapedLabels = labels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
          escapedLabels.sort((a, b) => b.length - a.length);
          const regex = new RegExp(`@(${escapedLabels.join('|')})`, 'g');

          for (const textNode of textNodes) {
            const textValue = textNode.textContent;
            let lastIndex = 0;
            let match;
            let hasMatch = false;
            const fragment = document.createDocumentFragment();

            while ((match = regex.exec(textValue)) !== null) {
              hasMatch = true;
              if (match.index > lastIndex) {
                fragment.appendChild(document.createTextNode(textValue.substring(lastIndex, match.index)));
              }

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
              if (lastIndex < textValue.length) {
                fragment.appendChild(document.createTextNode(textValue.substring(lastIndex)));
              }
              textNode.parentNode.replaceChild(fragment, textNode);
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
    const mermaidTheme = document.body.getAttribute('data-theme') === 'light' ? 'default' : 'dark';
    mermaid.initialize({ startOnLoad: false, theme: mermaidTheme, securityLevel: 'strict' });

    const container = root || document;
    const nodes = container.querySelectorAll(".mermaid:not([data-processed])");
    if (!nodes.length) return;
    try {
      await mermaid.run({ nodes: Array.from(nodes) });
    } catch {
      nodes.forEach((el) => {
        if (!el.querySelector("svg")) {
          el.classList.add("mermaid-error");
          el.setAttribute("data-processed", "true");
        }
      });
    }
  }

  window.AcbMessageRenderer = {
    renderMessageContent,
    renderMermaidBlocks,
  };
})();
