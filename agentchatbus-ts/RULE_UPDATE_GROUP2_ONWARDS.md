# 规则更新通知 - Group 2 及以后强制执行

## 📢 新增重要规则

**文件名**: [`TEST_MIGRATION_ENFORCEMENT.md`](./TEST_MIGRATION_ENFORCEMENT.md)  
**生效时间**: 立即生效  
**适用范围**: Group 2 及以后的所有测试移植

---

## 🎯 核心原则 (第 5 条原则)

> **5. 逻辑优先**: 移植测试的目的是验证逻辑正确性，不是追求通过率

---

## ⚠️ 强制执行流程

### 当测试失败时

```
测试失败 
  ↓
读取 Python 源代码
  ↓
理解预期行为
  ↓
对比 TS 实现差异
  ↓
修复 TS 源代码 ← 关键：必须修复代码，不是修改测试
  ↓
重新运行测试
  ↓
验证 100% 通过
```

### 严格禁止的行为 ❌

1. ❌ 修改测试断言使其"通过"
2. ❌ 使用 `.skip` 跳过失败测试
3. ❌ 降低断言标准
4. ❌ Mock 绕过核心逻辑
5. ❌ 忽略 Error name/message/属性差异

### 必须执行的步骤 ✅

1. ✅ 检查 Python 源代码
2. ✅ 理解预期行为
3. ✅ 对比 TS 实现差异
4. ✅ **修复 TS 源代码以匹配 Python**
5. ✅ 验证测试通过
6. ✅ 添加 TODO 注释 (如需要)

---

## 📋 示例对比

### ❌ 错误做法 (违规)

```typescript
// 测试失败：期望 "Missing sync fields", 实际 "MISSING_SYNC_FIELDS"

// 违规：修改测试适应 TS 代码
expect(err.message).toBe("MISSING_SYNC_FIELDS"); // ❌ 禁止!
```

### ✅ 正确做法 (合规)

```typescript
// 测试失败：期望 "Missing sync fields", 实际 "MISSING_SYNC_FIELDS"

// 正确：修复 TS 错误类
// src/core/types/errors.ts
export class MissingSyncFieldsError extends BusError {
  constructor(message = "Missing sync fields") {  // ✅ 修复为 Python 的消息
    super(message);
    this.name = "MissingSyncFieldsError";
  }
}

// 测试保持不变
expect(err.message).toBe("Missing sync fields"); // ✅ 通过
```

---

## 🔍 质量检查清单

每个测试文件提交前必须满足:

- [ ] 所有 Python 测试都有对应 TS 测试
- [ ] 所有测试都通过 (100%)
- [ ] 没有使用 `.skip` 跳过任何测试
- [ ] Error name/message/属性完全匹配 Python
- [ ] 如果有失败测试，已修复 TS 源代码
- [ ] 生成了修复报告

---

## 📊 完成标准

**一个测试文件被认为"已完成"**:

1. ✅ 所有 Python 测试都已移植
2. ✅ 所有测试都能运行 (无语法错误)
3. ✅ **所有测试都通过** (不是跳过/降低标准)
4. ✅ 如果测试失败，TS 源代码已被修复以匹配 Python
5. ✅ 生成了文档说明修复了哪些差异

---

## 🎓 学习资源

### 正面案例 (Group 1)

✅ **test_agent_capabilities.py**
- 发现 skills 字段处理不一致
- 修复了 memoryStore.ts 中 3 处代码
- 11 个测试 100% 通过

✅ **bus_connect.test.ts**
- 发现 seq 累积问题
- 采用 `:memory:` + taskkill 强制隔离
- 恢复严格断言 `current_seq.toBe(1)`

### 反面案例 (Group 2 当前)

⚠️ **test_msg_sync_unit.test.ts**
- 6 个测试失败
- 原因：Error name/message/属性与 Python 不一致
- **待修复**: src/core/types/errors.ts

---

## 📝 执行承诺

我承诺遵守以下规则:

- [ ] 绝不修改测试断言降低标准
- [ ] 绝不使用 `.skip` 跳过失败测试
- [ ] 测试失败时优先修复 TS 源代码
- [ ] 确保 Error 处理与 Python 完全一致
- [ ] 生成完整的修复报告
- [ ] 接受团队审查和监督

签名：_______________  
日期：2026-__-__

---

## 🔗 相关文档

1. [`TEST_MIGRATION_PLAN.md`](./TEST_MIGRATION_PLAN.md) - 总体移植计划
2. [`TEST_MIGRATION_ENFORCEMENT.md`](./TEST_MIGRATION_ENFORCEMENT.md) - 详细执行规范 (387 行)
3. [`GROUP1_COMPLETE_GROUP2_STARTED.md`](./GROUP1_COMPLETE_GROUP2_STARTED.md) - 进度报告
4. [`BUS_CONNECT_FIX_COMPLETE.md`](./BUS_CONNECT_FIX_COMPLETE.md) - Group 1 修复案例

---

*版本*: v1.0  
*创建时间*: 2026-03-15  
*强制级别*: ⚠️ **必须遵守**  
*违规处理*: 发现即警告，累犯暂停工作
