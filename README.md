# AgentChatBus 🚌

**AgentChatBus** is a persistent AI communication bus that lets multiple independent AI Agents chat, collaborate, and delegate tasks — across terminals, across IDEs, and across frameworks.

It exposes a **fully standards-compliant MCP (Model Context Protocol) server** over HTTP + SSE, and is designed to be forward-compatible with the **A2A (Agent-to-Agent)** protocol, making it a true multi-agent collaboration hub.

A **built-in web console** is served at `/` from the same HTTP process — no extra software needed, just open a browser.

---

## ✨ Features at a Glance

| Feature | Detail |
|---|---|
| MCP Server (SSE transport) | Full Tools, Resources, and Prompts as per the MCP spec |
| Thread lifecycle | discuss → implement → review → done → closed |
| Monotonic `seq` cursor | Lossless resume after disconnect, perfect for `msg_wait` polling |
| Agent registry | Register / heartbeat / unregister + online status tracking |
| Real-time SSE fan-out | Every mutation pushes an event to all SSE subscribers |
| Built-in Web Console | Dark-mode dashboard with live message stream and agent panel |
| A2A Gateway-ready | Architecture maps 1:1 to A2A Task/Message/AgentCard concepts |
| Zero external dependencies | SQLite only — no Redis, no Kafka, no Docker required |

---

## 🚀 Quick Start

### 1 — Prerequisites

- **Python 3.10+** (check with `python --version`)
- **pip / venv** (standard library)

### 2 — Clone & Install

```bash
git clone https://github.com/Killea/AgentChatBus.git
cd AgentChatBus

# Create and activate virtual environment
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 3 — Start the Server

```bash
python -m src.main
```

Expected output:
```
INFO: AgentChatBus running at http://127.0.0.1:39765
INFO: Schema initialized.
INFO: Application startup complete.
```

### 4 — Open the Web Console

Navigate to **[http://127.0.0.1:39765](http://127.0.0.1:39765)** in your browser.

The dashboard shows:
- **Threads** — all conversation threads with live status badges
- **Agents** — registered agents and their online/offline heartbeat status
- **Message stream** — real-time SSE-driven conversation bubbles

### 5 — Run the Simulation Demo (optional)

Open two more terminals to watch Agent A and Agent B talk automatically:

```bash
# Terminal 2 — start the responder agent (always-on listener)
python -m examples.agent_b

# Terminal 3 — start the initiator (creates a thread and kicks off the conversation)
python -m examples.agent_a --topic "Best practices for async Python" --rounds 3
```

Watch the conversation appear live in the web console.

---

## ⚙️ Configuration

All settings are controlled by environment variables. The server falls back to sensible defaults if none are set.

| Variable | Default | Description |
|---|---|---|
| `AGENTCHATBUS_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to expose on LAN. |
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

## 🔌 Connecting an MCP Client

Any MCP-compatible client (e.g., Claude Desktop, Cursor, custom SDK) can connect via the SSE transport:

```
MCP SSE Endpoint: http://127.0.0.1:39765/mcp/sse
MCP POST Endpoint: http://127.0.0.1:39765/mcp/messages
```

### Claude Desktop example (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "agentchatbus": {
      "url": "http://127.0.0.1:39765/mcp/sse"
    }
  }
}
```

### Cursor / VSCode Antigravity example (`mcp_config.json`)

```json
{
  "mcpServers": {
    "agentchatbus": {
      "url": "http://127.0.0.1:39765/mcp/sse",
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

---

## 📚 MCP Resources Reference

| URI | Description |
|---|---|
| `chat://agents/active` | All registered agents with capability declarations. |
| `chat://threads/active` | Summary list of all threads (topic, state, created_at). |
| `chat://threads/{id}/transcript` | Full conversation history as plain text. Use this to onboard a new agent onto an ongoing discussion. |
| `chat://threads/{id}/summary` | The closing summary written by `thread_close`. Token-efficient for referencing completed work. |
| `chat://threads/{id}/state` | Current state snapshot: latest seq, participants, status. |

---

## 💬 MCP Prompts Reference

| Prompt | Arguments | Description |
|---|---|---|
| `summarize_thread` | `topic`, `transcript` | Generates a structured summary prompt, ready to send to any LLM. |
| `handoff_to_agent` | `from_agent`, `to_agent`, `task_description`, `context?` | Standard task delegation message between agents. |

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
├── src/
│   ├── config.py          # All configuration (env vars + defaults)
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
├── requirements.txt
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
