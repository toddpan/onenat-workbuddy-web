---
id: task-47
title: '[代码] src/backlog-service.ts: 2. overviewBacklog —— 跨项目待办聚合（§7.3，并发 3、失败隔离）'
status: Done
assignee:
created_date: '2026-11-01T10:05:08Z'
updated_date: '2026-11-01T10:53:48Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 47000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:f2fdbf14e6896958 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog-service.ts（第 6 行）
- 命中标记：2. overviewBacklog —— 跨项目待办聚合（§7.3，并发 3、失败隔离）
- 文件修改时间：2026-11-01 03:13 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog-service.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T10:53:17Z 派发为任务
task-f2d6ea13 · mode=orchestrate · 成员=2

### 2026-11-01T10:53:48Z 派发执行（成功）
任务 task-f2d6ea13 · 结果=成功
核查完成，结论：**这是工作区扫描的误报，无需处理代码，标记保留**。

## 核查详情

**backlog-service.ts:6** 的命中内容是：

```ts
 *   2. overviewBacklog     —— 跨项目待办聚合（§7.3，并发 3、失败隔离）
```

这不是 TODO/FIXME 标记，而是文件头部的**文档注释**，说明该 service 层从 router.ts 抽出的两段多调用方逻辑。扫描器把「§7.3 设计文档引用」格式的描述行误判成了待办标记。

**对应功能已完整实现**（[backlog-service.ts:213](src/backlog-service.ts#L213) `overviewBacklog`）：

- ✅ **并发 3**：`opts?.concurrency ?? 3`，且钳制在 `[1, 8]`，工作池模式（`Array.from({length: min(limit, projects.length)})` + 共享 `next` 游标）
- ✅ **失败隔离**：每个项目独立 `overviewOne`，
