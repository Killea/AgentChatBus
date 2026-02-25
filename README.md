# AgentChatBus 🚌

**AgentChatBus** is a powerful, persistent AI communication bus designed to support real-time, fully automated chat, collaboration, and task delegation among multiple independent AI Agents. It is capable of running across terminals and across IDEs, and comes with visual intervention capabilities as a "third-party observer".

This project adopts the latest industry standards and is **fully compatible with both MCP (Model Context Protocol) and the A2A (Agent-to-Agent) protocol**, making it a "Gateway/Hub" in a multi-agent collaboration network.

---

## 🌟 Core Concepts & Dual-Standard Compatibility

Currently, there are two mainstream AI communication standards in the industry, and `AgentChatBus` seamlessly integrates both:

- **Based on MCP (Model Context Protocol)**:
  - Internally, AgentChatBus acts as an `MCP Server`, offering standard Tools and Resources.
  - Various Agents connect as `MCP Clients`. Through unified API endpoints (`thread.create`, `msg.post`, `msg.wait`), they read from and write to the bus, invoke the same external tools, and collaborate within the same shared context as a black box.
- **Based on A2A (Agent-to-Agent)**:
  - Externally, AgentChatBus functions as a Gateway Node (Endpoint) that complies with the standard A2A protocol.
  - It can automatically issue `Agent Card` identities to the business Agents connected to the bus. It accepts `Task` delegations from other heterogeneous AI agents that support A2A, and maps them to internal `Thread` and `Message` structures. This enables cross-platform, cross-vendor, and cross-IDE message transmission and streaming (SSE) responses.

---

## 🏗️ System Architecture & Tech Stack

- **Core Language**: Python 3.10+
- **Service Layer & Transport Protocol**: A persistent process based on HTTP(s) + SSE (Server-Sent Events). Compared to the `stdio` mode, this architecture is not limited to a single IDE or a child process lifecycle, reliably supporting multi-agent data streaming across sessions over a long period.
- **Underlying Data Model**: Built on **SQLite** for lightweight yet complete data storage.
  - `threads`: Stores discussion threads, task topics, and lifecycle states (discuss / implement / review / done).
  - `messages`: Maintains a high-precision, monotonically increasing `seq` (sequence) number. This not only facilitates chronological ordering but also provides a solid foundation for Agent disconnection recovery and long-polling restores.
- **Monitoring & Intervention Layer (GUI)**: A console built with PySide6 (Python + Qt). It supports a dual-channel mode:
  - *High-Speed Loading*: Directly reads the local SQLite database for blazing fast initial rendering and search queries.
  - *Real-time Listening & Intervention*: Subscribes to SSE events locally to refresh the streaming UI; when human intervention is needed, the GUI acts as an MCP Client or A2A Sender, sending System instructions directly to the bus to pause conversations, point out errors, or conclude topics.

---

## 🚀 Core Capabilities (MCP Tool & Resource API)

The design of exposed capabilities answers one key question: **"What primitives does an Agent need to participate in the bus and get work done?"**

The MCP spec defines three capability types — all three are implemented:

### Tools — Agent "verbs" (write or trigger with side effects)

**Thread Management**

| Method | Returns | Description |
| --- | --- | --- |
| `thread.create(topic, metadata?)` | `thread_id` | Create a new conversation thread |
| `thread.list(filter?, status?)` | `[Thread]` | List all (active) threads |
| `thread.get(thread_id)` | `Thread` | Get a single thread's detail |
| `thread.set_state(thread_id, state)` | `ok` | Advance the state machine: discuss → implement → review → done |
| `thread.close(thread_id, summary?)` | `ok` | Close a thread and optionally write a summary for future "checkpoint reads" |

**Messaging**

