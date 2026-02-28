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

  function renderTextWithInlineCode(containerEl, text) {
    const lines = String(text ?? "").split("\n");
    for (let li = 0; li < lines.length; li++) {
      const segs = parseInlineCodeSegments(lines[li]);
      for (const seg of segs) {
        if (seg.type === "inline_code") {
          const code = document.createElement("code");
          code.className = "inline-code";
          code.textContent = seg.text;
          containerEl.appendChild(code);
        } else {
          containerEl.appendChild(document.createTextNode(seg.text));
        }
      }
      if (li !== lines.length - 1) containerEl.appendChild(document.createElement("br"));
    }
  }

  function renderMessageContent(containerEl, rawText) {
    containerEl.textContent = "";
    const tokens = tokenizeMessage(rawText);
    for (const tok of tokens) {
      if (tok.type === "code_block") {
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
        const codeText = tok.code || "";
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
        renderTextWithInlineCode(containerEl, tok.text);
      }
    }
  }

  window.AcbMessageRenderer = {
    normalizeMessageText,
    tokenizeMessage,
    parseInlineCodeSegments,
    renderTextWithInlineCode,
    renderMessageContent,
  };
})();
