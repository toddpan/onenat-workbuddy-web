---
id: task-42
title: '[代码] src/backlog-service.test.ts: 模拟「建任务之后、写待办之前」这个窗口里发生的事'
status: Done
assignee:
created_date: '2026-11-01T10:05:08Z'
updated_date: '2026-11-01T11:02:30Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 42000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:e7484fb130f4e716 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog-service.test.ts（第 85 行）
- 命中标记：模拟「建任务之后、写待办之前」这个窗口里发生的事
- 文件修改时间：2026-11-01 03:16 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog-service.test.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T11:01:48Z 派发为任务
task-9e00ae63 · mode=orchestrate · 成员=2

### 2026-11-01T11:02:30Z 派发执行（成功）
任务 task-9e00ae63 · 结果=成功
任务核验完成（task-42，src/backlog-service.test.ts:85），结论如下：

## 核验结果：保留标记，无需改动

**#1 该处标记是否仍需处理？——不是待处理项，应保留**

第 85 行的内容是：

```ts
// 模拟「建任务之后、写待办之前」这个窗口里发生的事
```

经查，这不是 TODO/FIXME 待办标记，而是一条**解释性注释**，用来说明下方 `makeEngine` mock 的 `createTask` 为什么要先回调 `onCreate(taskId)` 再返回——它精确对应测试用例「dispatch：建任务后待办被并发修改 → 重读重试」（第 94 行）要覆盖的并发窗口场景，与文件头注释（第 5 行「建任务与写待办之间文件被改」）呼应，是这条测试的核心语义说明。

- 该注释描述的行为已由紧跟的测试完整实现并验证通过
- 注释无误导、无过期，删除反而会丢失 mock 设计意图的上下文

**#2 标记同步处理**：保留原样，代码无需修改。

**验证**：
- `npm run typecheck` ✅ 通过
- `npx
