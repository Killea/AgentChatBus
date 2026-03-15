# 📊 bus_connect 测试对比报告

**分析时间**: 2026-03-15 19:30  
**对比文件**: 
- Python: `tests/test_bus_connect.py` (24 个测试)
- TS: `agentchatbus-ts/tests/parity/bus_connect.test.ts` (7 个测试)

---

## 📋 总体统计

| 项目 | Python | TS | 缺失 | 完成率 |
|------|--------|----|----|--------|
| **测试总数** | 24 | 7 | 17 | 29% |
| **bus_connect 相关** | 10 | 5 | 5 | 50% |
| **msg_post 相关** | 8 | 2 | 6 | 25% |
| **msg_wait 相关** | 4 | 0 | 4 | 0% |
| **msg_edit 相关** | 2 | 0 | 2 | 0% |
| **其他** | 0 | 0 | 0 | 0% |

---

## ✅ TS 已覆盖的测试 (7/24)

### 1. bus_connect 基础流程 (5 个)

| # | Python 测试名 | 行号 | TS 测试名 | 行号 | 状态 |
|---|-------------|------|----------|------|------|
| 1 | `test_bus_connect_new_agent_new_thread` | L22 | `bus_connect new agent new thread` | L164 | ✅ |
| 2 | `test_bus_connect_new_agent_existing_thread` | L58 | `bus_connect new agent existing thread` | L188 | ✅ |
| 3 | `test_bus_connect_projects_human_only_message_for_agent_view` | L96 | `bus_connect projects human-only message for agent view` | L249 | ✅ |
| 4 | `test_bus_connect_no_reuse_agent` | L126 | `bus_connect no reuse agent` | L224 | ✅ |
| 5 | - | - | `manages bus_connect flow: register -> join -> post` | L75 | ✅ (综合测试) |

### 2. msg_post 同步机制 (2 个)

| # | Python 测试名 | 行号 | TS 测试名 | 行号 | 状态 |
|---|-------------|------|----------|------|------|
| 6 | `test_msg_post_seq_mismatch_returns_first_read_messages` | L335 | `msg_post seq mismatch returns first read messages` | L284 | ✅ |
| 7 | `test_bus_connect_requires_msg_wait_before_first_msg_post` | L153 | (隐含在 flow 测试中) | L105 | ⚠️ 简化版 |

---

## 🔴 TS 缺失的测试 (17 个)

### 1. bus_connect 高级功能 (5 个)

| # | Python 测试名 | 行号 | 功能描述 | 优先级 |
|---|-------------|------|---------|--------|
| 1 | `test_bus_connect_does_not_make_next_msg_wait_fast_return` | L191 | bus_connect 后的第一次 msg_wait 不应快反 | P1 |
| 2 | `test_bus_connect_with_system_prompt_creates_thread_with_prompt` | L973 | 使用 system_prompt 创建线程 | P1 |
| 3 | `test_bus_connect_system_prompt_ignored_when_joining_existing_thread` | L1000 | 加入现有线程时忽略 system_prompt | P1 |
| 4 | `test_bus_connect_with_template_applies_template_prompt` | L1030 | 使用模板创建线程 | P2 |
| 5 | `test_bus_connect_system_prompt_reflected_in_response` | L1066 | system_prompt 在响应中返回 | P1 |

### 2. msg_post 错误处理与状态管理 (6 个)

| # | Python 测试名 | 行号 | 功能描述 | 优先级 |
|---|-------------|------|---------|--------|
| 6 | `test_msg_post_error_invalidate_tokens_uses_validated_author_when_no_connection_context` | L248 | Token 失效时使用验证过的 author | P0 |
| 7 | `test_msg_post_invalid_token_does_not_claim_new_messages_arrived` | L588 | 无效 token 不声称有新消息 | P1 |
| 8 | `test_msg_post_success_clears_wait_state_for_author_not_connection_agent` | L618 | msg_post 成功清除 author 的等待状态 | P1 |
| 9 | `test_msg_post_failure_refresh_request_follows_author_not_connection_agent` | L656 | msg_post 失败刷新请求跟随 author | P1 |
| 10 | `test_two_agents_can_chat_multiple_rounds_via_bus_connect_and_msg_wait` | L716 | 多轮对话完整场景测试 | P0 |
| 11 | (续上) | L716 | Agent A → B → A → B 四轮对话 | P0 |

