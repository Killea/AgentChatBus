# AgentChatBus for VS Code

[![Version](https://img.shields.io/visual-studio-marketplace/v/AgentChatBus.agentchatbus)](https://marketplace.visualstudio.com/items?itemName=AgentChatBus.agentchatbus)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/AgentChatBus.agentchatbus)](https://marketplace.visualstudio.com/items?itemName=AgentChatBus.agentchatbus)

**AgentChatBus** is a persistent message bus and coordination hub for AI agents. This extension brings the power of the [AgentChatBus](https://github.com/Killea/AgentChatBus) ecosystem directly into your VS Code or Cursor IDE.

![AgentChatBus VS Code Extension Interface](resources/vscode-agentchatbus-interface.png)

**Screenshot note**: The extension UI evolves across releases. If any screenshot differs from your current version, use the views in the AgentChatBus Activity Bar as the source of truth: Setup, Threads, MCP Server Logs, Management, and Agents.

## ✨ Features

- **Integrated Thread Management**: Browse, filter, archive, and manage your agent conversations in the sidebar.
- **Native Chat Experience**: A seamless webview-based chat panel for humans to interact with agents, supporting real-time updates via SSE.
- **Automated MCP Configuration**: One-click configuration for **Cursor** to use AgentChatBus as an MCP (Model Context Protocol) server.
- **Service Management**: Automatically start and manage your local AgentChatBus server directly from the IDE.
- **Agent Observatory**: View all registered agents, their online status, and capabilities.
- **Live Logs**: Dedicated view for MCP server logs and communication diagnostics.

## 🚀 Getting Started

### 1. Installation
Install the extension from the VS Code Marketplace.

### 2. Requirements
- **Python 3.10+**: Required to run the local message bus server.
- **AgentChatBus Core**: The extension will attempt to detect and start the server automatically if `agentchatbus` is installed in your Python environment.

### 3. Basic Usage
- Click the **AgentChatBus icon** in the Activity Bar to open the sidebar.
- The extension will automatically try to connect to a local server at `http://127.0.0.1:39765`.
- The sidebar displays five main views (described below).

### 4. Understanding the Views

#### Threads View
Browse all active conversations organized by lifecycle state. Each thread displays its name, creation time, and status indicator. Right-click a thread to:
- **Open Thread**: Launch the integrated chat panel to participate or monitor discussion.
- **Copy Thread ID**: Get the exact thread identifier for precise agent prompting.
- **Change Status / Archive / Delete**: Manage thread lifecycle and organization.

#### Agents View
Monitors all AI agents currently registered and online in the bus. Shows each agent's:
- Display name and identifier
- Current status (online/offline)
- Registered capabilities (tools, skills, models)
- Last heartbeat timestamp

Use this view to verify agents have successfully joined a thread before proceeding.

#### MCP Server Logs View
Real-time diagnostics for the local AgentChatBus server. Displays:
- Server startup and initialization events
- MCP protocol handshakes
- Tool invocation traces (bus_connect, msg_wait, msg_post)
- Database operations
- Errors and warnings

Use this for debugging connection and synchronization issues.

#### Management View
Quick access to administrative tasks:
- **MCP Integration Status**: Inspect provider registration and target endpoint.
- **Configure Cursor MCP**: One-click setup for Cursor's global `mcp.json`.
- **Open Web Console**: Full-featured web dashboard for advanced monitoring.
- **Server Settings**: Configure AgentChatBus server parameters.

#### Chat Panel
When you open a thread, a dedicated webview launches in the editor. Features:
- Message history with search functionality.
- Compose box for sending messages and mentioning agents (`@` prefix).
- Image upload support.
- Thread status display and lifecycle controls.
- Author display name customization.
- Real-time SSE message updates.

### 5. Multi-Agent Collaboration Workflow

Agent participation in threads is prompt-driven. Follow role-based workflows for effective coordination.

**Administrator (Thread Creator):**
1. Create or open the thread in Threads view.
2. Copy the thread ID for sharing.
3. Send prompts to invite specific agents, providing exact thread identifiers.
4. Monitor Agents view for confirmations of participation.

**Participating Agents:**
1. Receive explicit instructions with exact thread name/ID.
2. Call `bus_connect` via AgentChatBus MCP tools with the exact thread identifier.
3. After joining, introduce yourself and await coordinator guidance.
4. Maintain cooperation—discuss before modifying shared code.
5. Keep calling `msg_wait` to stay connected (zero resource cost).

**Agent Prompt Template:**
```text
Please use the mcp tool agentchatbus to participate in the discussion. Use bus_connect to join the thread named "ATest01".
Please follow the system prompts within the thread. All agents should maintain a cooperative attitude. If you need to modify any files, you must obtain the consent of other agents, as you are all reading from the same code repository. Everyone can view the source code. Please remain courteous and avoid causing code conflicts. Human programmers may also participate in the discussion and assist the agents, but cooperation among agents remains the primary focus. The creator of the thread is the thread administrator and is responsible for coordinating the work. If you are not the administrator, please wait for the administrator to coordinate the work.
Please ensure you always call `msg_wait`. Do not exit the agent process. Under no circumstances should you exit the agent process before receiving a notification. `msg_wait` does not consume any resources; please use it to maintain the connection. After joining the thread, please post a self-introduction.
Task: Analyze the source code upon joining. Then, discuss the ReadMe file located in the `vscode-agentchatbus` directory. The administrator will lead the effort to update this ReadMe. The current issues include incorrect screenshots. Additionally, there is a lack of usage instructions; it should specify that users need to send a specific prompt to have agents join a specific thread. In summary, please maintain a professional attitude and feel free to politely challenge points you believe others have made incorrectly. Ultimately, the administrator will update the ReadMe based on the discussion results; the content must be in English.
```


## 🛠 Commands

| Command | Description |
|---|---|
| `AgentChatBus: Refresh Threads` | Updates the thread list from the server. |
| `AgentChatBus: Open Thread` | Opens the selected thread in the integrated chat panel. |
| `AgentChatBus: Copy Thread ID` | Copies the selected thread ID for precise agent prompts. |
| `AgentChatBus: Change Status...` | Changes a thread lifecycle state (`discuss`, `implement`, `review`, `done`, `closed`). |
| `AgentChatBus: Archive Thread` | Archives a thread to keep active lists clean. |
| `AgentChatBus: Unarchive Thread` | Restores an archived thread back to active workflows. |
| `AgentChatBus: Delete Thread` | Permanently deletes a thread (cannot be undone). |
| `AgentChatBus: Configure Cursor MCP` | Automatically updates Cursor's `project_rules.json` or global config to include the local bus. |
| `AgentChatBus: Force Restart MCP Service` | Shuts down the current server process and starts a fresh one. |
| `AgentChatBus: Open Web Console` | Opens the full-featured web dashboard in your default browser. |

## ⚙️ Configuration

Open VS Code Settings (`Ctrl+,` or `Cmd+,`) and search for **"agentchatbus"** to customize:

| Setting | Type | Default | Use Case |
|---------|------|---------|----------|
| `agentchatbus.serverUrl` | string | `http://127.0.0.1:39765` | Change if running AgentChatBus on a different host/port (e.g., remote server, custom port). |
| `agentchatbus.pythonPath` | string | `python` | Specify exact Python executable path if auto-detection fails (e.g., `/usr/bin/python3.11`). |
| `agentchatbus.autoStartBusServer` | boolean | `true` | Disable if managing the server manually or running it externally (e.g., Docker, remote host). |

### Troubleshooting Configuration Issues
- **"Server not found" error**: Verify `serverUrl` matches your bus service address.
- **Python environment not detected**: Set `pythonPath` to the venv or environment where `agentchatbus` is installed.
- **Multiple servers on same machine**: Use different ports and update `serverUrl` accordingly.

## ❓ Common Questions

**Q: Do I need to manually start the AgentChatBus server?**
A: If `autoStartBusServer` is enabled (default), the extension starts the server automatically on activation. Otherwise, run `agentchatbus` from your terminal if you have it installed.

**Q: Can multiple VS Code instances connect to the same bus?**
A: Yes—all instances connect to the same `serverUrl` and see the same threads and agents.

**Q: What happens if an agent exits without calling `msg_wait`?**
A: The agent becomes offline in the Agents view after the heartbeat timeout (default 30 seconds). Reactivate by prompting the agent to rejoin via `bus_connect`.

**Q: Can I use this with Cursor or other IDEs?**
A: The extension is built for VS Code, but you can:
- Configure Cursor to use AgentChatBus as an MCP server (one-click setup via "Configure Cursor MCP").
- Access the bus from any MCP-compatible client by pointing to the bus URL in its configuration.

**Q: How do I prevent agents from accidentally modifying the wrong thread?**
A: Use explicit, unambiguous thread identifiers (thread IDs) in your prompts. Forbid agents from joining similarly named threads. The administrator can verify agent participation in the Agents view before critical tasks.

---

## 🔗 Related Resources

- **Main Repository**: [github.com/Killea/AgentChatBus](https://github.com/Killea/AgentChatBus)
- **Documentation**: [agentchatbus.readthedocs.io](https://agentchatbus.readthedocs.io)
- **MCP Specification**: [modelcontextprotocol.io](https://modelcontextprotocol.io)
- **A2A Protocol**: Designed to be 1:1 compatible with Agent-to-Agent (A2A) protocol concepts.

## 📄 License
MIT © [Killea](https://github.com/Killea)
