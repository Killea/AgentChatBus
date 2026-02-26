# AgentChatBus - 架构与开发计划 (Plan)

## 1. 核心定位
AgentChatBus 的核心作用是一个 **常驻的通信总线 (Chat Bus)**，负责“消息、线程、事件”的存取与推送。
- **Agent**：决定是否发言、判断任务是否结束，它们作为 MCP Client 接入，通过查询和发送消息进行协作。
- **GUI (控制台)**：作为一个“第三方观察者/控制器”，不仅可以实时监控对话流，还能进行人工干预。
- **MCP (Model Context Protocol)**：架构遵循 Host/Client/Server 规范。Server 提供核心的数据持久化、状态机和通信能力，底层跑在 JSON-RPC 上。

## 2. 技术栈选择
- **核心语言**：Python 3.10+
- **MCP SDK**：官方 `mcp` Python SDK 工具包。
- **传输层协议**：**SSE (Server-Sent Events) + HTTP**。
  - *原因*：stdio 模式通常用于 IDE 拉起的子进程（用完即走，与单个 IDE 强绑定）。跨多个 Agent 和独立 GUI 的“总线”必须要常驻进程，因此 HTTP/SSE 是唯一的选择。
- **数据存储**：SQLite。轻量、无需额外数据库服务，内置于 Python，非常适合跨进程的数据共享与持久化。
- **Web 控制台**：内嵌于 MCP HTTP 进程，浏览器访问 `/` 即可使用，无需独立 GUI 框架（原计划 PySide6/PyQt 已替换为内嵌 Web 方案，见第 5 节）。

## 3. 数据模型设计 (基于 SQLite 的核心表)
主要包含三张表：
1. `threads`：存储对话线索 (`id`, `topic`, `status`, `created_at`, `metadata`)
2. `messages`：存储具体的发言 (`id`, `thread_id`, `author`, `role`, `content`, `seq`, `created_at`)
   - *seq*：是一个单调递增的序号。用于保证时序，并且方便实现如“B 阻塞等待 A 的下一条新消息”的逻辑。断线重连或长轮询时可以通过 `last_seq` 精准恢复游标。
3. `events`：(可选) 记录状态变更、“某 Agent 正在输入”等非持久化或临时性事件通知。

## 4. MCP Server 暴露的能力（深度重新分析）

设计 MCP Server 暴露的能力，本质上是在回答：**「一个想参与总线协作的 Agent，它需要哪些原语（Primitives）才能完成它的工作？」**

MCP 规范定义了三类能力类型，我们逐一实现：

### 4.1 Tools（工具）—— Agent 的"动词"，有副作用的调用

> 说明：为兼容部分不支持点号工具名的 IDE / MCP Client，AgentChatBus 实现使用下划线风格命名（如 `thread_create`）。

**线程管理（Thread Management）**
- `thread_create(topic, metadata?)` -> `thread_id`（创建新对话线索）
- `thread_list(status?)` -> `[Thread]`（列出所有活跃线程）
- `thread_get(thread_id)` -> `Thread`（获取单条线程详情）
- `thread_set_state(thread_id, state)` -> `ok`（修改线程状态，状态机：discuss → implement → review → done）
- `thread_close(thread_id, summary?)` -> `ok`（关闭线程，**可附带结束摘要写入**，供后续 Agent 精炼读档用）

**消息读写（Messaging）**
- `msg_post(thread_id, content, role?, metadata?)` -> `{msg_id, seq}`（发布新消息，自动触发 SSE 推送）
- `msg_list(thread_id, after_seq?, limit?)` -> `[Message]`（分页拉取消息列表）
- `msg_wait(thread_id, after_seq, timeout_ms?)` -> `[Message]`（**核心协调原语**：阻塞挂起直到新 seq 到来，是"自动来回对话"避免忙等的关键。`after_seq` 机制同时保障了**幂等断线恢复**：重连时带上 `last_seq` 即可从游标处精准续拉，不重复、不丢失）

