# bus_connect.test.ts 修复报告

## ✅ 修复完成

**修复时间**: 2026-03-15 16:40  
**测试状态**: 39 passed | 0 failed | 14 skipped (53 total)  
**Test Files**: 7 passed (7)

---

## 🐛 问题根源

### 症状
每次运行 `npm test`,`bus_connect.test.ts` 都会失败:
```
AssertionError: expected X to be 1 // Object.is equality
```
X 的值会持续增加 (1, 3, 7, 10, 12...)

### 根本原因
1. **服务器进程未完全关闭**: 使用 `serverProcess.kill()` 在 Windows 上不够可靠，导致之前的服务器进程残留
2. **全局 singleton state 累积**: 每个服务器进程内的 `memoryStore` singleton 中的 sequence 计数器持续累积
3. **非完全隔离的数据库**: 虽然使用了文件数据库，但没有真正隔离 singleton state

---

## 📋 Python 版本的策略

Python 测试 (`tests/test_bus_connect.py`) 采用以下策略确保隔离:

```python
@pytest.mark.asyncio
async def test_bus_connect_new_agent_new_thread():
    db = await aiosqlite.connect(":memory:")  # ← 内存数据库
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    
    # ... 测试代码 ...
    
    await db.close()  # ← 测试结束关闭数据库
```

**关键特点**:
1. ✅ 每个测试函数使用独立的 `:memory:` SQLite 数据库
2. ✅ 直接调用 `handle_bus_connect(db, args)`,不启动独立服务器
3. ✅ 测试结束后调用 `await db.close()` 清理
4. ✅ 使用 `@pytest.fixture(autouse=True)` 清理 MCP 上下文全局 state

---

## 🔧 修复方案 (完全模拟 Python)

### 方案 1: 使用内存数据库 + 强制关闭服务器进程 ⭐⭐⭐

**核心修改**:

#### 1. 改用 `:memory:` 数据库
```typescript
// ❌ 修复前：使用文件数据库
let DB_PATH = path.join(__dirname, 'bus_connect.test.db');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentchatbus-"));
DB_PATH = path.join(tmpDir, `bus_connect-${randomUUID().slice(0,8)}.db`);

// ✅ 修复后：使用内存数据库 (与 Python 一致)
const DB_PATH = ':memory:';  // 完全隔离，自动清理
```

#### 2. 强制关闭服务器进程 (Windows 兼容)
```typescript
// ❌ 修复前：简单 kill (不可靠)
afterEach(() => {
    if (serverProcess) serverProcess.kill();
});

// ✅ 修复后：使用 taskkill (Windows) / SIGKILL (*nix)
afterEach(async () => {
    if (serverProcess) {
        const { execSync } = await import('child_process');
        try {
            if (serverProcess.pid) {
                if (process.platform === 'win32') {
                    execSync(`taskkill /pid ${serverProcess.pid} /T /F`, { stdio: 'ignore' });
                } else {
                    serverProcess.kill('SIGKILL');
                }
            }
        } catch (e) {
            // Ignore if process already exited
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    // :memory: 数据库自动清理，无需手动删除文件
});
```

#### 3. 恢复严格断言
```typescript
// ✅ 修复后：因为完全隔离，seq 总是从 0 开始
expect(payload2.current_seq).toBe(1); // Exactly 1
expect(payload2.messages.length).toBeGreaterThanOrEqual(1);
```

---

## 📊 修复效果验证

### 修复前
```bash
$ npm test
 Test Files  1 failed | 6 passed (7)
      Tests  1 failed | 38 passed | 14 skipped (53)
      
❌ 失败原因：expected 12 to be 1
```

### 修复后 (连续运行 3 次)
```bash
$ npm test
 Test Files  7 passed (7)
      Tests  39 passed | 14 skipped (53)
✅ 所有测试通过!

$ npm test  
 Test Files  7 passed (7)
      Tests  39 passed | 14 skipped (53)
✅ 稳定通过!

$ npm test
 Test Files  7 passed (7)
      Tests  39 passed | 14 skipped (53)
✅ 持续稳定!
```

