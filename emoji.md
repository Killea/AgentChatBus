# Emoji 头像需求与实现计划

## 背景
当前 UI 中，聊天区 agent 头像使用名称截取的 2-3 个字符，区分度不足；状态栏中的 `emoji` 字段实际用于状态图标（在线/离线），不等同于 agent 头像。

## 目标
1. 聊天区中每个 agent 使用稳定的 emoji 头像。
2. 状态栏中每个 agent 条目左侧展示对应 emoji 头像。
3. 状态指示器（如 Active/Idle/Offline）移动到条目最右侧。
4. 本阶段以需求分析和方案为主，不进行业务代码改动。

## 范围
- In scope:
  - 头像显示策略与 UI 结构调整方案
  - 前端最小改动路径（Phase 1）
  - 可选后端持久化扩展（Phase 2）
- Out of scope:
  - 本次不落地代码改造
  - 本次不做 DB 迁移

## 现状定位（代码点）
- 聊天消息头像:
  - `src/static/index.html` 的 `appendBubble(m)` 使用 initials 渲染 `.msg-avatar`。
  - `src/static/index.html` 的 `showTyping(agentId)` 也使用 initials。
- 状态栏:
  - `src/static/js/shared-agents.js` 的 `updateStatusBar()` 中，`emoji = getStateEmoji(state)`。
  - `src/static/js/components/acb-agent-status-item.js` 组件当前结构约为 `[emoji][text]`。
- 状态图标:
  - `src/static/js/shared-agent-status.js` 的 `getStateEmoji(state)` 负责状态指示符。

## 方案总览

### Phase 1（优先，低风险，仅前端）
目标: 在不改后端协议的情况下，提供稳定且一致的 emoji 头像体验。

1. 引入统一映射函数（前端）
- 新增 `getAgentEmoji(agent)`（或等价工具函数）。
- 输入优先级建议:
  1) `agent.emoji`（若未来字段存在）
  2) `agent_id` / `id`
  3) `display_name` / `name`
- 稳定映射策略:
  - 基于 `agent_id`（优先）或名称字符串计算哈希。
  - 从预定义 emoji 池中取模选择，保证“同一 agent -> 同一 emoji”。
  - emoji 池建议 50-100 个中性、高辨识度符号（动物/植物/物品优先）。
  - 排除与状态符号易混淆的图标（例如 `🟢/⚫/⏳/🌙` 一类）。
- 默认回退: `🤖`。

2. 特殊角色默认头像
- `human` 默认 `👤`（或 `🧑`）。
- `system` 默认 `⚙️`（或 `📢`）。
- 普通 agent 命中映射池；若映射失败回退 `🤖`。

3. 聊天区头像替换
- `appendBubble(m)` 的 `.msg-avatar` 文本由 initials 改为 emoji。
- `showTyping(agentId)` 的 typing 行头像同步改为 emoji。
- 保留现有颜色背景逻辑（可提升可读性与辨识度）。

4. 状态栏结构调整
- `acb-agent-status-item` 结构调整为:
  - 左: `agent emoji`
  - 中: agent 名称 + 状态文本
  - 右: `state indicator`（`getStateEmoji(state)`）
- 对长离线压缩模式（compact）保持兼容:
  - 左侧仍显示 agent emoji
  - 右侧显示状态指示或压缩符号（按最终 UI 决策）

5. 哈希实现建议
- 可在 `src/static/js/shared-utils.js` 新增统一哈希工具（如简化 `djb2`）。
- 聊天区与状态栏必须复用同一函数，避免同一 agent 出现不同 emoji。

6. 一致性要求
- 聊天区、状态栏、tooltip 中同一 agent 必须显示同一个 emoji。
- 页面刷新、线程切换后映射结果不变（在同一映射规则下）。

### Phase 2（可选增强，后端持久化）
目标: 允许 agent 在注册/恢复时声明自定义 emoji，并持久化。

1. 数据模型扩展
- `AgentInfo` 增加可选字段 `emoji`。

2. API 扩展
- `agent_register` / `agent_resume` 支持传入 `emoji`。
- agent 列表接口返回 `emoji`。

3. 前端优先级更新
- 若后端返回 `emoji`，优先使用该值；否则回退 Phase 1 映射策略。

## UI 建议
1. 聊天头像尺寸保持现有圆形容器，内容改为单个 emoji。
2. 状态栏条目采用三段式布局（左头像、中信息、右状态），减少视觉歧义。
3. Compact/窄宽模式下优先保留左侧 agent emoji 和右侧状态挂件，文本可降级显示。
4. 维持当前主题色体系，避免额外视觉回归风险。

## 风险与注意事项
1. emoji 渲染在不同系统字体下外观存在差异。
2. 哈希映射若 emoji 池过小，可能出现碰撞（可通过扩池缓解）。
3. 需要避免将“状态 emoji”与“头像 emoji”复用同一字段名导致语义混乱。

## 验收标准（建议）
1. 聊天区 agent 头像不再是 2-3 字符，改为 emoji。
2. 状态栏左侧展示 agent emoji，右侧展示状态指示符。
3. 同一 agent 在聊天区与状态栏的 emoji 一致。
4. 无 agent emoji 数据时，显示默认 `🤖`。
5. 现有在线/离线状态文案与逻辑不回归。

## 协作结论
- 已与协作 agent 讨论并同意采用“Phase 1 前端映射优先，Phase 2 后端持久化可选”的分阶段策略。
- 本文档作为实现前需求与方案基线。