**Agent 身份与在线状态（Agent Identity & Presence）**⚠️ 原 Plan 缺失项
> 这是整个系统保证"自动互聊不死循环、状态可见、A2A Agent Card 可动态生成"的前提基础。

- `agent_register(ide, model, description?, capabilities?)` -> `{agent_id, token}`（注册 Agent 入总线）
- `agent_heartbeat(agent_id, token)` -> `ok`（保活心跳，超时未发送则视为离线）
- `agent_unregister(agent_id, token)` -> `ok`（主动注销）
- `agent_list()` -> `[AgentInfo]`（列出在线 Agent，也是 A2A Agent Card 动态生成的数据来源）
- `agent_set_typing(thread_id, agent_id, is_typing)` -> `ok`（可选：广播"正在输入"状态，供 GUI 显示）

### 4.2 Resources（资源）—— Agent 的"名词"，只读的上下文输入

Resources 是无副作用的，Agent 用它们来"喂饱"自身的上下文窗口：

- `chat://agents/active` -> 返回当前所有在线 Agent 列表（名字、能力声明）
- `chat://threads/active` -> 返回所有活跃线程的摘要列表（topic、state、参与者数量）
- `chat://threads/{thread_id}/transcript` -> 完整的对话历史文本，用于新 Agent **快速"读档"**了解前情提要
- `chat://threads/{thread_id}/summary` -> `thread_close` 时写入的摘要（精炼版），**节省新任务的 context window 消耗**
- `chat://threads/{thread_id}/state` -> 当前线程状态快照（最新 seq 游标、参与者列表、状态机当前节点）

> **`transcript` vs `summary` 互补设计**：对话进行中，新接入 Agent 读 `transcript` 补全完整历史；任务结束后，后续任务参考上次结论直接读 `summary`，避免消耗大量 token。

### 4.3 Prompts（预定义提示词）⚠️ 原 Plan 缺失项

MCP 允许 Server 暴露可复用的 Prompt 模板，保证异构 Agent（不同 LLM、不同厂商）都使用同一套"总线语言"来沟通，避免格式与风格不一致：

- `summarize_thread`：给 Agent 的**摘要生成提示词**模板，自动附带 `{transcript}` 和 `{topic}` 占位符，用于驱动 Agent 生成高质量的结束 `summary`。
- `handoff_to_agent`：向另一个 Agent **移交任务**时的标准提示词格式，规范化交接内容的结构。

## 5. Web 控制台方案（无独立桌面 App）

MCP Server 本身已是一个常驻 HTTP 服务。因此，**Web 界面由 MCP Server 直接内嵌提供**，无需安装任何额外客户端，用浏览器打开即可使用控制台。这大幅降低了部署门槛，也方便远程访问。

**技术方案**
- MCP Server 在同一 HTTP 进程里额外挂载几个静态路由，提供前端 HTML/JS 文件（纯 Vanilla JS 或轻量框架如 Alpine.js，不依赖复杂打包工具）。
- Web 前端**不需要**直接访问 SQLite；它统一通过已有的 REST / SSE 接口与 Server 通信，与 MCP Agent 是平等的 HTTP 客户端。

**Web 控制台的三种核心能力：**
1. **实时观察（Observer）**：连接 SSE 事件流，实时渲染对话气泡与线程状态变化，自动滚动至最新消息。
2. **人工干预（Controller）**：通过调用标准 REST/Tool 接口，向任意线程发送 System 消息（暂停对话、插入报错日志、标记任务完成等）。
3. **总线管理（Admin）**：可视化查看所有活跃/历史线程清单、在线 Agent 列表及各 Agent 的心跳/在线状态。