---

## 📄 修改的文件

### tests/parity/bus_connect.test.ts

**修改行数**: +24 行，-18 行

**主要变更**:
1. **L1-10**: 移除 `import * as os from 'os'`,移除 `let DB_PATH` 变量
2. **L15-26**: beforeEach 中使用 `:memory:` 数据库
3. **L43-60**: afterEach 中强制关闭服务器进程 (Windows 兼容)
4. **L140-141**: 恢复严格断言 `current_seq.toBe(1)`

---

## 🎯 与 Python 版本对比

| 特性 | Python 版本 | TypeScript 修复后 |
|------|-----------|-----------------|
| **数据库类型** | `:memory:` | `:memory:` ✅ |
| **数据库清理** | `db.close()` | 进程结束自动清理 ✅ |
| **singleton 隔离** | 每测试新建 | 每测试重启服务器 ✅ |
| **sequence 重置** | 每次测试 seq=0 | 每次测试 seq=0 ✅ |
| **全局 state 清理** | fixture autouse | 强制杀进程 ✅ |
| **执行方式** | 直接调用 handler | HTTP 服务器 (集成测试) |

**差异说明**:
- Python 是直接调用 handler 函数的单元测试
- TS 是启动 HTTP 服务器的集成测试
- 但两者都实现了**完全的测试隔离**,达到相同效果

---

## 🚀 技术细节

### 为什么选择 `:memory:`?

1. **完全隔离**: 每个进程有独立的内存空间
2. **自动清理**: 进程结束后数据库自动消失
3. **性能优越**: 内存操作比磁盘快 10-100 倍
4. **符合 Python**: 与 Python 测试策略 100% 一致

### Windows 进程终止最佳实践

```typescript
// Windows 上使用 taskkill 更可靠
if (process.platform === 'win32') {
    execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
} else {
    process.kill(pid, 'SIGKILL');
}
```

**参数说明**:
- `/T`: 终止子进程树
- `/F`: 强制终止
- `stdio: 'ignore'`: 忽略输出

---

## ✅ 质量保证

### 测试覆盖检查
- [x] bus_connect 完整流程测试通过
- [x] current_seq 严格等于 1 (不是 >=1)
- [x] messages.length >= 1
- [x] agent.registered = false (第二次连接)
- [x] thread.created = false (第二次连接)

### 稳定性检查
- [x] 连续运行 3 次全部通过
- [x] 无残留进程
- [x] sequence 不会累积
- [x] 与其他测试共享运行时也通过

---

## 🎓 经验总结

### 关键学习点

1. **移植测试必须严格模拟**: 
   - Python 用 `:memory:` → TS 也用 `:memory:`
   - Python 每测试隔离 → TS 也每测试隔离

2. **Windows 进程管理要特别注意**:
   - `process.kill()` 不够可靠
   - 使用 `taskkill /T /F` 确保完全终止

3. **singleton state 是测试失败的常见原因**:
   - 必须确保每测试重置或重建 singleton
   - 最彻底的方式是重启进程

4. **集成测试也需要完全隔离**:
   - 即使启动 HTTP 服务器，也要保证每测试独立
   - `:memory:` + 强制杀进程 = 完美隔离

---

## 🔮 未来建议

### 其他 parity 测试可参考此模式

如果其他 parity 测试也遇到类似问题，可以采用相同策略:
1. 使用 `:memory:` 数据库
2. 启动独立进程运行测试
3. afterEach 强制杀进程
4. 恢复严格断言

### 考虑添加全局 fixture

在 `vitest.config.ts` 中添加全局 beforeEach/afterEach，确保所有测试都能正确清理。

---

*报告生成时间：2026-03-15 16:40*  
*测试状态：✅ 39 passed | 0 failed | 14 skipped*  
*稳定性：✅ 连续 3 次运行全部通过*
