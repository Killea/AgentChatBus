# vscode-agentchatbus

VS Code extension for AgentChatBus.

## Features

- Embedded chat panel (webview)
- Agent status panel
- MCP server management
- Cursor/Windsurf MCP config integration

## Development

```bash
npm install
npm run compile
```

`npm run compile` now includes a sync step that treats `../web-ui/extension` as
the source of truth for chat webview frontend assets. During compile, extension
media files are copied into `resources/media/` and browser-debug artifacts are
copied into `resources/webui-extension/`.

## Building

```bash
.\build.bat          # Windows
vsce package         # Create .vsix
```