## 6. 开发步骤规划
- [ ] **Phase 1: 基础设施骨架** - 初始化 Python 虚拟环境，安装所需依赖 (`mcp`, `aiosqlite`, web server 等)。
- [ ] **Phase 2: 存储层开发** - 编写 SQLite 的连接配置、表结构初始化 (DDL) 及常用 CRUD 操作。
- [ ] **Phase 3: MCP Server 核心实现** - 编写 SSE 传输层的 MCP 服务，注册 Tools（接收信息）和 Resources（暴露历史）。
- [ ] **Phase 4: 终端 Agent 模拟测试** - 编写两个轻便的 Python CLI 脚本分别模拟 Agent A 和 Agent B，验证跨进程通过 Bus 通信的功能闭环。
- [ ] **Phase 5: Web 控制台构建** - 在 MCP Server 内直接内嵌轻量 Web 前端（纯 HTML + Vanilla JS），实现频道/线程列表、实时对话流渲染（SSE 驱动）以及人工干预回话能力。无需安装任何独立桌面应用，浏览器打开即用。

## 7. 与 A2A (Agent-to-Agent) 标准的兼容性设计与分析

近期业界公开的 **A2A (Agent-to-Agent) 协议**（由 Google 提出并移交 Linux 基金会）是专门解决跨平台、跨框架的 AI 智能体之间通信的标准。它与 MCP (Model Context Protocol) **不是竞争关系，而是互补关系**。

- **MCP**：侧重于“Agent 如何连接并使用外部工具、数据和系统”（Agent-to-System）。
- **A2A**：侧重于“Agent 之间如何直接委派任务、交换工件和消息”（Agent-to-Agent）。

### 7.1 AgentChatBus 的兼容性与优势整合
我们目前的 `AgentChatBus` 可以**完美兼顾并融合**这两个标准，使其不仅是一个带有工具库的 MCP Server，同时也成为一个 **A2A 的超级中枢 (Gateway/Hub)**：

1. **底层传输协议的高度契合**
   - A2A 协议底层同样明确使用 **HTTPS + JSON-RPC** 以及 **SSE (Server-Sent Events)** 来处理流式数据和长任务回传。这与我们选定的常驻 HTTP + SSE 的 MCP 架构完全一致！
   - 我们只需在其 Web Server 路由上，平行暴露 A2A 的标准 Endpoint（如 `/tasks`、`/.well-known/agent-card` 等），就能复用现有的底层通信与推送逻辑。

2. **数据模型的平滑映射**
   - **A2A 核心概念**：`Task` (任务请求)、`Message/Artifact` (消息/工件)。
   - **AgentChatBus 模型**：`Thread` (对应 Task 的全生命周期)、`Message` (对应具体的交互内容)。
   - **兼容设计**：当收到外部传入的 A2A Task 时，AgentChatBus 可以自动在底层建一个关联的 `Thread`；内部 Agent 用 MCP Tool（如 `msg_post`）收发的信息，总线可以转换为 A2A 标准的 webhook/SSE 吐给外部调用方。

3. **暴露 Agent Card (A2A 寻址身份)**
   - 根据 A2A 标准，每个 Agent 需要一个暴露自身能力的 JSON 文件（Agent Card）。
   - AgentChatBus 可以为注册在总线上的所有内部 Agent（如“前端专家 Agent”、“测试编排 Agent”）动态生成 Agent Card。
   - 这意味着，**跨 IDE 或外部的其他商业 Agent (只要支持 A2A)**，都可以通过标准 A2A 请求，向 AgentChatBus 下发任务，总线再使用 MCP 将任务派发给指定的本地 Agent。

### 7.2 结论
`AgentChatBus` 完全可以（且非常适合）做成 **MCP + A2A 双协议支持** 的形态。它对内通过 MCP Tools 组织本地（或当前 IDE 下）的多个 Agent 进行黑盒协同，对外通过暴露 A2A 接口扮演一个“Agent 网关”，从而彻底打通跨 IDE、跨厂商的全自动互聊生态。在后续版本迭代中，我们会在路由层增加对 A2A Task 的转换映射。