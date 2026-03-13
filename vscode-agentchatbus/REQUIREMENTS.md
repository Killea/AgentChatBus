# AgentChatBus VS Code 扩展需求文档

## 1. 项目概述

### 1.1 项目名称
**AgentChatBus for VS Code** (扩展 ID: `agentchatbus.vscode`)

### 1.2 项目目标
创建一个 VS Code 扩展，允许人类用户在 VS Code 中连接 AgentChatBus 服务器，查看 Thread 列表、阅读消息、发送回复，实现与 AI Agent 的实时协作。

### 1.3 技术架构
```
┌─────────────────────────────────────────────────────────────┐
│                    VS Code Extension                         │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Tree View  │  │   Webview   │  │   REST API Client   │  │
│  │  (Sidebar)  │  │   (Chat)    │  │   (+ SSE /events)   │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │             │
│         └────────────────┴─────────────────────┘             │
│                          │                                   │
│                          ▼                                   │
│              ┌──────────────────────┐                        │
│              │ HTTP endpoints & SSE │                        │
│              │ (/api/threads, etc.) │                        │
│              └──────────┬───────────┘                        │
└─────────────────────────┼───────────────────────────────────┘
                          │ SSE / HTTP
                          ▼
              ┌─────────────────────┐
              │  AgentChatBus       │
              │  Server             │
              │  (127.0.0.1:39765)  │
              └─────────────────────┘
```

---

## 2. 功能需求

### 2.1 核心功能

#### 2.1.1 MCP 连接管理
- **F-001**: 支持配置 AgentChatBus 服务器地址（默认 `http://127.0.0.1:39765`）
- **F-002**: 自动检测服务器连接状态
- **F-003**: 支持断线重连机制
- **F-004**: 通过 SSE 接收实时事件推送

#### 2.1.2 Thread 管理
- **F-010**: 在左侧 Sidebar 显示 Thread 列表（Tree View）
- **F-011**: 摒弃基于全生命周期状态的过滤，改为分为**活跃 (Active)** 和**已归档/关闭 (Archived)** 两大类
- **F-012**: Thread 列表按**最新活动时间倒序**排列，便于快速追踪最新进展
- **F-013**: 点击 Thread 打开 Webview 聊天面板
- **F-014**: 支持通过右键菜单直接从当前选中代码或文件快速发起新 Thread

#### 2.1.3 消息查看
- **F-020**: 在 Webview 面板中显示 Thread 消息流
- **F-021**: 区分不同 Agent 的消息（头像、颜色）
- **F-022**: 显示消息时间戳
- **F-023**: 支持消息滚动加载（分页）
- **F-024**: 实时接收新消息（通过 SSE）

#### 2.1.4 消息发送（人类回复）
- **F-030**: 提供消息输入框，支持多行输入
- **F-031**: 发送消息到指定 Thread
- **F-032**: 支持发送消息时的同步机制（`expected_last_seq` + `reply_token`）
- **F-033**: 发送成功后自动滚动到最新消息
- **F-034**: **上下文注入 (Context Injection)**: 支持自动或通过按钮一键将当前 VS Code 中打开的文档名、选中的代码片段等上下文附加至输入框。

#### 2.1.5 Agent 状态面板
- **F-040**: 显示已注册的 Agent 列表
- **F-041**: 显示 Agent 在线状态（在线/离线）
- **F-042**: 显示 Agent 能力标签（capabilities/skills）

### 2.2 扩展功能（可选）

#### 2.2.1 消息交互增强
- **F-050**: 支持消息回复（reply_to）
- **F-051**: 支持消息反应（reactions）
- **F-052**: 支持消息编辑历史查看

#### 2.2.2 通知集成
- **F-060**: 新消息到达时显示 VS Code 通知
- **F-061**: Agent @mention 时触发提醒

#### 2.2.3 快捷操作
- **F-070**: 命令面板快速切换 Thread
- **F-071**: 快捷键发送消息

---

## 3. REST API & SSE 调用设计

### 3.1 使用的 REST API

VS Code 扩展作为人类用户的图形界面客户端，直接与 AgentChatBus 的 HTTP 和 SSE 端点交互：

| 功能场景 | HTTP 端点 | 方法 | 参数/Body |
|---------|---------|------|-----------|
| 获取 Thread 列表 | `/api/threads` | GET | `status`, `limit` |
| 获取 Thread 详情 | `/api/threads/{id}` | GET | - |
| 获取消息列表 | `/api/threads/{id}/messages` | GET | `after_seq` |
| 发送消息 | `/api/threads/{id}/messages` | POST | `{ author, content, expected_last_seq, reply_token }` |
| 获取 Agent 列表 | `/api/agents` | GET | - |

