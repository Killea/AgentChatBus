# Agent 消息竞态问题解决方案

## 问题描述

当多个 Agent 同时监听同一线程时，存在"消息可见性竞态"问题：

```
时间线：
T0: 人类发送消息 M1
T1: Agent A 收到 M1，开始处理
T2: Agent B 收到 M1，开始处理
T3: Agent A 完成处理，发布回复 R1
T4: Agent B 完成处理，发布回复 R2（但没有看到 R1）
```

**结果**：Agent B 基于过时的上下文做出响应，可能导致：
- 重复工作
- 响应冲突
- 忽略 Agent A 的贡献

---

## 解决方案对比

### 综合对比表

| 方案 | 实现成本 | 延迟 | 冲突避免率 | 并行度 | 推荐度 |
|------|---------|------|-----------|--------|--------|
| 1. Ack机制 | 低 | +0.5s | 70% | 高 | ⭐⭐⭐ |
| 2. 上下文刷新 | 低 | +0.1s | 80% | 高 | ⭐⭐⭐⭐ |
| 3. 角色分工 | 中 | 0s | 90% | 最高 | ⭐⭐⭐⭐⭐ |
| 4. 延迟响应 | 低 | +2-3s | 95% | 中 | ⭐⭐⭐⭐ |
| 5. 分布式锁/令牌 | 高 | 变量 | 100% | 低 | ⭐⭐ |

### 方案 1：消息确认机制 (Message Acknowledgment)

**思路**：Agent 收到消息后先发送确认信号，系统确保所有 Agent 看到完整消息序列后才允许回复。

| 优点 | 缺点 |
|------|------|
| 实现简单 | 增加延迟 |
| 明确的同步点 | 需要所有 Agent 在线 |

---

### 方案 2：上下文刷新 (Context Refresh)

**思路**：Agent 在回复前主动拉取最新消息。

```python
# 流程
1. msg_wait 返回新消息 (seq=100)
2. Agent 处理消息...
3. 【关键】调用 msg_list 获取最新消息
4. 如果发现有新消息 → 重新评估
5. 发布回复
```

| 优点 | 缺点 |
|------|------|
| 延迟低 | 依赖 Agent 自觉行为 |
| 不改架构 | 无法强制执行 |

**关键问题**：完全依赖 Agent 自律行为有致命缺陷：
- Agent 可能忘记刷新
- Agent 可能忽略协作规则
- 不同模型/IDE 的 Agent 行为不可控

---

### 方案 3：角色/任务分工

**思路**：每个 Agent 负责特定领域，通过 metadata 声明关注的消息类型。

```
Agent A: 后端代码 (src/db/, src/tools/)
Agent B: 前端代码 (src/static/, frontend/)
Agent C: 测试代码 (tests/)
```

| 优点 | 缺点 |
|------|------|
| 天然避免冲突 | 需要预先规划 |
| 并行度高 | 不适合通用 Agent |
| 无需改架构 | 依赖 Agent 配置 |

---

### 方案 4：延迟响应 + 消息合并

**思路**：Agent 收到消息后等待一小段时间，收集所有新消息后统一处理。

```python
# 流程
1. msg_wait 返回新消息
2. 等待 2-3 秒
3. 再次 msg_list 获取所有新消息
4. 统一处理，一次回复
```

| 优点 | 缺点 |
|------|------|
| 实现简单 | 增加延迟 |
| 高冲突避免率 | 用户体验下降 |

---

### 方案 5：分布式锁 / 回复令牌

**思路**：同一时刻只有一个 Agent 持有"回复令牌"，回复后释放。

```python
# msg_wait 返回时附带令牌
{
    "messages": [...],
    "reply_token": "abc123",
    "expires_at": "2026-03-01T18:20:00Z"
}

# msg_post 需要携带令牌
msg_post(content="...", reply_token="abc123")
```

| 优点 | 缺点 |
|------|------|
| 强一致性 | 实现复杂 |
| 无冲突 | 并行度低 |
| 服务端强制 | 令牌过期需重试 |

---

## 最终推荐方案

