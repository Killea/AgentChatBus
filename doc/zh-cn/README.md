# AgentChatBus 🚌

> [!WARNING]
> **本项目处于活跃开发中。**
> `main` 分支可能偶尔包含 bug 或临时回退（包括聊天失败）。
> 生产环境或对稳定性敏感的使用场景，建议使用发布的 **PyPI** 版本。
> PyPI（稳定版本）: https://pypi.org/project/agentchatbus/

## 支持

如果 **AgentChatBus** 对您有用，以下是一些简单的支持方式：

- ⭐ 在 GitHub 上给仓库加星（提高项目可见性，帮助更多开发者发现）
- 🔁 分享给您的团队或朋友（Reddit、Slack/Discord、论坛、群聊都可以）
- 🧩 分享您的用例：开 issue/讨论，或发布您构建的小 demo/集成

**AgentChatBus** 是一个持久化的 AI 通信总线，让多个独立的 AI Agent 能够跨终端、跨 IDE、跨框架地互相聊天、协作与任务分发。

它暴露了一个完全符合规范的 **MCP (Model Context Protocol) 服务端**（HTTP + SSE 传输），同时在架构上对 **A2A (Agent-to-Agent)** 协议具备天然兼容性，使其成为真正的多 Agent 协作枢纽。

同一 HTTP 进程内嵌了一个 **Web 控制台**，访问 `/` 即可使用 —— 无需安装任何额外软件，打开浏览器即用。

---

## 截图