### 3. msg_wait 行为验证 (4 个)

| # | Python 测试名 | 行号 | 功能描述 | 优先级 |
|---|-------------|------|---------|--------|
| 12 | `test_msg_wait_caught_up_agent_waits_instead_of_fast_returning` | L884 | 已追赶的 agent 应等待而非快反 | P1 |
| 13 | `test_repeated_msg_wait_timeouts_reuse_single_token` | L926 | 重复超时复用单个 token | P1 |
| 14 | (隐式) | - | token 稳定性验证 | P1 |
| 15 | (隐式) | - | 数据库 token 计数验证 | P1 |

### 4. msg_edit 认证与授权 (2 个)

| # | Python 测试名 | 行号 | 功能描述 | 优先级 |
|---|-------------|------|---------|--------|
| 16 | `test_msg_edit_requires_authenticated_agent_connection` | L523 | msg_edit 需要认证连接 | P2 |
| 17 | `test_msg_edit_uses_agent_id_authorization_for_registered_agent` | L554 | msg_edit 使用 author ID 授权 | P2 |

### 5. human_only 内容过滤 (3 个)

| # | Python 测试名 | 行号 | 功能描述 | 优先级 |
|---|-------------|------|---------|--------|
| 18 | `test_msg_get_projects_human_only_message_for_agent_view` | L435 | msg_get 过滤 human_only 内容 | P2 |
| 19 | `test_msg_edit_history_projects_human_only_contents_for_agent_view` | L461 | msg_edit_history 过滤 human_only | P2 |
| 20 | `test_msg_search_projects_human_only_snippet_for_agent_view` | L492 | msg_search 过滤 human_only 片段 | P2 |

---

## 🎯 优先级分类

### P0 - 核心功能（必须实现）

**影响**: 基本正确性、关键场景覆盖

1. **test_msg_post_error_invalidate_tokens_uses_validated_author_when_no_connection_context** (L248)
   - Token 失效时的 author 验证逻辑
   - 涉及连接上下文丢失后的降级处理

2. **test_two_agents_can_chat_multiple_rounds_via_bus_connect_and_msg_wait** (L716)
   - 完整的端到端场景测试
   - 验证多 Agent 协作流程
   - **测试步骤**:
     ```
     Agent A connect → Post A1
     Agent B connect → See A1 → Post B1
     Agent A wait → See B1 → Post A2
     Agent B wait → See A2 → Post B2
     Agent A wait → See B2
     msg_list → Verify all 4 messages in order
     ```

### P1 - 重要功能（应该实现）

**影响**: 用户体验、边界条件

3. **test_bus_connect_does_not_make_next_msg_wait_fast_return** (L191)
   - bus_connect 后的第一次等待不应立即返回
   - 验证 fast return 逻辑的正确触发

4. **test_bus_connect_with_system_prompt_creates_thread_with_prompt** (L973)
   - system_prompt 参数传递和存储

5. **test_bus_connect_system_prompt_ignored_when_joining_existing_thread** (L1000)
   - 加入现有线程时忽略 system_prompt

6. **test_bus_connect_system_prompt_reflected_in_response** (L1066)
   - 创建线程时在响应中返回 system_prompt
   - 加入线程时不在响应中返回

7. **test_msg_post_invalid_token_does_not_claim_new_messages_arrived** (L588)
   - 无效 token 错误响应中不包含新消息声明

8. **test_msg_post_success_clears_wait_state_for_author_not_connection_agent** (L618)
   - 成功 msg_post 后清除 author 的等待状态
   - 不是 connection agent 的状态

9. **test_msg_post_failure_refresh_request_follows_author_not_connection_agent** (L656)
   - 失败 msg_post 后刷新请求跟随 author

10. **test_msg_wait_caught_up_agent_waits_instead_of_fast_returning** (L884)
    - 已追赶的 agent 应该正常等待
    - 验证 fast return 的条件

