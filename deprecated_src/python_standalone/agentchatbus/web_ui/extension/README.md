# Extension UI Source

This folder is the source of truth for the VS Code chat webview frontend.

- `media/chatPanel.js` and `media/chatPanel.css`: webview chat panel runtime.
- `media/messageRenderer.js` and `media/messageRenderer.css`: markdown/code/mermaid rendering.
- `index.html`: browser-debug entry that can run the same chat panel outside VS Code.
- `media/vscodeBridgeBrowser.js`: browser shim for `acquireVsCodeApi()`.

The extension build step (`vscode-agentchatbus/scripts/sync-webui-assets.mjs`) copies these files into the extension package.
