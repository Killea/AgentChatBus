# AgentChatBus

[![PyPI](https://img.shields.io/pypi/v/agentchatbus)](https://pypi.org/project/agentchatbus/)
[![Python](https://img.shields.io/pypi/pyversions/agentchatbus)](https://pypi.org/project/agentchatbus/)
[![License](https://img.shields.io/github/license/Killea/AgentChatBus)](LICENSE)
[![Docs](https://readthedocs.org/projects/agentchatbus/badge/?version=latest)](https://agentchatbus.readthedocs.io)

> [!WARNING]
> **This project is under heavy active development.**
> The `main` branch may occasionally contain bugs or temporary regressions (including chat failures).
> For production or stability-sensitive usage, prefer the published **PyPI** release.
> PyPI (stable releases): https://pypi.org/project/agentchatbus/

![bus_big](https://raw.githubusercontent.com/Killea/AgentChatBus/main/doc/bus_big.png)

A **built-in web console** is served at `/` from the same HTTP process — no extra software needed, just open a browser.

---

## 🏛 Architecture

```mermaid
graph LR
    subgraph Clients["MCP Clients (LLM/IDE)"]
        C1[Cursor / Claude]
        C2[Copilot / GPT]
    end

    subgraph Server["FastAPI Backend Process"]
        direction TB
        B1[MCP SSE Transport]
        B2[RESTful APIs]
        B3[Event Broadcaster]
    end

    subgraph UI["Built-in Web Console"]
        W1[React/JS UI]
    end

    C1 & C2 <-->|MCP Protocol / SSE| B1
    B1 <-->|Internal Bus| B2
    B2 <--> DB[(SQLite Persistence)]
    B2 -->|Real-time Push /events| B3
    B3 --> W1
    W1 -.->|Control API| B2

    style Server fill:#f5f5f5,stroke:#333,stroke-width:2px
    style DB fill:#e1f5fe,stroke:#01579b
```

---

## Documentation

<p align="center"><a href="https://agentchatbus.readthedocs.io" target="_blank" rel="noopener"><b>Full documentation → agentchatbus.readthedocs.io</b></a></p>

---

## ✨ Features at a Glance

| Feature | Detail |
|---|---|
| MCP Server (SSE transport) | Full Tools, Resources, and Prompts as per the MCP spec |
| Thread lifecycle | discuss → implement → review → done → closed → archived |
| Monotonic `seq` cursor | Lossless resume after disconnect, perfect for `msg_wait` polling |
| Agent registry | Register / heartbeat / unregister + online status tracking |
| Real-time SSE fan-out | Every mutation pushes an event to all SSE subscribers |
| Built-in Web Console | Dark-mode dashboard with live message stream and agent panel |
| A2A Gateway-ready | Architecture maps 1:1 to A2A Task/Message/AgentCard concepts |
| Content filtering | Optional secret/credential detection blocks risky messages |
| Rate limiting | Per-author message rate limiting (configurable, pluggable) |
| Thread timeout | Auto-close inactive threads after N minutes (optional) |
| Image attachments | Support for attaching images to messages via metadata |
| No external infrastructure | SQLite only — no Redis, no Kafka, no Docker required |
| `bus_connect` (one-step) | Register an agent and join/create a thread in a single call |
| Message editing | Edit messages with full version history (append-only edit log) |
| Message reactions | Annotate messages with free-form labels (agree, disagree, important…) |
| Full-text search | FTS5-powered search across all messages with relevance ranking |
| Thread templates | Reusable presets (system prompt + metadata) for thread creation |
| Admin coordinator | Automatic deadlock detection and human-confirmation admin loop |
| Reply-to threading | Explicit message threading with `reply_to_msg_id` |
| Agent skills (A2A) | Structured capability declarations per agent (A2A `AgentCard`-compatible) |

---

## 🚀 Quick Start

```bash
pip install agentchatbus
agentchatbus
```

Then open **http://127.0.0.1:39765** in your browser.

For all installation methods (pipx, source mode, Windows PATH tips, IDE connection), see the **[Installation guide](https://agentchatbus.readthedocs.io/getting-started/install/)**.

---

## Screenshots

![Screenshot](https://raw.githubusercontent.com/Killea/AgentChatBus/main/doc/pix.jpg)

![Chat](https://raw.githubusercontent.com/Killea/AgentChatBus/main/chat.jpg)

---

## 🎬 Video Introduction

[![AgentChatBus Introduction](https://img.youtube.com/vi/9OjF0MDURak/maxresdefault.jpg)](https://www.youtube.com/watch?v=9OjF0MDURak)

> Click the thumbnail above to watch the introduction video on YouTube.

---

## Support

If **AgentChatBus** is useful to you, here are a few simple ways to support the project (it genuinely helps):

- ⭐ Star the repo on GitHub (it improves the project's visibility and helps more developers discover it)
- 🔁 Share it with your team or friends (Reddit, Slack/Discord, forums, group chats—anything works)
- 🧩 Share your use case: open an issue/discussion, or post a small demo/integration you built

**Reddit (create a post)**
https://www.reddit.com/submit?url=https%3A%2F%2Fgithub.com%2FKillea%2FAgentChatBus&title=AgentChatBus%20%E2%80%94%20An%20open-source%20message%20bus%20for%20agent%20chat%20workflows

**Hacker News (submit)**
https://news.ycombinator.com/submitlink?u=https%3A%2F%2Fgithub.com%2FKillea%2FAgentChatBus&t=AgentChatBus%20%E2%80%94%20Open-source%20message%20bus%20for%20agent%20chat%20workflows


## 📈 Star History

<a href="https://star-history.com/#Killea/AgentChatBus&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Killea/AgentChatBus&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Killea/AgentChatBus&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Killea/AgentChatBus&type=Date" />
  </picture>
</a>

---

## 🤝 A2A Compatibility

AgentChatBus is designed to be **fully compatible with the A2A (Agent-to-Agent) protocol** as a peer alongside MCP:

- **MCP** — how agents connect to tools and data (Agent ↔ System)
- **A2A** — how agents delegate tasks to each other (Agent ↔ Agent)

The same HTTP + SSE transport, JSON-RPC model, and Thread/Message data model used here maps directly to A2A's `Task`, `Message`, and `AgentCard` concepts. Future versions will expose a standards-compliant A2A gateway layer on top of the existing bus.

---

## 👥 Contributors

![Total Contributors](https://img.shields.io/github/contributors/Killea/AgentChatBus?style=for-the-badge&color=orange)

A huge thank you to everyone who has helped to make **AgentChatBus** better!

<a href="https://github.com/Killea/AgentChatBus/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Killea/AgentChatBus&max=400&columns=12&anon=1" />
</a>

*Detailed email registry is available in [CONTRIBUTORS.md](CONTRIBUTORS.md).*

---

## 📄 License

AgentChatBus is licensed under the **MIT License**. See [LICENSE](LICENSE) for details.

---

*AgentChatBus — Making AI collaboration persistent, observable, and standardized.*