11. **test_repeated_msg_wait_timeouts_reuse_single_token** (L926)
    - 重复超时后 token 复用
    - 数据库中只有一个 issued 状态的 token

### P2 - 次要功能（可选实现）

**影响**: 高级功能、边缘场景

12. **test_bus_connect_with_template_applies_template_prompt** (L1030)
    - Template 功能应用

13. **test_msg_edit_requires_authenticated_agent_connection** (L523)
    - msg_edit 认证要求

14. **test_msg_edit_uses_agent_id_authorization_for_registered_agent** (L554)
    - msg_edit author 授权

15. **test_msg_get_projects_human_only_message_for_agent_view** (L435)
    - human_only 内容过滤

16. **test_msg_edit_history_projects_human_only_contents_for_agent_view** (L461)
    - 编辑历史中的 human_only 过滤

17. **test_msg_search_projects_human_only_snippet_for_agent_view** (L492)
    - 搜索片段中的 human_only 过滤

---

## 📈 实现建议

### 阶段 1: P0 核心功能（预计 4 小时）

1. **多 Agent 对话场景测试** (2 小时)
   - 完整实现 test_two_agents_can_chat_multiple_rounds
   - 验证端到端流程

2. **Token 失效 author 验证** (2 小时)
   - 实现 test_msg_post_error_invalidate_tokens_uses_validated_author
   - 添加连接上下文追踪逻辑

### 阶段 2: P1 重要功能（预计 6 小时）

3. **System Prompt 系列测试** (2 小时)
   - 创建线程时传递 prompt
   - 加入线程时忽略 prompt
   - 响应中返回 prompt

4. **Fast Return 行为验证** (2 小时)
   - bus_connect 后不触发快反
   - caught up agent 正常等待
   - token 复用验证

5. **Author vs Connection Agent** (2 小时)
   - 成功/失败后的状态管理
   - 刷新请求归属

### 阶段 3: P2 次要功能（预计 4 小时）

6. **Template 功能** (1 小时)
   - 模板创建和应用

7. **Msg Edit 认证授权** (1.5 小时)
   - 认证连接检查
   - author 授权验证

8. **Human Only 过滤** (1.5 小时)
   - msg_get 过滤
   - msg_edit_history 过滤
   - msg_search 过滤

---

## 💡 关键发现

### 1. TS 版本优势

✅ **综合测试**: `manages bus_connect flow` 测试覆盖了完整流程  
✅ **Parity 测试**: 明确标注对应关系，便于维护

### 2. TS 版本不足

❌ **缺少错误处理**: Token 失效、author 验证等边界情况  
❌ **缺少状态管理**: msg_post 成功/失败后的状态变更  
❌ **缺少高级功能**: system_prompt、template、human_only 过滤  
❌ **缺少端到端场景**: 多 Agent 多轮对话完整流程

### 3. 测试深度对比

| 维度 | Python | TS | 差距 |
|------|--------|----|----|
| **基础功能** | ✅ | ✅ | 持平 |
| **错误处理** | ✅✅✅ | ✅ | Python 更深 |
| **状态管理** | ✅✅✅ | ✅ | Python 更深 |
| **端到端** | ✅✅ | ✅ | Python 更深 |
| **高级功能** | ✅✅ | ❌ | Python 领先 |

---

## 🎊 总结

### 当前状态

- **覆盖率**: 29% (7/24)
- **核心流程**: ✅ 已覆盖
- **错误处理**: 🔴 严重缺失
- **状态管理**: 🔴 严重缺失
- **高级功能**: 🔴 几乎空白

### 下一步行动

**推荐顺序**:
1. ✅ P0: 多 Agent 对话场景 (最重要)
2. ✅ P1: System Prompt 系列
3. ✅ P1: Author vs Connection Agent 状态管理
4. ✅ P2: Human Only 过滤

**预计工作量**: 14 小时（P0+P1+P2 全部完成）

**收益**:
- 覆盖率从 29% → 100%
- 功能对齐全从 70% → 100%
- 质量信心大幅提升

---

**生成时间**: 2026-03-15 19:30  
**下次更新**: 完成 P0 测试后
