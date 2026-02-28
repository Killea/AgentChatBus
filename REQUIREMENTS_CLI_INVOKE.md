# 需求文档：支持CLI Agent主动唤醒机制

**文档版本**: 1.0  
**创建日期**: 2026-02-28  
**状态**: 讨论中

---

## 目录
1. [背景](#背景)
2. [核心设计理念](#核心设计理念)
3. [功能需求](#功能需求)
4. [系统架构](#系统架构)
5. [数据模型](#数据模型)
6. [API变更](#api变更)
7. [安全考量](#安全考量)
8. [实现计划](#实现计划)

---

## 背景

### 现有问题
1. **IDE Agent频繁断线**：Cursor、VS Code等IDE agent通过SSE长连接运行msg_wait时，经常因为网络超时、异常崩溃或IDE进程退出而断线
2. **无自动恢复机制**：断线后无法自动重连，需要人工干预重新注册
3. **资源占用**：IDE agent必须保持msg_wait循环才能接收消息，持续占用连接和资源

### 业务需求
- 支持CLI模式的agent（如Copilot CLI）在需要时被主动唤醒
- 取消对msg_wait的依赖 - CLI agent可以自由启动和退出
- 实现人类通过MCP Web UI主动邀请CLI agent参与讨论
- 保留IDE agent的long-connection模式（继续使用msg_wait）

---

## 核心设计理念

### 两种Agent模式并存

#### 1️⃣ **CLI Agent（可被唤醒，无需msg_wait）**
- **定义**：支持通过命令行启动、调用和会话恢复的自动化agent
- **生命周期**：
  - 启动 → agent_register → 参与讨论 → 退出
  - 完全无状态，可随时启动或停止
- **Session管理**：由agent自己负责，MCP无需干预
- **资源特性**：进程退出时释放所有资源

#### 2️⃣ **IDE Agent（SSE长连接，需要msg_wait）**
- **定义**：通过SSE持久连接与MCP通信的IDE应用
- **生命周期**：
  - 注册 → 循环msg_wait(保活) → IDE关闭时断开
  - 实时接收推送通知
- **资源特性**：持续占用连接但无需重启，体验流畅

### 关键原则
✅ **Agent自主性**：Session由agent自己管理，MCP不涉及Session存储、验证、生命周期  
✅ **运维控制**：CLI invoke_command由运维配置，agent无法自己报告  
✅ **人类决策**：邀请agent加入是显式动作，通过Web UI发起  
✅ **向后兼容**：现有IDE agent工作流不变

---

## 功能需求

### FR-1: 本地CLI Agent配置管理
**描述**：运维可以预配本地可用的CLI agents  
**实现位置**：
- 新配置文件：`config/available-agents.json` 或 `src/config.py`
- 格式示例：
```json
{
  "copilot-cli": {
    "name": "Copilot CLI",
    "description": "GitHub Copilot Command Line Interface",
    "invoke_command": "copilot invite --thread {thread_id} --api http://localhost:8000",
    "enabled": true
  },
  "cursor-cli": {
    "name": "Cursor CLI",
    "invoke_command": "cursor-agent resume --thread {thread_id} --api http://localhost:8000",
    "enabled": true
  }
}
```

### FR-2: Web UI显示可邀请的Agent列表
**描述**：MCP Web界面显示本地配置的可邀请CLI agents  
**实现位置**：
- 在Thread界面或Compose area添加"邀请Agent"按钮
- 显示列表：Copilot CLI、Cursor CLI等
- 允许人类点击邀请特定agent参与当前thread

### FR-3: Agent Invite工具
**描述**：新MCP工具用于人类/系统邀请CLI agent加入thread  
**工具名称**：`agent_invite`  
**参数**：
```
{
  "agent_name": string,      // "copilot-cli" 或 "cursor-cli"
  "thread_id": string,       // 目标thread的UUID
}
```
**返回值**：
```
{
  "ok": boolean,
  "agent_name": string,
  "reason": string,          // 成功或失败原因
  "command_executed": string // 实际执行的命令（用于调试）
}
```

### FR-4: 动态命令执行
**描述**：agent_invite工具执行配置中的invoke_command，支持占位符替换  
**占位符**：
- `{thread_id}` → 替换为实际的thread_id
- 可扩展：`{thread_topic}`, `{bus_address}` 等
**执行方式**：
- 使用asyncio.create_subprocess_shell异步启动
- 不阻塞agent_invite返回
- 捕获subprocess的stderr/stdout用于日志和错误追踪

### FR-5: Agent Availability状态
**描述**：agent_list返回时区分agent是否可邀请  
**处理逻辑**：
```
IF agent.resume_command非空:
   → is_available = true  (CLI agent，可被唤醒)
ELSE:
   → is_available = agent.is_online  (IDE agent，需实际在线)
```

---

## 系统架构

### 整体流程图
```
┌─────────────────────────────────────────────────────────┐
│ 1. 运维配置                                               │
│    config/available-agents.json:                         │
│    {copilot: {invoke_command: "..."}                     │
└────────────────┬──────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ 2. MCP Server启动                                         │
│    加载配置，提供agent_invite工具                        │
│    Web UI显示可邀请的agent列表                           │
└────────────────┬──────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ 3. 人类交互                                               │
│    在Thread中点击"邀请Copilot"按钮                       │
│    → 调用agent_invite("copilot-cli", "BusR01")          │
└────────────────┬──────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ 4. MCP执行唤醒                                            │
│    获取config["copilot-cli"]["invoke_command"]          │
│    替换占位符：{thread_id} → "BusR01"                   │
│    异步执行：subprocess.create_subprocess_shell(cmd)    │
└────────────────┬──────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ 5. CLI Agent启动                                          │
│    处理自己的session初始化或恢复                         │
│    调用agent_register加入thread                         │
│    参与讨论                                               │
└────────────────┬──────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ 6. Agent退出                                              │
│    讨论完成后自行退出或unregister                        │
│    Session由agent自己保管，MCP无需追踪                   │
└─────────────────────────────────────────────────────────┘
```

### 代码层级
```
src/
├── config.py                    # 加载available-agents配置
├── mcp_server.py               # 修改：agent_list增加is_available字段
├── tools/
│   └── dispatch.py             # 新增：handle_agent_invite
├── db/
│   ├── models.py               # 修改：AgentInfo无需resume_command字段
│   └── crud.py                 # 无重大变更

config/
└── available-agents.json       # 新文件：本地CLI agent配置

static/
└── js/
    └── shared-api.js           # 修改：支持agent_invite调用
    shared-threads.js           # 修改：显示邀请按钮
```

---

## 数据模型

### 配置文件: config/available-agents.json
```json
{
  "agents": [
    {
      "name": "copilot-cli",
      "display_name": "Copilot CLI",
      "description": "GitHub Copilot Command Line Interface",
      "invoke_command": "copilot invite --thread {thread_id} --bus http://localhost:8000",
      "timeout_seconds": 30,
      "enabled": true
    },
    {
      "name": "cursor-cli",
      "display_name": "Cursor CLI",
      "invoke_command": "cursor-agent resume --thread {thread_id}",
      "timeout_seconds": 30,
      "enabled": true
    }
  ]
}
```

### MCP Tool定义
```python
# mcp_server.py
types.Tool(
    name="agent_invite",
    description=(
        "Invite a local CLI agent to join a thread. "
        "The agent will be spawned with the configured invoke_command. "
        "This is an explicit, human-driven action (not automatic). "
        "The agent itself manages its session and connection lifecycle."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "agent_name": {
                "type": "string",
                "description": "Name of the agent from config (e.g. 'copilot-cli')"
            },
            "thread_id": {
                "type": "string",
                "description": "UUID of the thread to invite the agent to"
            },
        },
        "required": ["agent_name", "thread_id"],
    },
)
```

### agent_list返回值扩展
```python
# 现有字段保留，新增：
{
  "agent_id": "...",
  "name": "Copilot CLI",
  "is_online": false,              # 物理连接状态
  "is_invitable": true,            # 是否可被邀请（对应resume_command）
  "is_available": true,            # 综合判断：可获取的状态
  ...
}
```

---

## API变更

### 新增Tool: agent_invite
**调用示例**：
```json
{
  "name": "agent_invite",
  "arguments": {
    "agent_name": "copilot-cli",
    "thread_id": "85a1f013-f4fd-47e4-8aba-607221e44c13"
  }
}
```

**返回示例（成功）**：
```json
{
  "ok": true,
  "agent_name": "copilot-cli",
  "reason": "Agent invitation command queued successfully",
  "command_executed": "copilot invite --thread 85a1f013-f4fd-47e4-8aba-607221e44c13 --bus http://localhost:8000"
}
```

**返回示例（失败）**：
```json
{
  "ok": false,
  "agent_name": "copilot-cli",
  "reason": "Agent 'copilot-cli' not found in configuration",
  "command_executed": ""
}
```

### 修改Tool: agent_register
**变更**：`resume_command` 参数仅作为可选的metadata保存，不用于自动唤醒逻辑  
**理由**：所有CLI invoke由显式的agent_invite驱动，而非@mention触发

### 修改Tool: agent_list
**新增字段**：`is_invitable`, `is_available`（见数据模型）

---

## 安全考量

### SC-1: 命令注入防护
**风险**：运维可能误配错误的命令，或被社工/攻击者篡改配置文件  
**防护措施**：
1. 配置文件只由运维人员维护，权限控制严格
2. 每次执行前记录完整的invoke_command日志
3. Subprocess执行采用**参数清理**：
   ```python
   # 确保command不包含不期望的shell元字符
   # 使用shlex.quote()对需要quote的部分进行处理
   ```

### SC-2: 权限隔离
**措施**：
1. 建议Subprocess以低权限用户运行（非root/admin）
2. 设置合理的超时（30秒）防止hung进程
3. 限制Subprocess能访问的资源

### SC-3: 审计日志
**记录**：
- 每场agent_invite调用：who, when, which_agent, which_thread
- 每场invoke_command执行：command内容, return_code, stderr/stdout摘要

---

## 实现计划

### Phase 1: 配置和架构（第1周）
- [ ] 设计和创建config/available-agents.json模板
- [ ] 修改src/config.py加载配置
- [ ] 在mcp_server.py中定义agent_invite工具

### Phase 2: MCP工具实现（第1-2周）
- [ ] 实现handle_agent_invite在dispatch.py
- [ ] 实现subprocess唤醒逻辑
- [ ] 集成日志记录和错误处理

### Phase 3: 后端支持（第2周）
- [ ] 修改agent_list返回is_invitable和is_available字段
- [ ] 更新agent_register的文档（说明resume_command可选）

### Phase 4: 前端UI（第2-3周）
- [ ] 修改Web UI显示可邀请agent列表
- [ ] 在Thread视图添加"邀请Agent"按钮/菜单
- [ ] 调用agent_invite工具

### Phase 5: 测试和文档（第3周）
- [ ] 编写使用文档：如何配置本地CLI agents
- [ ] 测试complete流程：配置 → 邀请 → Agent启动 → 讨论 → 退出
- [ ] 性能测试：subprocess启动延迟、资源占用

### Phase 6: 生产部署（第4周）
- [ ] 代码审查
- [ ] 文档最终化
- [ ] 线上部署和监控

---

## 关键设计决策

| 决策 | 原因 |
|-----|-----|
| Session由agent自己管理 | 简化MCP设计，减少状态管理复杂度 |
| invoke_command由运维配置 | 防止命令注入风险，集中管理安全策略 |
| 显式邀请而非@自动唤醒 | 更好的可控性，人类明确决策 |
| CLI agent不需resume_command | agent_invite工具负责执行，无需存储 |
| 两种agent模式并存 | 向后兼容，IDE agent继续使用msg_wait |

---

## 未来扩展

### 可考虑的增强（不在本次范围）
1. **自动邀请**：基于关键词/意图自动邀请相关agent
2. **Agent池管理**：预启动agent pool，减少延迟
3. **Session持久化**：MCP辅助记录agent session参数（如运行时长、状态等）
4. **多语言支持**：invoke_command支持多种CLI工具
5. **Healthcheck**：定期检测本地CLI是否可用

---

## 附录：Copilot CLI命令推断

**基于GitHub文档和现有工具的推断**：
```bash
# 可能的invoke命令格式（待确认）
copilot invite --thread "BusR01" --api "http://localhost:8000"
# 或
copilot-cli connect --thread "BusR01" --mcp-endpoint "http://localhost:8000"
```

**待确认项**：
- Copilot CLI的官方启动命令格式
- 是否支持--thread参数或其他指定thread的方式
- 是否需要认证token或其他header
- 会话恢复的具体机制

---

**文档结束**
