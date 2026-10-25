# Token 统计修复 - 测试用例

## 测试准备

### 模拟数据结构

```typescript
// 今日零点时间戳
const dayStart = new Date()
dayStart.setHours(0, 0, 0, 0)
const dayStartMs = dayStart.getTime()

// 昨天 23:50
const yesterday2350 = dayStartMs - 10 * 60 * 1000

// 今天 00:10
const today0010 = dayStartMs + 10 * 60 * 1000

// 今天 10:00
const today1000 = dayStartMs + 10 * 60 * 60 * 1000
```

## 测试用例

### 用例 1：跨日长任务（修复重点）

**任务 A：昨晚开始，今早完成**

```typescript
const taskA = {
  id: 'task-a',
  title: '跨日长任务',
  status: 'completed',
  createdAt: yesterday2350,     // 昨天 23:50 创建
  updatedAt: today0010,          // 今天 00:10 完成
  turns: [
    {
      id: 'turn-1',
      at: yesterday2350,         // 昨天 23:50 开始
      usage: {
        inputTokens: 5000,
        outputTokens: 3000,
        cacheReadTokens: 1000,
      },
    },
    {
      id: 'turn-2',
      at: today0010 - 5 * 60 * 1000, // 今天 00:05 开始
      usage: {
        inputTokens: 2000,
        outputTokens: 1000,
      },
    },
  ],
}
```

**预期结果：**
- ✅ **修复前**：0 tokens（turn.at 都不在今天零点之后）
- ✅ **修复后**：11000 tokens（任务 updatedAt 在今天，统计所有 turn）

---

### 用例 2：纯历史任务

**任务 B：昨天完成的任务**

```typescript
const taskB = {
  id: 'task-b',
  title: '历史任务',
  status: 'completed',
  createdAt: yesterday2350 - 60 * 60 * 1000,  // 昨天 22:50
  updatedAt: yesterday2350 + 10 * 60 * 1000,  // 昨天 23:00
  turns: [
    {
      id: 'turn-1',
      at: yesterday2350 - 60 * 60 * 1000,
      usage: {
        inputTokens: 10000,
        outputTokens: 5000,
      },
    },
  ],
}
```

**预期结果：**
- ✅ **修复前**：0 tokens（正确）
- ✅ **修复后**：0 tokens（updatedAt 在昨天，不统计）

---

### 用例 3：今日完成的任务

**任务 C：今天创建并完成**

```typescript
const taskC = {
  id: 'task-c',
  title: '今日任务',
  status: 'completed',
  createdAt: today1000,
  updatedAt: today1000 + 30 * 60 * 1000,  // 今天 10:30
  turns: [
    {
      id: 'turn-1',
      at: today1000,
      usage: {
        inputTokens: 3000,
        outputTokens: 2000,
      },
    },
  ],
}
```

**预期结果：**
- ✅ **修复前**：5000 tokens（正确）
- ✅ **修复后**：5000 tokens（updatedAt 在今天，统计）

---

### 用例 4：运行中任务（昨天创建）

**任务 D：昨天创建，今天仍在运行**

```typescript
const taskD = {
  id: 'task-d',
  title: '长时间运行任务',
  status: 'running',
  createdAt: yesterday2350,
  updatedAt: today1000,         // 今天 10:00 最后更新
  turns: [
    {
      id: 'turn-1',
      at: yesterday2350,
      usage: {
        inputTokens: 8000,
        outputTokens: 4000,
      },
    },
    {
      id: 'turn-2',
      at: today1000,
      usage: {
        inputTokens: 2000,
        outputTokens: 1000,
      },
    },
  ],
}
```

**预期结果：**
- ⚠️ **修复前**：3000 tokens（只统计 turn-2，遗漏 turn-1）
- ✅ **修复后**：15000 tokens（任务运行中，统计所有 turn）

---

### 用例 5：无 token 消耗的任务

**任务 E：今天创建但无 usage**

```typescript
const taskE = {
  id: 'task-e',
  title: '无 token 任务',
  status: 'failed',
  createdAt: today1000,
  updatedAt: today1000 + 1000,
  turns: [
    {
      id: 'turn-1',
      at: today1000,
      usage: {},  // 空 usage
    },
  ],
}
```

**预期结果：**
- ✅ **修复前**：0 tokens
- ✅ **修复后**：0 tokens

---

## 汇总表

| 用例 | 场景 | 修复前 | 修复后 | 是否修复 |
|------|------|--------|--------|----------|
| A | 跨日长任务 | 0 | 11000 | ✅ 已修复 |
| B | 纯历史任务 | 0 | 0 | ✅ 保持正确 |
| C | 今日任务 | 5000 | 5000 | ✅ 保持正确 |
| D | 运行中任务（跨日） | 3000 | 15000 | ✅ 已修复 |
| E | 无 token 任务 | 0 | 0 | ✅ 保持正确 |

## 验证方法

### 手动验证

1. 在昨晚 23:50 创建一个长时间任务
2. 让任务在今天 00:10 完成
3. 查看监控大屏的「今日 Token」统计
4. **预期**：应该显示该任务的所有 token 消耗

### 代码审查要点

```typescript
// ✅ 正确：按任务判断
const taskActiveToday = isRunning || (t.updatedAt >= dayStart.getTime())
if (taskActiveToday) {
  for (const turn of t.turns || []) {
    // 统计所有回合的 token
  }
}

// ❌ 错误：按回合判断（原逻辑）
for (const turn of t.turns || []) {
  if (turn.at >= dayStart.getTime()) {
    // 遗漏跨日回合
  }
}
```

## 注意事项

1. **updatedAt 的含义**：任务最后一次更新时间，包括：
   - 任务完成时间
   - 任务失败时间
   - 任务中止时间
   - 任务状态变更时间

2. **运行中任务的特殊处理**：
   - 运行中任务的 `updatedAt` 会实时更新
   - 因此 `isRunning` 判断优先于 `updatedAt`
   - 确保运行中任务的所有 token 都计入今日

3. **与 UsageService 的区别**：
   - `UsageService`（`src/usage.ts`）：按时间范围精确统计，不受本次修复影响
   - `MonitorService`（`src/monitor.ts`）：按"今日活动任务"统计，本次修复的目标

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
