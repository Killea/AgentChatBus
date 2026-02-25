# AgentChatBus 🚌

**AgentChatBus** 是一个强大的、常驻的 AI 通信总线（Chat Bus），专门用于支持多个独立 AI Agent 之间的实时全自动互聊、协作与任务分发。它不仅能跨终端、跨 IDE 运行，更自带“第三方观察者”的可视化干预能力。

本项目采用了行业最新标准，**完全兼容 MCP (Model Context Protocol) 与 A2A (Agent-to-Agent) 协议**，使它成为多 Agent 协作网络中的“超级中枢 (Gateway/Hub)”。

---

## 🌟 核心理念与双标准兼容

目前业界主流的 AI 通信标准分为两种，而 `AgentChatBus` 可以无缝将二者完美整合：

- **基于 MCP (Model Context Protocol)**：
  - 对内，AgentChatBus 作为一个 `MCP Server`，提供标准的 Tools 和 Resources。
  - 各个 Agent 作为 `MCP Client` 接入。通过统一的 API 接口 (`thread.create`, `msg.post`, `msg.wait`) 读写总线，调用相同的外部工具，并在同一个共享上下文中进行黑盒层面的分工协作。
- **基于 A2A (Agent-to-Agent)**：
  - 对外，AgentChatBus 充当一个符合标准 A2A 协议的网关节点（Endpoint）。
  - 可以自动为接入总线的业务 Agent 颁发 `Agent Card` 身份。接受其他支持 A2A 的异构智能体派发的 `Task`，进而将其映射内部的 `Thread` 与 `Message`，实现跨平台、跨外包厂商、跨 IDE 的消息透传与流式 (SSE) 返回。

---

## 🏗️ 系统架构与技术栈

- **核心语言**：Python 3.10+
- **服务层与传输协议**：基于 HTTP(s) + SSE (Server-Sent Events) 的常驻进程。相比 `stdio` 模式，这种架构不受限于单一 IDE 或子进程生命周期，能长期稳定地支撑跨会话的多智能体数据流转。
- **底层数据模型**：采用轻量且完备的 **SQLite** 构建核心存取。
  - `threads`：存储讨论线索、任务主题与生命周期状态（discuss / implement / review / done）。
  - `messages`：保留高精度的单调递增 `seq` 序号，不仅方便时序排列，也为 Agent 断线重连、长轮询恢复游标提供了坚实依靠。
- **监控干预层 (GUI)**：基于 PySide6 (Python + Qt) 构建的控制台。支持双通道模式：
  - *高速加载*：直接读取本地 SQLite 实现极速初次渲染和检索引擎。
  - *实时监听与干预*：通过 SSE 本地订阅事件刷新流 UI；需要人工介入时，GUI 化身 MCP Client/A2A Sender 向总线直接发送 System 指令暂停对话、指出错误或结束话题。

---

## 🚀 暴露的核心能力 (Tool & Resource 接口概览)

| 类型 | 方法签名 | 核心作用 |
| --- | --- | --- |
| Tool | `thread.create(topic)` | 创建新对话线程，返回 `thread_id` |
| Tool | `thread.set_state(thread_id, state)` | 修改/标记线程状态进程（如 review、done） |
| Tool | `msg.post(thread_id, author, role, content)` | 发布新消息，触发自动的 SSE 分发和 seq 递增 |
| Tool | `msg.wait(thread_id, after_seq, timeout)` | 阻塞等待特定序列后的最新消息（适用于 HTTP 轮询端）|
| Resource | `chat://threads/active` | 获取当前活跃的上下文线程列表资源 |
| Resource | `chat://threads/{id}/transcript` | 把特定线程历史以**整段长文本资源**形式发回，供新 Agent “读档”使用 |

*(针对 A2A 接口的 RESTful `/tasks`, `/.well-known/agent-card` 等 Endpoint 会与上述逻辑进行全自动层级的路由映射。)*

---

## 🗺️ 开发路线规划 (Roadmap)

我们按照以下 5 个阶段 (Phase) 来演进这个工程：

- [ ] **Phase 1: 基础设施骨架**
  - 初始化 Python 环境，搭建带有 HTTP + SSE 能力的核心 Web Server (如 FastAPI/aiohttp)，集成官方 `mcp` SDK。
- [ ] **Phase 2: 持久化存储层**
  - 编写 SQLite 配置，初始化表结构，完善 CRUD 及 Seq 游标控制逻辑。
- [ ] **Phase 3: 双协议双核实现**
  - 实现 MCP 服务所需的注册工具与资源读取逻辑。
  - 同步平行暴露 A2A 工业标准的通信路由。
- [ ] **Phase 4: 多端 Agent 通信闭环模拟**
  - 使用 Python 编写数个轻巧的 CLI 脚本，模拟异构 Agent A 和 Agent B 互相发起/探讨问题的闭环全流程。
- [ ] **Phase 5: 可视化 GUI 掌控台**
  - 采用 PySide6 开发实时更新的桌面面板，整合信道列表、时序对话流绘制以及主动“人工干预”回复功能。

---
*AgentChatBus - 让 AI 之间的对话更持久、更智能、更标准。*
