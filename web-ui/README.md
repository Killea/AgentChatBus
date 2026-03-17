# web-ui

This directory contains the frontend source code for AgentChatBus.  
It currently hosts two related but different UIs:

1. The main Web Console (primary browser UI)
2. The VS Code extension Chat WebView source (browser-debuggable)

This document explains the current architecture, build/sync conventions, debugging workflow, and AI-agent-friendly development rules.

---

## 1) Directory Responsibilities

- `index.html`
  - Main Web Console entry.
  - Served by the Python backend via `GET /`.
- `css/main.css`
  - Main Web Console styles.
- `js/`
  - Main Web Console modular scripts.
  - `js/components/`: Web Components.
  - `js/vendor/`: third-party libraries (for example mermaid, fuse).
- `uploads/`
  - Runtime upload storage (written by backend under `/static/uploads`).
- `extension/`
  - **Source of truth for extension Chat WebView frontend**.
  - Goal: make extension UI directly browser-debuggable, then sync into VSIX resources.

---

## 2) Dual UI Design Contract

### Main Web Console

- Entry: `/` (from `web-ui/index.html`)
- Designed for browser operations and full console experience.
- Must not regress or break when extension UI changes.

### Extension Chat WebView UI

- Source entry: `web-ui/extension/index.html`
- Browser debug entry: `/static/extension/index.html`
- Runtime assets are synced into `vscode-agentchatbus/resources/media/*` for WebView usage.

---

## 3) Extension Asset Sync Pipeline (Important)

Extension-side sync script:

- `vscode-agentchatbus/scripts/sync-webui-assets.mjs`

It runs automatically during `npm run compile` and:

1. Copies extension WebView assets from `web-ui/extension/media/*` to:
   - `vscode-agentchatbus/resources/media/chatPanel.js`
   - `vscode-agentchatbus/resources/media/chatPanel.css`
   - `vscode-agentchatbus/resources/media/messageRenderer.js`
   - `vscode-agentchatbus/resources/media/messageRenderer.css`
   - `vscode-agentchatbus/resources/media/mermaid.min.js`
2. Copies browser-debug helper artifacts to:
   - `vscode-agentchatbus/resources/webui-extension/*`

Conclusion:  
**If you are changing extension UI, edit `web-ui/extension` first. Do not hand-edit `vscode-agentchatbus/resources/media`.**

---

## 4) Debugging Workflow

### A. Debug Main Web Console

1. Start backend service (Python or TS backend).
2. Open `http://127.0.0.1:39765/`.

### B. Browser-Debug Extension UI

1. Open `http://127.0.0.1:39765/static/extension/index.html`.
2. Optional query parameters:
   - `?threadId=<id>`
   - `?baseUrl=http://127.0.0.1:39765`
   - `?theme=dark|light`

Notes:

- `web-ui/extension/media/vscodeBridgeBrowser.js` simulates `acquireVsCodeApi()`.
- In browser mode, message sending, image upload, agent loading, and thread creation are all supported.

### C. Gesture-Based Switching

- From main Web Console:
  - `Ctrl + click backend engine icon 3 times` -> jump to extension debug page.
- From extension debug page:
  - `Ctrl + click header engine icon 3 times` -> return to normal Web Console (`/`).

---

## 5) Extension UI Runtime Constraints

WebView is browser-like, but not identical. Key differences:

1. Resource URLs must be WebView-safe
   - Extension side injects paths via `asWebviewUri(...)`.
2. Extension communication should go through `postMessage`
   - `chatPanel.js` sends commands to Extension Host.
3. Browser debug mode relies on bridge emulation
   - `vscodeBridgeBrowser.js` maps commands to REST calls.

Therefore:

- Keep business/UI logic mostly inside `chatPanel.js`.
- Keep environment-specific behavior in Host/Bridge layers, not scattered conditionals everywhere.

---

## 6) Style and Change Conventions

1. Treat `web-ui/extension` as extension UI source of truth.
2. After changing extension UI, always run:
   - `cd vscode-agentchatbus`
   - `npm run compile`
3. Do not hand-edit `out/` build artifacts.
4. Do not hand-edit `vscode-agentchatbus/resources/media/*` (sync step overwrites these).
5. Main Web Console changes must remain backward-compatible and stable.

---

## 7) AI-Agent-Friendly Development Guide

The most common failure mode is editing the wrong directory. Follow this strictly.

### Recommended Agent Workflow

1. Classify task target first:
   - Main Console: edit `web-ui/index.html`, `web-ui/js/*`, `web-ui/css/main.css`
   - Extension Chat UI: edit `web-ui/extension/*`
2. If extension UI changed:
   - Check whether `vscode-agentchatbus/src/views/chatPanelHtml.ts` needs matching structure updates
   - Run `npm run compile` in `vscode-agentchatbus`
3. If behavior works in browser debug but not extension:
   - First verify compile/sync was executed
   - Then verify edits were made in `web-ui/extension`, not directly in `resources/media`
4. If you add/rename Host commands:
   - Update both:
     - `vscode-agentchatbus/src/views/chatPanel.ts` (message dispatch)
     - `web-ui/extension/media/vscodeBridgeBrowser.js` (browser bridge mapping)

### Agent Do / Don’t

- Do:
  - Edit source-of-truth directory first, then sync via compile.
  - Keep extension and browser-debug behavior as close as possible.
  - Mention in your change notes whether `npm run compile` is required.
- Don’t:
  - Don’t patch only generated extension resource files.
  - Don’t break WebView path conventions for browser convenience.
  - Don’t merge main console and extension UI into one giant unbounded entrypoint.

### Agent Quick Checklist

- [ ] Did I edit the correct directory?
- [ ] If extension UI changed, did I run `npm run compile`?
- [ ] Does main Web Console still work?
- [ ] Are browser debug and extension WebView behavior aligned?
- [ ] Do README conventions need updating?

---

## 8) Common Commands

```bash
# Start backend (example)
agentchatbus

# Extension sync + compile
cd vscode-agentchatbus
npm run compile

# Extension tests (may fail in some locked-down environments)
npm test
```

---

## 9) File Map (Quick Reference)

- Main Console:
  - `web-ui/index.html`
  - `web-ui/css/main.css`
  - `web-ui/js/*`
- Extension UI source:
  - `web-ui/extension/index.html`
  - `web-ui/extension/media/chatPanel.js`
  - `web-ui/extension/media/chatPanel.css`
  - `web-ui/extension/media/messageRenderer.js`
  - `web-ui/extension/media/vscodeBridgeBrowser.js`
- Extension sync script:
  - `vscode-agentchatbus/scripts/sync-webui-assets.mjs`
