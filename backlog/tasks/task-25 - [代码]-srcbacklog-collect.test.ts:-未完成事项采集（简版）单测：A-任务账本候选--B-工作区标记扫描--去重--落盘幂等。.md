---
id: task-25
title: '[代码] src/backlog-collect.test.ts: 未完成事项采集（简版）单测：A 任务账本候选 / B 工作区标记扫描 / 去重 / 落盘幂等。'
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T10:57:55Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:b4d8fde65001a99d -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog-collect.test.ts（第 2 行）
- 命中标记：未完成事项采集（简版）单测：A 任务账本候选 / B 工作区标记扫描 / 去重 / 落盘幂等。
- 文件修改时间：2026-11-01 06:06 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog-collect.test.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T10:57:03Z 派发为任务
task-42976be3 · mode=orchestrate · 成员=2

### 2026-11-01T10:57:55Z 派发执行（成功）
任务 task-42976be3 · 结果=成功
该文件的头部注释（第 2 行）被自动收集器标记为代码标记。让我检查一下扫描器是如何检测标记的，以决定正确的修复方案。被标记的“标记”是测试文件的头文档注释（第 2 行），它匹配了 `CODE_MARKER_CN_RE`（`未完成`）作为注释行——但检查该文件后，所有描述的测试（A 任务账本候选 / B 工作区标记扫描 / 去重 / 落盘幂等）都已完全实现并通过。因此结论是：该标记已过时/误报；重新组织注释措辞以防其被反复采集。处理完成。结论与改动：

**结论（验收 #1）：该标记是误报残留，工作已完成，标记应删除（改写）。**
- [src/backlog-collect.test.ts](src/backlog-collect.test.ts) 文件头注释里的「未完成事项采集」被自动采集器命中（`CODE_MARKER_CN_RE` 的 `未完成`，且 ` * ` 开头算注释行）。
- 但逐条核对：A 任务账本候选（`taskCandidatesFor`）、B 工作区标记扫描（`parseWorkspaceMarkers` / `scanWorkspaceCandidates`）、