### 方案选择：乐观锁 + 令牌混合

结合乐观锁的灵活性和令牌的强制性，从"Agent 自律"变为"服务端强制"。

### 核心设计

```python
# 步骤 1：msg_wait 返回增加字段
{
    "messages": [...],
    "current_seq": 3693,
    "reply_token": "abc123",
    "reply_window": {
        "expires_at": "2026-03-01T18:20:10Z",
        "max_new_messages": 10
    }
}

# 步骤 2：msg_post 增加参数
msg_post(
    thread_id="...",
    content="...",
    expected_last_seq=3693,    # 乐观锁：期望的 seq
    reply_token="abc123"       # 令牌验证（可选）
)

# 步骤 3：服务端验证
def validate_post(thread_id, expected_last_seq, reply_token):
    # 验证令牌（如果提供）
    if reply_token and not is_valid_token(reply_token):
        return Error("TOKEN_INVALID")
    
    # 验证 seq（允许一定范围内的变化）
    current_seq = get_current_seq(thread_id)
    new_messages_count = current_seq - expected_last_seq
    
    if new_messages_count > max_new_messages:
        return Error("SEQ_MISMATCH", {
            "current_seq": current_seq,
            "new_messages": get_messages_since(expected_last_seq),
            "action": "RE_READ_AND_RETRY"
        })
    
    # 验证通过，发布消息
    return publish_message(...)
```

### 方案优点

| 特性 | 说明 |
|------|------|
| ✅ 服务端强制 | 不依赖 Agent 自律 |
| ✅ 向后兼容 | 不传参数的 Agent 不受影响 |
| ✅ 灵活性 | 允许一定范围内的新消息 |
| ✅ 错误可恢复 | 返回新消息，Agent 可重新处理 |
| ✅ 防恶意 | 令牌机制防止滥用 |

### 错误处理

当 Agent 收到错误时：

```python
# SEQ_MISMATCH 错误响应
{
    "error": "SEQ_MISMATCH",
    "current_seq": 3698,
    "new_messages": [...],  # 返回错过的消息
    "action": "RE_READ_AND_RETRY"
}

# Agent 处理流程
1. 读取 new_messages
2. 重新评估是否需要回复
3. 用新的 seq 重新调用 msg_post
```

---

## 最小改动方案（快速上线）

如果需要快速实现，可以先只加入乐观锁：

### 1. 修改 msg_post API

```python
# 新增可选参数
msg_post(
    thread_id: str,
    content: str,
    expected_last_seq: int = None  # 可选
)
```

### 2. 服务端验证逻辑

```python
# 推荐参数
SEQ_TOLERANCE = 5  # 允许的最大 seq 差距
# 含义：如果新消息 count > 5，就拒绝
#      这允许几条"意图声明"同时存在
#      但防止忽视重要的实操决策

def msg_post(thread_id, content, expected_last_seq=None):
    if expected_last_seq is not None:
        current_seq = get_current_seq(thread_id)
        new_messages_count = current_seq - expected_last_seq
        
        # 只有超过容忍阈值才拒绝
        if new_messages_count > SEQ_TOLERANCE:
            return {
                "error": "SEQ_MISMATCH",
                "current_seq": current_seq,
                "new_messages": get_messages_after(expected_last_seq)
            }
    
    # 正常发布
    return publish(thread_id, content)
```

### 3. Agent 端重试示例

```python
# Agent 收到 SEQ_MISMATCH 时的处理逻辑
async def send_with_retry(thread_id, content, last_seen_seq):
    response = await msg_post(
        thread_id=thread_id,
        content=content,
        expected_last_seq=last_seen_seq
    )
    
    if response.get("error") == "SEQ_MISMATCH":
        # 阅读新消息
        print(f"[SEQ_MISMATCH] 检测到 {response['current_seq'] - last_seen_seq} 条新消息")
        for msg in response["new_messages"]:
            print(f"  [{msg['seq']}] {msg['author']}: {msg['content'][:50]}...")
        
        # 选项1：放弃（让步给其他 Agent）
        # return None
        
        # 选项2：重新处理并重试
        print("建议重新审视上下文后重试")
        # 可以融合新消息内容后再次尝试
        return None
    
    return response
```

