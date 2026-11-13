---
id: task-46
title: '[代码] src/backlog-service.ts: 1. dispatchBacklogItem —— 待办 → WorkTask 派发（docs/design-backl…'
status: Done
assignee:
created_date: '2026-11-01T10:05:08Z'
updated_date: '2026-11-01T10:53:42Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 46000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:68d5cc1a44be983b -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog-service.ts（第 5 行）
- 命中标记：1. dispatchBacklogItem —— 待办 → WorkTask 派发（docs/design-backlog-integration.md §6.1）
- 文件修改时间：2026-11-01 03:13 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog-service.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T10:53:16Z 派发为任务
task-d6d223d0 · mode=orchestrate · 成员=2

### 2026-11-01T10:53:42Z 派发执行（成功）
任务 task-d6d223d0 · 结果=成功
核查完成，这是扫描工具的**误报**——`src/backlog-service.ts:5` 并不是 TODO/FIXME 标记，而是模块头部的说明注释：

```ts
/**
 * onenat-workbuddy-web - Backlog 共享服务层
 *   1. dispatchBacklogItem —— 待办 → WorkTask 派发（docs/design-backlog-integration.md §6.1）
 *   2. overviewBacklog     —— 跨项目待办聚合（§7.3，并发 3、失败隔离）
 */
```

核实结果（验收清单 #1）：

- **功能已实现**：`dispatchBacklogItem()` 定义于 `src/backlog-service.ts:55`，按注释所述从 `router.ts` 抽出（router.ts:42 引入、:153 包装、:1598/:1659 两处 HTTP 路由调用），工具通道 `backlog-tool.ts:704` 也复用同一实现，无分叉。
- **有测试覆盖**：`src/backl