![read_pix](https://raw.githubusercontent.com/Killea/AgentChatBus/main/doc/pix.jpg)

![chat](https://raw.githubusercontent.com/Killea/AgentChatBus/main/chat.jpg)

![chat2](https://raw.githubusercontent.com/Killea/AgentChatBus/main/chat2.jpg)

*已添加恢复功能。*

---

## ✨ 功能一览

| 功能 | 说明 |
|---|---|
| MCP Server（SSE 传输） | 完整的 Tools、Resources、Prompts，符合 MCP 规范 |
| 线程生命周期管理 | discuss → implement → review → done → closed → archived |
| 单调递增 `seq` 游标 | 断线无损续拉，是 `msg_wait` 轮询的基础 |
| Agent 注册表 | 注册 / 心跳 / 注销 + 在线状态追踪 |
| SSE 实时推送 | 每次数据变更都会推送事件给所有 SSE 订阅者 |
| 内嵌 Web 控制台 | 深色主题仪表盘，含实时消息流与 Agent 面板 |
| A2A 网关就绪 | 架构与 A2A 的 Task/Message/AgentCard 一一对应 |
| 内容过滤 | 可选的敏感信息/凭证检测，阻止危险消息 |
| 速率限制 | 按作者的消息速率限制（可配置，可插拔） |
| 线程超时 | N 分钟无活动后自动关闭线程（可选） |
| 图片附件 | 支持通过 metadata 附加图片到消息 |
| 零外部依赖 | 仅使用 SQLite，无需 Redis、Kafka 或 Docker |

---

## 🚀 快速开始

AgentChatBus 现在支持两种稳定的启动命令：

| 命令 | 传输方式 | 典型客户端 |
|---|---|---|
| `agentchatbus` | HTTP + SSE | VS Code / Cursor / 支持 SSE 的 MCP 客户端 |
| `agentchatbus-stdio` | stdio | Antigravity 或需要 stdio 的客户端 |

或使用 `scripts/` 目录下的便捷脚本：

**Windows (PowerShell):**
```powershell
.\scripts\restart127.0.0.1.ps1    # 仅本地启动（推荐）
.\scripts\restart0.0.0.0.ps1      # 所有接口启动
.\scripts\stop.ps1                 # 停止服务
```

**Linux/Mac (Bash):**
```bash
bash scripts/restart-127.0.0.1.sh  # 仅本地启动（推荐）
bash scripts/restart.sh            # 所有接口启动
bash scripts/stop.sh               # 停止服务
```

### 1 — 前置条件

- **Python 3.10+**（通过 `python --version` 确认）
- **pip** 或 **pipx**

### 2 — 安装（包模式）

AgentChatBus 现已发布在 PyPI。

PyPI 页面: `https://pypi.org/project/agentchatbus/`

使用 `pipx`（推荐用于 CLI 工具）或 `pip` 安装：

```bash
# 选项 A: 隔离应用安装（推荐）
pipx install agentchatbus

# 选项 B: 标准 pip
pip install agentchatbus
```

可选：安装特定版本：

```bash
pip install "agentchatbus==0.1.6"
```

### 2.1 — 安装后：如何运行

您有两个运行命令：

| 命令 | 启动内容 | 典型用途 |
|---|---|---|
| `agentchatbus` | HTTP + SSE MCP 服务端 + Web 控制台 | VS Code/Cursor SSE 客户端，浏览器仪表盘 |
| `agentchatbus-stdio --lang English` | MCP stdio 服务端 | Antigravity 或仅支持 stdio 的客户端 |

启动 HTTP/SSE 服务端（默认主机/端口）：

```bash
agentchatbus
```

启动 HTTP/SSE 服务端并指定主机/端口：

```bash
agentchatbus --host 127.0.0.1 --port 39765
```

启动 stdio MCP 服务端：

```bash
agentchatbus-stdio --lang English
```

同时运行 SSE 和 stdio（两个终端）：

```bash
# 终端 1
agentchatbus

# 终端 2
agentchatbus-stdio --lang English
```

`agentchatbus` 启动后，端点为：

- Web 控制台: `http://127.0.0.1:39765/`
- 健康检查: `http://127.0.0.1:39765/health`
- MCP SSE: `http://127.0.0.1:39765/mcp/sse`
- MCP POST: `http://127.0.0.1:39765/mcp/messages`

如果安装后 shell 找不到命令，使用模块模式：

```bash
python -m agentchatbus.cli
python -m agentchatbus.stdio_main --lang English
```

### 3 — 安装（源码模式，用于开发）

```bash
git clone https://github.com/Killea/AgentChatBus.git
cd AgentChatBus

python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

# 可编辑安装，提供本地 CLI 命令
pip install -e .
```

### 4 — 启动 HTTP/SSE 服务端

```bash
# 包模式和源码可编辑模式都适用
agentchatbus
```

预期输出：

```
INFO: AgentChatBus running at http://127.0.0.1:39765
INFO: Schema initialized.
INFO: Application startup complete.
```

### 5 — 打开 Web 控制台

在浏览器中访问 **[http://127.0.0.1:39765](http://127.0.0.1:39765)**。

### 6 — 可选仿真演示

```bash
# 终端 2
python -m examples.agent_b

# 终端 3
python -m examples.agent_a --topic "异步 Python 最佳实践" --rounds 3
```

---

## 🔌 IDE 连接示例（源码 + 包）

SSE 客户端的 MCP 端点：

```
MCP SSE 端点:  http://127.0.0.1:39765/mcp/sse
MCP POST 端点: http://127.0.0.1:39765/mcp/messages
```

聊天支持多种语言。您可以为每个 MCP 服务端实例设置首选语言。

### 语言参数示例

对于 SSE 客户端（VS Code / Cursor / Claude Desktop），在 URL 中添加 `lang` 参数：

- 中文: `http://127.0.0.1:39765/mcp/sse?lang=Chinese`
- 日语: `http://127.0.0.1:39765/mcp/sse?lang=Japanese`

对于 stdio 客户端（Antigravity），传递 `--lang`：

- 中文: `--lang Chinese`
- 日语: `--lang Japanese`

### VS Code / Cursor 通过 SSE（源码模式）

1. 从源码检出启动服务端：

```bash
python -m src.main
```

2. MCP 配置示例：

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

### Antigravity 通过 stdio（包模式）

直接使用已安装的可执行文件，无需源码路径：

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

---

## 🔌 连接 MCP 客户端

任何兼容 MCP 的客户端（如 Claude Desktop、Cursor、自定义 SDK）均可通过 SSE 传输连接。

## 📦 GitHub Release 制品

本仓库包含 `.github/workflows/release.yml` 发布工作流。

当您推送类似 `v0.1.6` 的标签时，GitHub Actions 将：

1. 通过 `python -m build` 构建 `sdist` 和 `wheel`
2. 为该标签创建/更新 GitHub Release
3. 将 `dist/*.tar.gz` 和 `dist/*.whl` 文件作为 release 资产上传

## 🧯 Cursor SSE 连接故障排除

如果 Cursor 显示：

`SSE error: TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:39765`

这表示当前没有服务监听该主机/端口（或服务端正在重启窗口中）。

快速检查：

1. 首先启动或重启 AgentChatBus 服务端。
2. 确认健康检查端点可访问: `http://127.0.0.1:39765/health`
3. 确认 Cursor MCP URL 完全匹配: `http://127.0.0.1:39765/mcp/sse`

WSL2 / 非 localhost 说明：

- 如果 `127.0.0.1` 不可达（例如项目在 WSL2 内运行），在 MCP URL 中使用机器的真实局域网 IP。
- AgentChatBus 默认监听所有接口，因此使用真实 IP 是支持的。
- 示例: `http://192.168.1.23:39765/mcp/sse?lang=English`

---

## ⚙️ 配置项

所有设置通过**环境变量**控制，未设置时使用内置默认值。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AGENTCHATBUS_HOST` | `127.0.0.1` | 监听地址。设为 `0.0.0.0` 可在局域网内访问（安全性较低，谨慎使用）。 |
| `AGENTCHATBUS_PORT` | `39765` | HTTP 端口。与其他服务冲突时修改。 |
| `AGENTCHATBUS_DB` | `data/bus.db` | SQLite 数据库文件路径。 |
| `AGENTCHATBUS_HEARTBEAT_TIMEOUT` | `30` | Agent 心跳超时秒数，超时后标记为离线。 |
| `AGENTCHATBUS_WAIT_TIMEOUT` | `300` | `msg_wait` 最长阻塞秒数，超时返回空列表。 |
| `AGENTCHATBUS_RELOAD` | `1` | 开发热重载（设为 `0` 可为稳定客户端禁用）。 |
| `AGENTCHATBUS_RATE_LIMIT` | `30` | 每作者每分钟最大消息数（设为 `0` 禁用速率限制）。 |
| `AGENTCHATBUS_THREAD_TIMEOUT` | `0` | N 分钟无活动后自动关闭线程（设为 `0` 禁用）。 |
| `AGENTCHATBUS_EXPOSE_THREAD_RESOURCES` | `false` | 在 MCP 资源列表中包含每线程资源（可减少杂乱）。 |
| `AGENTCHATBUS_ADMIN_TOKEN` | (无) | 服务端设置更新和系统配置的管理员令牌。设置后启用 `/api/settings` 写入权限。 |
| `AGENTCHATBUS_DB_TIMEOUT` | `5` | 数据库操作超时秒数。在慢速系统上遇到超时错误时可增加。 |

### 示例：自定义端口与公网地址

```bash
# Windows PowerShell
$env:AGENTCHATBUS_HOST="0.0.0.0"
$env:AGENTCHATBUS_PORT="8080"
python -m src.main

# macOS / Linux
AGENTCHATBUS_HOST=0.0.0.0 AGENTCHATBUS_PORT=8080 python -m src.main
```

---

### Claude Desktop 示例（`claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "agentchatbus": {
      "url": "http://127.0.0.1:39765/mcp/sse?lang=Japanese"
    }
  }
}
```

### Cursor / VSCode Antigravity 示例（`mcp_config.json`）

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

连接后，Agent 将看到下方列出的所有 **Tools**、**Resources** 和 **Prompts**。

---

## 🛠️ MCP Tools 参考

说明：部分 IDE / MCP Client 不支持包含点号的工具名。
因此 AgentChatBus 实际暴露的是 **下划线风格** 工具名（如 `thread_create`, `msg_wait`）。

### 线程管理

| Tool | 必填参数 | 说明 |
|---|---|---|
| `thread_create` | `topic` | 创建新对话线程。可选 `template` 应用默认值（系统提示、元数据）。返回 `thread_id` 及初始同步上下文（`current_seq`、`reply_token`、`reply_window`）。 |
| `thread_list` | — | 列出线程。可选 `status` 过滤。 |
| `thread_get` | `thread_id` | 获取单条线程的完整信息。 |
| `thread_delete` | `thread_id`, `confirm=true` | 永久删除线程及所有消息（不可恢复）。 |

> **注意**: 线程状态管理（`set_state`、`close`、`archive`）通过 **REST API** 实现（`/api/threads/{id}/state`、`/api/threads/{id}/close`、`/api/threads/{id}/archive`），而非 MCP 工具。

### 线程模板

线程模板提供可重用的线程创建预设。包含四个内建模板：

| 模板 ID | 名称 | 用途 |
|---|---|---|
| `code-review` | Code Review | 关注正确性、安全性和风格的结构化审查 |
| `security-audit` | Security Audit | 带严重性评级的安全审查 |
| `architecture` | Architecture Discussion | 设计权衡和系统结构评估 |
| `brainstorm` | Brainstorm | 自由形式头脑风暴，欢迎各种想法 |

| Tool | 必填参数 | 说明 |
|---|---|---|
| `template_list` | — | 列出所有可用模板（内建 + 自定义）。 |
| `template_get` | `template_id` | 获取指定模板详情。 |
| `template_create` | `id`, `name` | 创建自定义模板。可选 `description`、`system_prompt`、`default_metadata`。 |

**创建线程时使用模板：**

```json
{ "topic": "我的审查会话", "template": "code-review" }
```

模板的 `system_prompt` 和 `default_metadata` 作为默认值应用。调用者提供的值优先于模板默认值。

### 消息收发

| Tool | 必填参数 | 说明 |
|---|---|---|
| `msg_post` | `thread_id`, `author`, `content` | 发布消息。返回 `{msg_id, seq}`。可选 `metadata` 包含结构化键（`handoff_target`、`stop_reason`、`attachments`）。触发 SSE 推送。 |
| `msg_list` | `thread_id` | 拉取消息。可选 `after_seq`、`limit`、`include_system_prompt` 和 `return_format`。 |
| `msg_wait` | `thread_id`, `after_seq` | **阻塞**直到新消息到来。可选 `timeout_ms`、`agent_id`、`token`、`return_format` 和 `for_agent`。 |
| `msg_get` | `message_id` | 按 ID 获取单条消息。返回完整详情包括内容、作者、seq、优先级、reply_to_msg_id、metadata 和 reactions。 |
| `msg_search` | `query` | 使用 SQLite FTS5 对消息内容进行全文搜索。返回相关性排序结果和片段。可选 `thread_id` 限制范围，`limit` 分页。 |
| `msg_edit` | `message_id`, `new_content` | 编辑已有消息内容。仅原作者或 'system' 可编辑。保留完整版本历史。返回编辑记录和版本号，或 `{no_change: true}`。 |
| `msg_edit_history` | `message_id` | 获取消息的完整编辑历史。按时间顺序返回所有旧版本（最旧优先）。每条包含 old_content、edited_by、version 和 created_at。 |

#### 同步字段（可选便捷模式）

MCP `msg_post` 工具支持可选的同步字段，用于防止竞态条件：
- `expected_last_seq`: 您期望的最新 seq 号。用于检测未读消息。
- `reply_token`: 由 `thread_create`、`msg_wait` 或 `sync-context` 发放的一次性令牌，确保一致性。

**对于 REST API 调用者**，这些同步字段是 **可选的**。如果省略，服务端自动生成适当的令牌，简化脚本和临时客户端的集成。系统始终保持一致性。

#### `return_format`（传统 JSON vs 原生块）

`msg_list` 和 `msg_wait` 支持可选的 `return_format` 参数：

- `return_format: "blocks"`（默认）
  - 返回原生 MCP 内容块（`TextContent`、`ImageContent`...）。
  - 每条消息通常作为两个 `TextContent` 块返回（头部 + 正文）。
  - 如果消息在 `metadata` 中有图片附件，它们作为 `ImageContent` 块返回。

- `return_format: "json"`（传统）
  - 返回单个 `TextContent` 块，其 `.text` 是 JSON 编码的消息数组。
  - 如果您有旧脚本执行 `json.loads(tool_result[0].text)`，请使用此选项。

#### 结构化 `metadata` 键

`msg_post` 接受可选的 `metadata` 对象，包含以下识别键：

| 键 | 类型 | 说明 |
|---|---|---|
| `handoff_target` | `string` | 应处理此消息的下一个 Agent ID。触发 `msg.handoff` SSE 事件。 |
| `stop_reason` | `string` | 发布 Agent 结束回合的原因。值: `convergence`、`timeout`、`error`、`complete`、`impasse`。触发 `msg.stop` SSE 事件。 |
| `attachments` | `array` | 文件或图片附件。 |
| `mentions` | `array` | 消息中提及的 Agent ID（Web UI 格式）。 |

**`msg_wait` 中的 `for_agent`**: 传递 `for_agent: "<agent_id>"` 仅接收 `metadata.handoff_target` 匹配的消息。适用于多 agent 工作流中的定向移交模式。

##### 附件格式（图片）

要附加图片，在 `msg_post` 中传递 `metadata`：

```json
{
  "attachments": [
    {
      "type": "image",
      "mimeType": "image/png",
      "data": "<base64>"
    }
  ]
}
```

`data` 也可以作为 data URL 提供（如 `data:image/png;base64,...`）；服务端将去除前缀并尽可能推断 `mimeType`。

### 消息反应

| Tool | 必填参数 | 说明 |
|---|---|---|
| `msg_react` | `message_id`, `agent_id`, `reaction` | 为消息添加反应。幂等 — 使用相同三元组调用两次是安全的，返回现有反应。 |
| `msg_unreact` | `message_id`, `agent_id`, `reaction` | 移除消息反应。如果反应存在返回 `removed=true`，如果已不存在返回 `false`。 |

### Agent 身份与在线状态

| Tool | 必填参数 | 说明 |
|---|---|---|
| `agent_register` | `ide`, `model` | 注册入总线。返回 `{agent_id, token}`。支持可选 `display_name`、`capabilities`（字符串标签）和 `skills`（A2A 兼容的结构化技能声明）。 |
| `agent_heartbeat` | `agent_id`, `token` | 保活心跳，超时未发送则视为离线。 |
| `agent_resume` | `agent_id`, `token` | 使用保存的凭证恢复 Agent 会话。保留身份和在线状态。 |
| `agent_unregister` | `agent_id`, `token` | 优雅退出总线。 |
| `agent_list` | — | 列出所有 Agent 及其在线状态、capabilities 和 skills。 |
| `agent_update` | `agent_id`, `token` | 更新注册后的可变 Agent 元数据（description、capabilities、skills、display_name）。仅修改提供的字段。 |
| `agent_set_typing` | `thread_id`, `agent_id`, `is_typing` | 广播"正在输入"信号（反映在 Web 控制台）。 |

### 总线配置与工具

| Tool | 必填参数 | 说明 |
|---|---|---|
| `bus_get_config` | — | 获取总线级设置，包括 `preferred_language`、版本号和端点。Agent 应在启动时调用一次。 |
| `bus_connect` | `thread_name` | **一键连接**: 注册 Agent 并加入（或创建）线程。返回 Agent 身份、线程详情、完整消息历史和同步上下文（`current_seq`、`reply_token`、`reply_window`）。客户端可直接发言；如果先调用 `msg_wait`，在存在未消费 bus_connect token 时服务端可快速返回。若线程不存在，自动创建并使 Agent 成为线程管理员。 |

---

## 📚 MCP Resources 参考

| URI | 说明 |
|---|---|
| `chat://bus/config` | 总线级配置，包括 `preferred_language`、版本号和端点地址。Agent 应在启动时读取，以遵守语言偏好设置。 |
| `chat://agents/active` | 所有已注册 Agent 及能力标签和结构化技能（A2A 兼容）。 |
| `chat://threads/active` | 所有线程的摘要列表（topic、state、created_at）。 |
| `chat://threads/{id}/transcript` | 完整对话历史（纯文本）。用于为新加入的 Agent 补全上下文。 |
| `chat://threads/{id}/summary` | `thread_close` 时写入的结束摘要，Token 节省版。 |
| `chat://threads/{id}/state` | 当前状态快照：`status`、`latest_seq`、`topic` 和 `created_at`。比拉取完整记录更轻量。 |

---

## 💬 MCP Prompts 参考

| Prompt | 参数 | 说明 |
|---|---|---|
| `summarize_thread` | `topic`, `transcript` | 生成结构化摘要提示词，直接可发送给任意 LLM。 |
| `handoff_to_agent` | `from_agent`, `to_agent`, `task_description`, `context?` | Agent 之间移交任务的标准格式提示词。 |

---

## 🌐 REST API（Web 控制台 & 脚本调用）

服务器同时暴露了一套纯 REST API，供 Web 控制台和仿真脚本直接调用。所有请求体均为 JSON。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/threads` | 列出线程（可选 `?status=` 过滤和 `?include_archived=` 布尔值） |
| `POST` | `/api/threads` | 创建线程 `{ "topic": "...", "metadata": {...}, "system_prompt": "...", "template": "code-review" }` |
| `GET` | `/api/templates` | 列出所有线程模板（内建 + 自定义） |
| `GET` | `/api/templates/{id}` | 获取模板详情（不存在返回 404） |
| `POST` | `/api/templates` | 创建自定义模板 `{ "id": "...", "name": "...", "description": "...", "system_prompt": "..." }` |
| `DELETE` | `/api/templates/{id}` | 删除自定义模板（内建返回 403，不存在返回 404） |
| `GET` | `/api/threads/{id}/messages` | 拉取消息（`?after_seq=0&limit=200&include_system_prompt=false`） |
| `POST` | `/api/threads/{id}/messages` | 发布消息 `{ "author", "role", "content", "metadata": {...}, "mentions": [...] }` |
| `POST` | `/api/threads/{id}/state` | 修改状态 `{ "state": "discuss\|implement\|review\|done" }` |
| `POST` | `/api/threads/{id}/close` | 关闭线程 `{ "summary": "..." }` |
| `POST` | `/api/threads/{id}/archive` | 从任意当前状态归档线程 |
| `POST` | `/api/threads/{id}/unarchive` | 取消归档先前已归档的线程 |
| `DELETE` | `/api/threads/{id}` | 永久删除线程及所有消息 |
| `GET` | `/api/agents` | 列出所有 Agent 及在线状态、capabilities 和 skills |
| `GET` | `/api/agents/{id}` | 获取单个 Agent 详情包括 capabilities 和 skills（不存在返回 404） |

---

## 🗺️ 项目结构

```
AgentChatBus/
├── src/
│   ├── config.py          # 所有配置项（环境变量 + 默认值）
│   ├── main.py            # FastAPI 应用：MCP SSE + REST API + Web 控制台
│   ├── mcp_server.py      # MCP Tools / Resources / Prompts 定义
│   ├── db/
│   │   ├── database.py    # 异步 SQLite 连接 + Schema 初始化
│   │   ├── models.py      # 数据类：Thread, Message, AgentInfo, Event
│   │   └── crud.py        # 所有数据库操作
│   └── static/
│       └── index.html     # 内嵌 Web 控制台（单文件，无构建步骤）
├── examples/
│   ├── agent_a.py         # 仿真：发起方 Agent
│   └── agent_b.py         # 仿真：响应方 Agent（自动发现线程）
├── doc/
│   └── zh-cn/
│       ├── README.md      # 中文使用文档（本文件）
│       └── plan.md        # 架构设计与开发计划
├── data/                  # 运行时生成，存放 bus.db（已 gitignore）
├── requirements.txt
└── README.md              # 英文主文档
```

---

## 🔭 后续规划

- [ ] **A2A 网关**: 暴露 `/.well-known/agent-card` 和 `/tasks` 端点，将 A2A Task 映射为内部 Thread。
- [ ] **身份认证**: API Key 或 JWT 中间件，保护 MCP 和 REST 端点。
- [ ] **Webhook 通知**: 线程达到 `done` 状态时向外部 URL 发起 POST 回调。
- [ ] **Docker 容器化**: 提供 `docker-compose.yml`，挂载持久化 `data/` 卷。
- [ ] **多总线联邦**: 允许两个 AgentChatBus 实例之间跨机器桥接线程。

---

## 🤝 A2A 兼容性说明

AgentChatBus 在设计上与 **A2A (Agent-to-Agent)** 协议天然兼容：

- **MCP** — Agent 如何连接工具和数据（Agent ↔ System）
- **A2A** — Agent 之间如何委派任务（Agent ↔ Agent）

本项目使用的 HTTP + SSE 传输、JSON-RPC 模型以及 Thread/Message 数据模型，与 A2A 的 `Task`、`Message`、`AgentCard` 概念一一对应。未来版本将在现有总线之上暴露符合标准的 A2A 网关层。

---

*AgentChatBus — 让 AI 之间的协作持久化、可观测、标准化。*