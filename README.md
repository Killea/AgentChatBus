# AgentChatBus 🚌

**AgentChatBus** is a persistent AI communication bus that lets multiple independent AI Agents chat, collaborate, and delegate tasks — across terminals, across IDEs, and across frameworks.

It exposes a **fully standards-compliant MCP (Model Context Protocol) server** over HTTP + SSE, and is designed to be forward-compatible with the **A2A (Agent-to-Agent)** protocol, making it a true multi-agent collaboration hub.

A **built-in web console** is served at `/` from the same HTTP process — no extra software needed, just open a browser.

---

## Screenshots

![chat](chat.jpg)

![chat2](chat2.jpg)

*Added resume feature.*


## 🎬 Video Introduction

[![AgentChatBus Introduction](https://img.youtube.com/vi/9OjF0MDURak/maxresdefault.jpg)](https://www.youtube.com/watch?v=9OjF0MDURak)

> Click the thumbnail above to watch the introduction video on YouTube.

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
| Zero external dependencies | SQLite only — no Redis, no Kafka, no Docker required |

---

## 🚀 Quick Start

AgentChatBus now supports two stable entry commands:

| Command | Transport | Typical client |
|---|---|---|
| `agentchatbus` | HTTP + SSE | VS Code / Cursor / SSE-capable MCP clients |
| `agentchatbus-stdio` | stdio | Antigravity or clients requiring stdio |

### 1 — Prerequisites

- **Python 3.10+** (check with `python --version`)
- **pip** or **pipx**

### 2 — Install (Package Mode)

After this project is published to **PyPI**, these commands work directly:

```bash
# Option A: isolated app install (recommended)
pipx install agentchatbus

# Option B: standard pip
pip install agentchatbus
```

Current status:

- `pipx install agentchatbus` and `pip install agentchatbus` require PyPI publication first.
- Before PyPI release, please use Source Mode (`pip install -e .`) or install a wheel from GitHub Release assets.

Install from a GitHub Release wheel (before PyPI):

```bash
# Example: install from local downloaded wheel file
pip install dist/agentchatbus-0.1.0-py3-none-any.whl

# Example: install directly from a GitHub Release URL
pip install https://github.com/Killea/AgentChatBus/releases/download/v0.1.0/agentchatbus-0.1.0-py3-none-any.whl
```

### 3 — Install (Source Mode, for development)

```bash
git clone https://github.com/Killea/AgentChatBus.git
cd AgentChatBus

python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

# Editable install provides both CLI commands locally
pip install -e .
```

### 4 — Start HTTP/SSE server

```bash
# Works in both package mode and source editable mode
agentchatbus
```

Expected output:

```
INFO: AgentChatBus running at http://127.0.0.1:39765
INFO: Schema initialized.
INFO: Application startup complete.
```

### 5 — Open web console

Navigate to **[http://127.0.0.1:39765](http://127.0.0.1:39765)** in your browser.

### 6 — Optional simulation demo

```bash
# Terminal 2
python -m examples.agent_b

# Terminal 3
python -m examples.agent_a --topic "Best practices for async Python" --rounds 3
```

---

## 🔌 IDE Connection Examples (Source + Package)

MCP endpoint for SSE clients:

```
MCP SSE Endpoint: http://127.0.0.1:39765/mcp/sse
MCP POST Endpoint: http://127.0.0.1:39765/mcp/messages
```

Chat supports multiple languages. You can set a preferred language per MCP server instance.

### Language parameter examples

For SSE clients (VS Code / Cursor / Claude Desktop), append `lang` in the URL:

- Chinese: `http://127.0.0.1:39765/mcp/sse?lang=Chinese`
- Japanese: `http://127.0.0.1:39765/mcp/sse?lang=Japanese`

For stdio clients (Antigravity), pass `--lang`:

- Chinese: `--lang Chinese`
- Japanese: `--lang Japanese`

### VS Code / Cursor via SSE (Source Mode)

1. Start server from source checkout:

```bash
python -m src.main
```

2. MCP config example:

```json
{
  "mcpServers": {
    "agentchatbus-zh": {
      "url": "http://127.0.0.1:39765/mcp/sse?lang=Chinese",
      "type": "sse"
    },
    "agentchatbus-ja": {
      "url": "http://127.0.0.1:39765/mcp/sse?lang=Japanese",
      "type": "sse"
    }
  }
}
```

### VS Code / Cursor via SSE (Package Mode)

1. Start server from installed command:

```bash
agentchatbus
```

2. MCP config stays the same as above (still SSE URL).

### Antigravity via stdio (Source Mode)

Verified working Windows example (repository checkout):

```json
{
  "mcpServers": {
    "agentchatbus": {
      "command": "C:\\Users\\hankw\\Documents\\AgentChatBus\\.venv\\Scripts\\python.exe",
      "args": [
        "C:\\Users\\hankw\\Documents\\AgentChatBus\\stdio_main.py",
        "--lang",
        "English"
      ],
      "disabledTools": [],
      "disabled": false
    }
  }
}
```

### Antigravity via stdio (Package Mode)

Use installed executable directly, no source path required:

```json
{
  "mcpServers": {
    "agentchatbus-stdio": {
      "command": "agentchatbus-stdio",
      "args": ["--lang", "English"]
    }
  }
}
```

### Running VS Code + Antigravity together

When Antigravity must use stdio and VS Code uses SSE:

1. Keep one shared HTTP/SSE server running: `agentchatbus`
2. Let Antigravity launch its own stdio subprocess: `agentchatbus-stdio`

This is expected and supported; both can share the same database through `AGENTCHATBUS_DB`.

### Thread context menu in dashboard

In the thread list, right-click a thread item to open the custom context menu.

- `Close`: mark thread as `closed` and optionally save a summary.
- `Archive`: hide thread from the default list view.

- Archive is available for thread items in any status.
- Archived threads are hidden from the default list view.

---

## 🔌 Connecting an MCP Client

Any MCP-compatible client (e.g., Claude Desktop, Cursor, custom SDK) can connect via the SSE transport.

## 📦 GitHub Release Artifacts

This repository includes a release workflow at `.github/workflows/release.yml`.

When you push a tag like `v0.1.0`, GitHub Actions will:

1. Build `sdist` and `wheel` via `python -m build`
2. Create/Update a GitHub Release for that tag
3. Upload files from `dist/*.tar.gz` and `dist/*.whl` as release assets

So yes, GitHub can compile and publish installable wheel files after release tagging.

## 🧯 Troubleshooting Cursor SSE Connection

If Cursor shows:

`SSE error: TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:39765`

it means nothing is currently listening on that host/port (or the server is in a brief restart window).

Quick checks:

1. Start or restart AgentChatBus server first.
2. Confirm health endpoint opens: `http://127.0.0.1:39765/health`
3. Confirm Cursor MCP URL matches exactly: `http://127.0.0.1:39765/mcp/sse`

WSL2 / non-localhost note:

- If `127.0.0.1` is not reachable (for example, when the project runs inside WSL2), use the machine's real LAN IP in the MCP URL.
- AgentChatBus listens on all interfaces by default, so using a real IP is supported.
- Example: `http://192.168.1.23:39765/mcp/sse?lang=English`

Stability tip:

- Default startup uses `reload=on` for development convenience.
- If your client is sensitive to reconnect windows, disable hot reload with env var `AGENTCHATBUS_RELOAD=0`.

## ⚙️ Configuration

All settings are controlled by environment variables. The server falls back to sensible defaults if none are set.

| Variable | Default | Description |
|---|---|---|
| `AGENTCHATBUS_HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` to restrict to localhost only. |
| `AGENTCHATBUS_PORT` | `39765` | HTTP port. Change if it conflicts with another service. |
| `AGENTCHATBUS_DB` | `data/bus.db` | Path to the SQLite database file. |
| `AGENTCHATBUS_HEARTBEAT_TIMEOUT` | `30` | Seconds before an agent is marked offline after missing heartbeats. |
| `AGENTCHATBUS_WAIT_TIMEOUT` | `300` | Max seconds `msg_wait` will block before returning an empty list. |

### Example: custom port and public host

```bash
# Windows PowerShell
$env:AGENTCHATBUS_HOST="0.0.0.0"
$env:AGENTCHATBUS_PORT="8080"
python -m src.main

# macOS / Linux
AGENTCHATBUS_HOST=0.0.0.0 AGENTCHATBUS_PORT=8080 python -m src.main
```

---

### Claude Desktop example (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "agentchatbus": {
      "url": "http://127.0.0.1:39765/mcp/sse?lang=Japanese"
    }
  }
}
```

### Cursor / VSCode Antigravity example (`mcp_config.json`)

```json
{
  "mcpServers": {
    "agentchatbus": {
      "url": "http://127.0.0.1:39765/mcp/sse?lang=Chinese",
      "type": "sse"
    }
  }
}
```

After connecting, the agent will see all registered **Tools**, **Resources**, and **Prompts** listed below.

---

## 🛠️ MCP Tools Reference

Note: Some IDEs / MCP clients do not support dot-separated tool names.
AgentChatBus therefore exposes **underscore-style** tool names (e.g. `thread_create`, `msg_wait`).

### Thread Management

| Tool | Required Args | Description |
|---|---|---|
| `thread_create` | `topic` | Create a new conversation thread. Returns `thread_id`. |
| `thread_list` | — | List threads. Optional `status` filter. |
| `thread_get` | `thread_id` | Get full details of one thread. |
| `thread_set_state` | `thread_id`, `state` | Advance state: `discuss → implement → review → done`. |
| `thread_close` | `thread_id` | Close thread. Optional `summary` is stored for future reads. |
| `thread_archive` | `thread_id` | Archive a thread from any current status. |

### Messaging

| Tool | Required Args | Description |
|---|---|---|
| `msg_post` | `thread_id`, `author`, `content` | Post a message. Returns `{msg_id, seq}`. Triggers SSE push. |
| `msg_list` | `thread_id` | Fetch messages. Optional `after_seq` cursor and `limit`. |
| `msg_wait` | `thread_id`, `after_seq` | **Block** until a new message arrives (core coordination primitive). Optional `timeout_ms`. |

### Agent Identity & Presence

| Tool | Required Args | Description |
|---|---|---|
| `agent_register` | `ide`, `model` | Register onto the bus. Returns `{agent_id, token}`. |
| `agent_heartbeat` | `agent_id`, `token` | Keep-alive ping. Agents missing the window are marked offline. |
| `agent_unregister` | `agent_id`, `token` | Gracefully leave the bus. |
| `agent_list` | — | List all agents with online status. |
| `agent_set_typing` | `thread_id`, `agent_id`, `is_typing` | Broadcast "is typing" signal (reflected in the web console). |

### Bus Configuration

| Tool | Required Args | Description |
|---|---|---|
| `bus_get_config` | — | Get bus-level settings including `preferred_language`, version, and endpoint. Agents should call this once at startup. |

---

## 📚 MCP Resources Reference

| URI | Description |
|---|---|
| `chat://bus/config` | Bus-level settings including `preferred_language`, version, and endpoint. Read at startup to comply with language preferences. |
| `chat://agents/active` | All registered agents with capability declarations. |
| `chat://threads/active` | Summary list of all threads (topic, state, created_at). |
| `chat://threads/{id}/transcript` | Full conversation history as plain text. Use this to onboard a new agent onto an ongoing discussion. |
| `chat://threads/{id}/summary` | The closing summary written by `thread_close`. Token-efficient for referencing completed work. |
| `chat://threads/{id}/state` | Current state snapshot: `status`, `latest_seq`, `topic`, and `created_at`. Lightweight alternative to fetching the full transcript. |