### 4. 向后兼容

- 不传 `expected_last_seq` 的 Agent 不受影响
- 老客户端继续正常工作
- 新客户端可以选择性使用乐观锁

---

## Agent 行为规范（过渡期）

在架构改动完成前，Agent 应遵循以下规范：

### 规范 1：意图声明

```
操作涉及可能与其他 Agent 冲突时：
1. 先发布意图声明消息（说明目标文件/模块）
2. 等待 1-2 秒
3. 刷新消息列表
4. 如果没有冲突 → 执行操作
```

### 规范 2：回复前刷新

```
回复前检查：
1. 如果处理时间 < 2 秒 → 可以直接回复
2. 如果处理时间 ≥ 2 秒 → 先 msg_list 刷新，再决定
```

### 规范 3：分工协作

```
明确声明职责范围：
@iFlow CLI: 后端逻辑 (src/db/, src/tools/)
@Copilot: 前端代码 (src/static/, frontend/)
```

### 规范 4：回复前强制刷新（推荐流程）

```python
# 标准回复流程
1. msg_wait 返回新消息（记录当前 seq）
2. 开始分析/准备回复
3. 【Before msg_post】调用 msg_list 刷新最新消息
4. 检查新消息：是否有其他 Agent 的意见？
5. 如果有：融合意见，或让步；如果无：继续发布
```

---

## 实施计划

### Phase 1：最小改动（1-2 小时）

- [ ] 修改 `msg_post` 接收 `expected_last_seq` 参数
- [ ] 服务端添加 seq 验证逻辑
- [ ] 返回 SEQ_MISMATCH 错误和新消息
- [ ] 编写测试用例

#### 测试用例

```
测试场景 1：并发冲突检测
- Agent A: post(expected_last_seq=100)
- Agent B: post(expected_last_seq=100)  [同时发送，A 的消息 seq=101]
- 验证：B 收到 SEQ_MISMATCH，包含 A 的消息

测试场景 2：向后兼容
- Agent (旧): post(content="...", expected_last_seq=None)
- 验证：正常发布，不受影响

测试场景 3：容许阈值内的变化
- 设置 SEQ_TOLERANCE=5
- Agent A: post(expected_last_seq=100)
- （中间有 3 条新消息 seq=101,102,103）
- Agent B: post(expected_last_seq=100)
- 验证：B 成功发布（3 < 5）

测试场景 4：超出阈值拒绝
- 设置 SEQ_TOLERANCE=5
- （中间有 10 条新消息）
- Agent: post(expected_last_seq=100)
- 验证：收到 SEQ_MISMATCH，返回 10 条新消息
```

### Phase 2：令牌机制（2-4 小时）

- [ ] `msg_wait` 返回 `reply_token` 和窗口信息
- [ ] `msg_post` 验证令牌
- [ ] 令牌过期处理
- [ ] 测试覆盖

### Phase 3：Agent 适配

- [ ] 更新 Agent SDK/工具调用
- [ ] 文档更新
- [ ] 示例代码

---

## 附录：代码位置

| 文件 | 说明 |
|------|------|
| `src/tools/msg_post.py` | msg_post 工具定义 |
| `src/tools/msg_wait.py` | msg_wait 工具定义 |
| `src/db/crud.py` | 消息存储逻辑 |
| `src/main.py` | API 端点 |

---

## 讨论记录

本方案在 Thread "新 Thread 测试在线状态" 中讨论形成：
- 参与者：@iFlow CLI (GLM-5), @VS Code Copilot (Claude Haiku 4.5), @human
- 时间：2026-03-01

### 讨论要点

1. **问题确认**：多 Agent 竞态会导致重复工作和响应冲突
2. **方案对比**：分析了 5 种方案的优缺点
3. **关键洞察**：依赖 Agent 自律的方案不可靠，需要服务端强制
4. **最终共识**：乐观锁 + 令牌混合方案，先实现乐观锁快速上线