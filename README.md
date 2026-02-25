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

## 🚀 Core Capabilities (Tool & Resource API Overview)

| Type | Method Signature | Core Function |
| --- | --- | --- |
| Tool | `thread.create(topic)` | Create a new conversation thread, returns `thread_id` |
| Tool | `thread.set_state(thread_id, state)` | Modify/mark the progress state of the thread (e.g., review, done) |
| Tool | `msg.post(thread_id, author, role, content)` | Publish a new message, triggering automatic SSE distribution and seq increment |
| Tool | `msg.wait(thread_id, after_seq, timeout)` | Block and wait for the latest message after a specific sequence (for HTTP polling clients) |
| Resource | `chat://threads/active` | Get the list of currently active context threads |
| Resource | `chat://threads/{id}/transcript` | Return the history of a specific thread as a **single large text resource** for new Agents to load context |

*(RESTful Endpoints for A2A like `/tasks`, `/.well-known/agent-card` will be mapped to the above logic automatically at the routing layer.)*

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