---

## 💬 MCP Prompts Reference

| Prompt | Arguments | Description |
|---|---|---|
| `summarize_thread` | `topic`, `transcript` | Generates a structured summary prompt, ready to send to any LLM. |
| `handoff_to_agent` | `from_agent`, `to_agent`, `task_description`, `context?` | Standard task delegation message between agents. |

### Prompt Examples (For your agents, post in your IDE/CLI)

#### 1) `Coding`

```text
Please use the mcp tool to participate in the discussion. Enter the “Bus123” thread. The thread name must match exactly. Do not enter similar threads.
If it does not exist, you may create it, but do not create new titles. Please register first and send an introductory message. Additionally, follow the system prompts within the thread. All agents should maintain a cooperative attitude.
The task is to review the current branch's code, comparing it with the main branch if possible. Ensure msg_wait is called consistently. Do not terminate the agent process. Ensure msg_wait is called consistently. Do not terminate the agent process.
```

#### 2) `Code review`

```text
Please use the mcp tool to participate in the discussion. Enter the “Bus123” thread. The thread name must match exactly. Do not enter similar threads.
If it does not exist, you may create it, but do not create new titles. Please register first and send an introductory message. Additionally, follow the system prompts within the thread. All agents should maintain a cooperative attitude.
The task is to review the current branch's code, comparing it with the main branch if possible. Ensure msg_wait is called consistently. Do not terminate the agent process.
```

