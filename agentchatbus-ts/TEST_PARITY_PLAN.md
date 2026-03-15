# TypeScript 版本测试移植计划

## 当前状态

### Python 版本
- **总测试数**: 405 个
- **测试文件**: 38 个
- **覆盖范围**: 完整的单元测试、集成测试、端到端测试

### TypeScript 版本  
- **总测试数**: 21 个
- **测试文件**: 5 个
- **覆盖范围**: 基础功能测试
- **失败测试**: 9 个 (数据库锁定问题)

## 测试差距分析

### 已移植的测试类别
✅ **Unit Tests** (1 个)
- memoryStore.test.ts - 基础存储测试

✅ **Integration Tests** (15 个)
- httpServer.test.ts - HTTP 端点兼容性测试
  - Thread CRUD
  - Message posting with sync
  - Agent registration
  - Image upload
  - MCP tools integration
  - IDE sessions

✅ **Parity Tests** (5 个)
- bus_connect.test.ts (1 个) - bus_connect 流程测试
- msg_sync.test.ts (4 个) - 消息同步容差测试

### 未移植的关键测试类别 (384 个测试缺口)

#### 1. Agent 相关测试 (约 50 个)
❌ test_agent_registry.py - Agent 注册/恢复/心跳
❌ test_agent_capabilities.py - capabilities/skills 功能  
❌ test_agent_attention_mechanisms.py - 注意力机制
❌ test_agent_status.py - Agent 状态追踪

#### 2. Message 相关测试 (约 80 个)
❌ test_msg_post.py - 消息发布严格同步
❌ test_msg_wait.py - 长轮询和 fast_return 机制
❌ test_msg_list.py - 消息列表和分页
❌ test_msg_get.py - 单消息获取
❌ test_msg_edit.py - 消息编辑和历史
❌ test_msg_react.py - reactions 功能
❌ test_msg_search.py - 全文搜索 (FTS5)

#### 3. Thread 相关测试 (约 60 个)
❌ test_thread_create.py - Thread 创建和认证
❌ test_thread_list.py - Thread 列表和过滤
❌ test_thread_settings.py - Thread 设置管理
❌ test_thread_templates.py - Thread 模板功能
❌ test_thread_pagination.py - Thread 分页

#### 4. Sync & Token 相关测试 (约 70 个)
❌ test_bus_connect.py - ✅ 已部分移植 (23 个 Python tests)
❌ test_reply_token.py - reply_token 生命周期
❌ test_seq_mismatch.py - seq 容错和恢复
❌ test_rate_limit.py - Rate limiting

#### 5. Content Filter 相关测试 (约 20 个)
❌ test_content_filter.py - 内容过滤和密钥检测
❌ test_human_only.py - human_only 消息投影

#### 6. Admin Coordinator 相关测试 (约 30 个)
❌ test_admin_coordinator_loop.py - 管理员协调循环
❌ test_admin_decision_api.py - 管理员决策 API

#### 7. Image & Attachment 测试 (约 25 个)
❌ test_image_flow.py - 图片上传和展示流程
❌ test_image_paste.py - 图片粘贴功能

#### 8. Security & Hardening 测试 (约 40 个)
❌ test_security_hardening.py - 安全加固
❌ test_upload_hardening.py - 上传安全
❌ test_database_safety.py - 数据库安全

#### 9. Quality Gates (约 10 个)
❌ test_quality_gate.py - 质量门控

## 优先级移植计划

### Phase 1 - 高优先级 (核心功能) - 预计 80 个测试
1. **Agent 基础功能** (15 个)
   - test_agent_registry.py (8 个)
   - test_agent_heartbeat.py (4 个)
   - test_agent_resume.py (3 个)

2. **Message 基础功能** (35 个)
   - test_msg_post_strict_sync.py (12 个)
   - test_msg_wait_polling.py (10 个)
   - test_msg_list_basic.py (8 个)
   - test_msg_get_single.py (5 个)

3. **Thread 基础功能** (20 个)
   - test_thread_create_auth.py (8 个)
   - test_thread_list_filter.py (7 个)
   - test_thread_get_delete.py (5 个)

4. **Sync & Tokens** (10 个)
   - test_reply_token_lifecycle.py (6 个)
   - test_seq_tolerance.py (4 个)

### Phase 2 - 中优先级 (增强功能) - 预计 120 个测试
1. **Template 功能** (12 个)
2. **Reactions** (15 个)
3. **Message Edit** (18 个)
4. **Search** (10 个)
5. **Rate Limiting** (8 个)
6. **Content Filter** (20 个)
7. **Human-only Messages** (17 个)
8. **Attention Mechanisms** (20 个)

### Phase 3 - 低优先级 (高级功能) - 预计 184 个测试
1. **Admin Coordinator** (30 个)
2. **Image Flow** (25 个)
3. **Security Hardening** (40 个)
4. **Quality Gates** (10 个)
5. **E2E Scenarios** (50 个)
6. **Performance** (29 个)

## 具体实施步骤

### Step 1: 修复当前失败测试
- [ ] 解决数据库锁定问题 (MemoryStore 并发访问)
- [ ] 修复 waiting_agents 属性缺失
- [ ] 修正 MCP endpoint 路径

### Step 2: 创建测试基础设施
```typescript
// tests/helpers/test-server.ts
export async function startTestServer(port: number, dbPath: string) {
  // 启动测试服务器
}

export async function stopTestServer() {
  // 停止测试服务器
}

export function createTestAgent(ide: string, model: string) {
  // 创建测试 agent
}
```

### Step 3: 移植核心测试 (Phase 1)
按以下顺序移植:
1. test_agent_registry.ts
2. test_msg_post_strict_sync.ts  
3. test_msg_wait_polling.ts
4. test_thread_create_auth.ts

### Step 4: 建立 CI/CD 测试流水线
- GitHub Actions 配置
- 测试覆盖率报告
- 性能基准测试

## 目标
- **短期** (2 周): 达到 100 个测试，覆盖核心功能
- **中期** (1 个月): 达到 250 个测试，覆盖所有主要功能
- **长期** (2 个月): 达到 400+ 个测试，与 Python 版本持平

## 成功标准
- ✅ 所有测试通过
- ✅ 测试覆盖率 > 85%
- ✅ 关键路径 100% 覆盖
- ✅ 性能测试达标
- ✅ 无数据库锁定问题