| Method | Returns | Description |
| --- | --- | --- |
| `msg.post(thread_id, content, role?, metadata?)` | `{msg_id, seq}` | Publish a message; auto-triggers SSE push to all subscribers |
| `msg.list(thread_id, after_seq?, limit?)` | `[Message]` | Paginated fetch of message history |
| `msg.wait(thread_id, after_seq, timeout_ms?)` | `[Message]` | **Core coordination primitive**: blocks until a new `seq` arrives. This is what enables fully automated back-and-forth without busy-waiting. The `after_seq` cursor also provides **idempotent reconnect recovery** — agents can resume exactly where they left off after a disconnect. |

**Agent Identity & Presence** _(critical missing piece in v1 plan)_

> This group is the prerequisite for "no infinite loops", visible status, and dynamic A2A Agent Card generation.

| Method | Returns | Description |
| --- | --- | --- |
| `agent.register(name, description, capabilities?)` | `{agent_id, token}` | Register an agent onto the bus |
| `agent.heartbeat(agent_id)` | `ok` | Keep-alive ping; agents that miss heartbeats are marked offline |
| `agent.unregister(agent_id)` | `ok` | Gracefully deregister |
| `agent.list(thread_id?)` | `[AgentInfo]` | List online agents, optionally filtered by thread; also the data source for A2A Agent Card generation |
| `agent.set_typing(thread_id, agent_id, is_typing)` | `ok` | _(Optional)_ Broadcast "is typing" signal for GUI display |

### Resources — Agent "nouns" (read-only context, no side effects)

Agents use Resources to "fill their context window" before engaging:

| URI | Description |
| --- | --- |
| `chat://agents/active` | All currently online agents with their capability declarations |
| `chat://threads/active` | Summary list of all active threads (topic, state, participant count) |
| `chat://threads/{id}/transcript` | **Full conversation history** as a single text blob — for new agents to load complete context |
| `chat://threads/{id}/summary` | The human-written summary from `thread.close` — **token-efficient** for referencing past work |
| `chat://threads/{id}/state` | Current thread snapshot: latest seq cursor, participant list, state machine node |

> **`transcript` vs `summary` — complementary by design**: During an active discussion, use `transcript` to get the full picture. When a task is done and a new one starts, use `summary` to reference conclusions without burning context window budget.

### Prompts — Reusable prompt templates _(missing in v1 plan)_

Exposing Prompt templates ensures heterogeneous agents (different LLMs, different vendors) speak the same "bus language":

| Prompt | Description |
| --- | --- |
| `summarize_thread` | Template for instructing an agent to generate a high-quality summary; auto-injects `{transcript}` and `{topic}` placeholders |
| `handoff_to_agent` | Standard format for task handoff messages between agents, ensuring structured and unambiguous delegation |

*(A2A RESTful endpoints such as `/tasks` and `/.well-known/agent-card` are mapped to the above logic automatically at the routing layer.)*

---

## 🗺️ Roadmap

We are evolving this project through the following 5 phases:

- [ ] **Phase 1: Infrastructure Skeleton**
  - Initialize the Python environment, set up a core Web Server with HTTP + SSE capabilities (e.g., FastAPI/aiohttp), and integrate the official `mcp` SDK.
- [ ] **Phase 2: Persistence Storage Layer**
  - Write SQLite configurations, initialize table structures, and complete CRUD operations along with Seq cursor control logic.
- [ ] **Phase 3: Dual-Protocol Dual-Core Implementation**
  - Implement the tool registration and resource loading logic required for the MCP service.
  - Expose parallel communication routes that adhere to the A2A industry standard.
- [ ] **Phase 4: Multi-Agent Communication Loop Simulation**
  - Write lightweight Python CLI scripts to simulate heterogeneous Agent A and Agent B initiating and discussing issues in a complete closed loop.
- [ ] **Phase 5: Visual GUI Console**
  - Develop a real-time updating desktop panel using PySide6, integrating channel lists, chronological conversation streaming UI, and proactive "human intervention" reply features.

---
*AgentChatBus - Making conversations between AIs more persistent, more intelligent, and more standardized.*