*(注：相比使用供 LLM 调用的 MCP Tools，直接调用 REST API 返回的强类型 JSON 数据更适合前端 UI 渲染。扩展应当作为一个标准 HTTP 客户端工作。)*

### 3.2 消息同步机制

**关键约束**: `msg_post` (`POST /api/threads/{id}/messages`) 必须携带 `expected_last_seq` 和 `reply_token`。

**工作流程**:
```text
1. 用户打开 Thread
2. 调用 GET /api/threads/{id}/messages 获取消息历史 → 得到 current_seq
3. 扩展程序订阅和监听 SSE /events
4. 发送消息前，从最新的上下文（可从 REST 响应或 SSE 事件中获取）提取 reply_token 和 current_seq
5. 调用 POST /api/threads/{id}/messages(expected_last_seq=current_seq, reply_token=token)
```

### 3.3 SSE 事件订阅

通过 `GET /events` SSE 端点接收实时事件，更新 Tree View 和 Webview：
- `thread.created` / `thread.updated` / `thread.deleted`
- `msg.posted` / `msg.edited`
- `agent.registered` / `agent.unregistered` / `agent.online_changed`

---

## 4. UI/UX 设计

### 4.1 Sidebar (Tree View)

考虑到 VS Code 作为本地开发环境的场景，开发者更关心“当前正在进行哪些代码讨论”，而非死板的阶段状态。因此采用按活跃度排序的扁平化结构：

```text
AgentChatBus
├── 📋 Active Threads
│   ├── 💬 任务讨论: 实现新功能设计 (2m ago)
│   ├── 💬 代码审查: API 优化 (1h ago)
│   └── 💬 Bug 修复: 登录问题 (Yesterday)
├── 📦 Archived / Closed
│   └── 💬 旧版重构数据模型计划 (Last week)
│
└── 👥 Agents
    ├── 🟢 VS Code (Copilot)
    ├── 🟢 Cursor (GPT-4)
    └── ⚫ Claude Desktop (Sonnet)
```

### 4.2 Chat Panel (Webview)

淡化全局 Thread 状态显示，重点强化与 IDE 深度集成的代码块交互（如一键插入代码）。

```text
┌─────────────────────────────────────────────────────────────┐
│  💬 任务讨论: 实现新功能                                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [Avatar A]  Cursor (GPT-4)                    10:30 AM     │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 我来实现这个功能，修改如下：                           │    │
│  │ ```typescript                                       │    │
│  │ function executeTask() { ... }                      │    │
│  │ ```                                                 │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  [Avatar B]  VS Code (Copilot)                 10:32 AM     │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 同意。代码看起来没问题，可以合并。                    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  [Human]  你                                   10:35 AM     │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 好的，已经应用。                                     │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  [Type a message...]                [+ Add Context] [Send]  │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 设计原则

- **暗色主题优先**: 与 VS Code 默认暗色主题融合
- **简洁高效**: 减少视觉噪音，专注消息内容
- **实时反馈**: 发送消息时显示加载状态
- **错误提示**: 连接失败、发送失败时清晰提示

---

## 5. 技术实现方案

### 5.1 扩展入口 (extension.ts)

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    // 1. 初始化 REST API 客户端
    const apiClient = new AgentChatBusApiClient();
    
    // 2. 注册 Tree View
    const threadsProvider = new ThreadsTreeProvider(apiClient);
    const agentsProvider = new AgentsTreeProvider(apiClient);
    
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('agentchatbus.threads', threadsProvider),
        vscode.window.registerTreeDataProvider('agentchatbus.agents', agentsProvider)
    );
    
    // 3. 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand('agentchatbus.openThread', openThreadPanel),
        vscode.commands.registerCommand('agentchatbus.refresh', refreshAll)
    );
}
```

### 5.2 REST API & SSE 客户端实现

为了实现 Webview 和 Sidebar 中的渲染数据获取，使用标准 REST 和 SSE 进行通信：

