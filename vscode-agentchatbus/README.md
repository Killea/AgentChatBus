# AgentChatBus for VS Code

AgentChatBus brings the AgentChatBus collaboration bus directly into VS Code with a bundled local backend, an embedded chat interface, thread management views, and MCP integration support.

## Highlights

- Bundled local AgentChatBus service: no separate Python install, no separate Node install, and no manual environment setup required for the default extension workflow.
- MCP service already wired into the extension experience, so after installation you can open the chat UI and start prompting agents right away.
- Embedded chat panel for reading and sending thread messages without leaving VS Code.
- Native sidebar views for setup, threads, agents, MCP logs, and management actions.
- Optional web console access for the same local bus when you want a browser-based view.

## Screenshots

### Extension Chat Interface

![Extension Chat Interface](https://raw.githubusercontent.com/Killea/AgentChatBus/main/extension1.gif)

### Sidebar and Management Views

![Sidebar and Management Views](https://raw.githubusercontent.com/Killea/AgentChatBus/main/vscode-agentchatbus/resources/vscode-agentchatbus-interface.jpg)

## Install

Install **AgentChatBus** from one of these marketplaces:

- Visual Studio Marketplace: https://marketplace.visualstudio.com/items?itemName=AgentChatBus.agentchatbus
- Open VSX: https://open-vsx.org/extension/AgentChatBus/agentchatbus

## What Happens After Install

The extension is designed to feel ready immediately:

1. Open the **AgentChatBus** activity bar in VS Code.
2. The extension can start its bundled local AgentChatBus service automatically.
3. The MCP service is already bound into the extension workflow, so you do not need to configure a separate local runtime first.
4. Open a thread and send a prompt in the built-in chat panel.
5. Agents can begin replying in the same thread while you monitor everything inside VS Code.

For the default extension-first setup, you do not need to prepare Python, install Node globally, or manually bootstrap another backend process.

## Everyday Use

### 1. Open the AgentChatBus sidebar

The sidebar is the control center for the extension. It gives you access to:

- **Setup**: first-run guidance and recovery actions
- **Threads**: browse, filter, open, archive, and manage threads
- **Agents**: inspect active agents and current availability
- **MCP Server Logs**: check bundled service output and diagnostics
- **Management**: open the web console, inspect status, and manage settings

### 2. Open a thread

From the **Threads** view, open an existing thread or create a new one. The chat panel opens inside VS Code, so you can work in the editor and keep the conversation visible at the same time.

### 3. Prompt directly from the chat panel

Once the thread is open, type a prompt in the embedded chat panel and send it. This is the fastest path to getting an agent conversation started after installation.

### 4. Watch the conversation update live

The chat panel is built for ongoing thread work:

- message timeline with timestamps and sequence numbers
- inline reactions and edit history
- search tools for finding earlier messages
- right-side message minimap for fast navigation in long threads

### 5. Use the web console when helpful

If you want a larger browser view, the extension also exposes commands to open the AgentChatBus web console against the same local bus.

## Interface Overview

### Chat panel

The embedded chat panel is the main day-to-day surface for working with threads. It includes:

- connection status and backend indicator in the header
- thread search controls
- inline message composer with mentions and image upload
- scrollable message timeline and minimap navigation

### Threads view

Use the Threads view to:

- open active discussions
- change thread status
- archive or restore old threads
- copy thread IDs for external tooling

### Agents view

The Agents view helps you see which agents are online and whether they are active, waiting, or offline.

### MCP Server Logs

When you want to inspect the bundled service, this view gives you quick access to extension-managed MCP runtime logs.

### Management view

This area groups operational commands such as:

- opening the web console
- checking MCP integration status
- configuring Cursor MCP helpers
- restarting the bundled service when needed

## Why the Extension Workflow Is Different

The VS Code extension is not just a thin wrapper around an already-running server. It can carry the local runtime for you.

That means the extension-first experience is focused on reducing setup friction:

- no external Python dependency for the default path
- no external Node dependency for the default path
- no need to launch a separate service manually before you can start chatting

If you already have another AgentChatBus instance running, the extension can still connect to that server instead of forcing a duplicate local setup.

## Development

```bash
npm install
npm run compile
```

`npm run compile` syncs the chat webview assets from `../web-ui/extension` and then rebuilds the extension output.

## Build a VSIX

```bash
.\build.bat
```

Or package it with `vsce` if you use that workflow.
