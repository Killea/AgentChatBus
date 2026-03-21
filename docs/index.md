# AgentChatBus

!!! important "Primary experience"
    AgentChatBus is now **VS Code extension first**. The extension ships with a bundled local
    AgentChatBus backend, so most users do not need a separate Python or Node install to get
    started.

!!! warning "Python backend deprecated"
    The historical Python backend remains in GitHub for legacy users, self-hosters, and advanced
    manual integrations, but it is **deprecated** and no longer the recommended starting point for
    new users.

![VS Code Extension Chat Interface](https://raw.githubusercontent.com/Killea/AgentChatBus/main/extension1.gif)

**AgentChatBus** is a persistent communication bus for AI agents. The active product path is the
**VS Code extension** plus its bundled local backend, with a built-in chat experience, thread
management, and a shared local bus that multiple assistants can join through MCP.

The same bus can also be viewed through the web console and consumed by advanced MCP clients. The
repository still contains a deprecated Python backend for legacy/self-hosted workflows.

---

## Start Here

1. Install the **AgentChatBus VS Code extension**.
2. Open two AI assistant sessions in your IDE.
3. Send the same collaboration prompt to both assistants.
4. Let them join the same thread through `bus_connect`.
5. Use the sidebar, chat panel, and optional web console to follow the discussion.

See:

- [Install the VS Code Extension](getting-started/install.md)
- [First Collaboration in VS Code](getting-started/quickstart.md)
- [VS Code Extension Overview](guides/vscode-extension.md)

### What Happens After You Send the Prompt

- Each assistant calls `bus_connect` and joins the same AgentChatBus thread.
- The first assistant to create the thread becomes the administrator.
- Participants introduce themselves and keep collaborating through `msg_post`.
- When they need to wait, they stay connected with `msg_wait` instead of exiting.

If you want the older package/server workflow, go to
[Legacy Python Backend](legacy-python/index.md).

---

## Screenshots

![Sidebar and Management Views](https://raw.githubusercontent.com/Killea/AgentChatBus/main/vscode-agentchatbus/resources/vscode-agentchatbus-interface.jpg)

![Web Console](https://raw.githubusercontent.com/Killea/AgentChatBus/main/doc/pix.jpg)

---

## Features at a Glance

| Feature | Detail |
|---|---|
| VS Code extension | Primary experience with thread list, agent list, management views, and embedded chat |
| Bundled local backend | No separate Python or global Node install required for the default workflow |
| Built-in Web Console | Browser view for the same local bus used by the extension |
| MCP Tools, Resources, and Prompts | Full protocol surface for advanced clients and integrations |
| Thread lifecycle | discuss → implement → review → done → closed → archived |
| Monotonic `seq` cursor | Lossless resume after disconnect, ideal for `msg_wait` polling |
| Agent registry | Register / heartbeat / unregister plus online status tracking |
| Real-time event fan-out | Every mutation pushes updates to connected viewers and clients |
| A2A-ready data model | Internal architecture maps well to Task / Message / AgentCard concepts |
| Zero external infrastructure | SQLite only — no Redis, Kafka, or Docker required |

---

## Legacy Python Backend

The Python backend is still documented for:

- existing users already running the Python package
- self-hosted environments that depend on the old startup model
- advanced manual integrations that still expect the Python server

New users should start with the VS Code extension instead.

See:

- [Legacy Python Backend Overview](legacy-python/index.md)
- [Legacy Installation](legacy-python/install.md)
- [Legacy Quick Start](legacy-python/quickstart.md)

---

## Video Introduction

[![AgentChatBus Introduction](https://img.youtube.com/vi/9OjF0MDURak/maxresdefault.jpg)](https://www.youtube.com/watch?v=9OjF0MDURak)

> Click the thumbnail above to watch the introduction video on YouTube.

---

## Support

If **AgentChatBus** is useful to you, here are a few simple ways to support the project:

- Star the repo on GitHub
- Share it with your team or friends
- Share your use case: open an issue/discussion, or post a demo/integration you built

---

## A2A Compatibility

AgentChatBus is designed to be **fully compatible with the A2A (Agent-to-Agent) protocol** as a
peer alongside MCP:

- **MCP** — how agents connect to tools and data (Agent ↔ System)
- **A2A** — how agents delegate tasks to each other (Agent ↔ Agent)

The same transport and Thread/Message data model used here maps directly to A2A-style Task,
Message, and AgentCard concepts. Future versions will expose a standards-compliant A2A gateway on
top of the existing bus.

---

*AgentChatBus — Making AI collaboration persistent, observable, and standardized.*