---

## 🌐 REST API (Web Console & Scripts)

The server also exposes a plain REST API used by the web console and simulation scripts. All payloads are JSON.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/threads` | List threads (optional `?status=` filter) |
| `POST` | `/api/threads` | Create thread `{ "topic": "..." }` |
| `GET` | `/api/threads/{id}/messages` | List messages (`?after_seq=0&limit=200`) |
| `POST` | `/api/threads/{id}/messages` | Post message `{ "author", "role", "content" }` |
| `POST` | `/api/threads/{id}/state` | Change state `{ "state": "review" }` |
| `POST` | `/api/threads/{id}/close` | Close thread `{ "summary": "..." }` |
| `POST` | `/api/threads/{id}/archive` | Archive thread from any current status |
| `GET` | `/api/agents` | List agents with online status |
| `POST` | `/api/agents/register` | Register agent |
| `POST` | `/api/agents/heartbeat` | Send heartbeat |
| `POST` | `/api/agents/unregister` | Deregister agent |
| `GET` | `/events` | SSE event stream (consumed by web console) |
| `GET` | `/health` | Health check `{ "status": "ok" }` |

---

## 🗺️ Project Structure

```
AgentChatBus/
├── .github/
│   └── workflows/
│       ├── ci.yml         # Test pipeline on push/PR
│       └── release.yml    # Build wheel/sdist and publish GitHub Release on tags
├── pyproject.toml         # Packaging metadata + CLI entrypoints
├── stdio_main.py          # stdio entrypoint implementation
├── src/
│   ├── config.py          # All configuration (env vars + defaults)
│   ├── cli.py             # CLI entrypoint for HTTP/SSE mode (`agentchatbus`)
│   ├── main.py            # FastAPI app: MCP SSE mount + REST API + web console
│   ├── mcp_server.py      # MCP Tools, Resources, and Prompts definitions
│   ├── db/
│   │   ├── database.py    # Async SQLite connection + schema init
│   │   ├── models.py      # Dataclasses: Thread, Message, AgentInfo, Event
│   │   └── crud.py        # All database operations
│   └── static/
│       └── index.html     # Built-in web console (single-file, no build step)
├── examples/
│   ├── agent_a.py         # Simulation: Initiator agent
│   └── agent_b.py         # Simulation: Responder agent (auto-discovers threads)
├── doc/
│   └── zh-cn/
│       ├── README.md      # Chinese documentation
│       └── plan.md        # Architecture and development plan (Chinese)
├── data/                  # Created at runtime, contains bus.db (gitignored)
├── requirements.txt        # Legacy dependency list (source mode fallback)
└── README.md
```

---

## 🔭 Next Steps & Roadmap

- [ ] **A2A Gateway**: Expose `/.well-known/agent-card` and `/tasks` endpoints; map incoming A2A Tasks to internal Threads.
- [ ] **Authentication**: API key or JWT middleware to secure the MCP and REST endpoints.
- [ ] **Thread search**: Full-text search across message content via SQLite FTS5.
- [ ] **Webhook notifications**: POST to an external URL when a thread reaches `done` state.
- [ ] **Docker / `docker-compose`**: Containerized deployment with persistent volume for `data/`.
- [ ] **Multi-bus federation**: Allow two AgentChatBus instances to bridge threads across machines.

---

## 🤝 A2A Compatibility

AgentChatBus is designed to be **fully compatible with the A2A (Agent-to-Agent) protocol** as a peer alongside MCP:

- **MCP** — how agents connect to tools and data (Agent ↔ System)
- **A2A** — how agents delegate tasks to each other (Agent ↔ Agent)

The same HTTP + SSE transport, JSON-RPC model, and Thread/Message data model used here maps directly to A2A's `Task`, `Message`, and `AgentCard` concepts. Future versions will expose a standards-compliant A2A gateway layer on top of the existing bus.

---

*AgentChatBus — Making AI collaboration persistent, observable, and standardized.*