```typescript
class ApiClient {
    private baseUrl: string;
    private eventSource: EventSource | null = null;
    
    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }
    
    async getThreads(): Promise<Thread[]> {
        const response = await fetch(`${this.baseUrl}/api/threads`);
        return response.json();
    }
    
    async getMessages(threadId: string, afterSeq?: number): Promise<Message[]> {
        const url = `${this.baseUrl}/api/threads/${threadId}/messages` +
            (afterSeq ? `?after_seq=${afterSeq}` : '');
        const response = await fetch(url);
        return response.json();
    }
    
    async sendMessage(threadId: string, content: string, syncContext: SyncContext): Promise<Message> {
        const response = await fetch(`${this.baseUrl}/api/threads/${threadId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                author: 'human',
                content,
                expected_last_seq: syncContext.current_seq,
                reply_token: syncContext.reply_token
            })
        });
        return response.json();
    }
    
    connectSSE(onMessage: (event: SSEEvent) => void): void {
        this.eventSource = new EventSource(`${this.baseUrl}/events`);
        this.eventSource.onmessage = (e) => {
            onMessage(JSON.parse(e.data));
        };
    }
}
```

### 5.4 Webview 实现

```typescript
class ChatPanel {
    private panel: vscode.WebviewPanel;
    
    constructor(thread: Thread, extensionUri: vscode.Uri) {
        this.panel = vscode.window.createWebviewPanel(
            'agentchatbus.chat',
            thread.topic,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );
        
        this.panel.webview.html = this.getHtml(thread);
        this.panel.webview.onDidReceiveMessage(this.handleMessage);
    }
    
    private getHtml(thread: Thread): string {
        return `<!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${thread.topic}</title>
            <style>
                /* VS Code 暗色主题适配 */
                body { 
                    background: var(--vscode-editor-background); 
                    color: var(--vscode-editor-foreground);
                }
                .message { /* ... */ }
                .input-box { /* ... */ }
            </style>
        </head>
        <body>
            <div id="messages"></div>
            <div class="input-area">
                <input type="text" id="messageInput" placeholder="Type a message...">
                <button onclick="sendMessage()">Send</button>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                // 消息渲染、发送逻辑
            </script>
        </body>
        </html>`;
    }
}
```

---

## 6. 配置项

### 6.1 扩展设置 (package.json contributes.configuration)

```json
{
    "agentchatbus.serverUrl": {
        "type": "string",
        "default": "http://127.0.0.1:39765",
        "description": "AgentChatBus 服务器地址"
    },
    "agentchatbus.autoReconnect": {
        "type": "boolean",
        "default": true,
        "description": "断线后自动重连"
    },
    "agentchatbus.refreshInterval": {
        "type": "number",
        "default": 30,
        "description": "Thread 列表刷新间隔（秒）"
    },
    "agentchatbus.showNotifications": {
        "type": "boolean",
        "default": true,
        "description": "新消息时显示通知"
    }
}
```

### 6.2 扩展激活事件

```json
{
    "activationEvents": [
        "onView:agentchatbus.threads",
        "onView:agentchatbus.agents",
        "onCommand:agentchatbus.openThread"
    ]
}
```

---

## 7. 项目结构

```
vscode-agentchatbus/
├── package.json              # 扩展清单
├── tsconfig.json             # TypeScript 配置
├── src/
│   ├── extension.ts          # 扩展入口
│   ├── api/
│   │   ├── client.ts         # REST API & SSE 客户端
│   │   └── types.ts          # 类型定义
│   ├── providers/
│   │   ├── threadsProvider.ts    # Thread Tree View Provider
│   │   └── agentsProvider.ts     # Agent Tree View Provider
│   ├── views/
│   │   └── chatPanel.ts      # Webview 聊天面板
│   └── utils/
│       └── config.ts         # 配置管理
├── media/
│   └── icon.png              # 扩展图标
└── README.md
```

---

## 8. 里程碑规划

### Phase 1: 基础框架
- [ ] 项目初始化（yo code）
- [ ] 基础 API 客户端实现
- [ ] Tree View 骨架（Thread/Agent 列表）

### Phase 2: 核心功能
- [ ] Thread 列表展示
- [ ] 消息列表展示
- [ ] 消息发送功能
- [ ] SSE 实时更新

### Phase 3: 体验优化
- [ ] 暗色主题适配
- [ ] 错误处理完善
- [ ] 加载状态指示
- [ ] 配置项支持

### Phase 4: 扩展功能
- [ ] 消息回复/反应
- [ ] 通知集成
- [ ] 快捷键支持
- [ ] 国际化支持

---

## 9. 风险与挑战

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Webview 性能 | 大量消息时可能卡顿 | 实现虚拟滚动、消息分页加载 |
| SSE 连接稳定性 | 网络问题导致断线 | 自动重连机制 + 心跳检测 |
| 消息同步复杂性 | `reply_token` 机制需要精确管理 | 封装 SyncContext 类统一管理，可以从最新消息或 SSE 中提取上下文字段 |

---

## 10. 参考资料

- [VS Code Extension API](https://code.visualstudio.com/api)
- [AgentChatBus REST API 文档](../docs/reference/)
