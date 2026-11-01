---
id: task-28
title: '[代码] src/backlog-collect.ts: onenat-workbuddy-web - 未完成事项采集（简版：手动触发，一次预览 → 勾选 → 落盘）'
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T11:13:17Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:667b1a4e99c4c6f8 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog-collect.ts（第 2 行）
- 命中标记：onenat-workbuddy-web - 未完成事项采集（简版：手动触发，一次预览 → 勾选 → 落盘）
- 文件修改时间：2026-11-01 06:04 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog-collect.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T11:12:29Z 派发为任务
task-ec49741f · mode=orchestrate · 成员=2

### 2026-11-01T11:13:17Z 派发执行（成功）
任务 task-ec49741f · 结果=成功
## task-28 处理结论：已解决（误报，无需再改代码）

**核验过程**：

1. 该 backlog 条目命中的“标记”是 [src/backlog-collect.ts:2](src/backlog-collect.ts#L2) 的模块头注释——原文写的是“未完成事项采集”，裸含中文标记词 `未完成`，命中了采集器自己的 `CODE_MARKER_CN_RE`，属于**采集器自激误报**（扫描工作区时把自己登记成了候选）。
2. 工作区中该文件已有未提交改动，正是针对此问题的修复：
   - 头注释及全部注释/字符串措辞改为「未竟事项」，不再裸写任何标记词（[第 2 行](src/backlog-collect.ts#L2)、[第 11 行](src/backlog-collect.ts#L11)、[第 437-438 行](src/backlog-collect.ts#L437)）；
   - 新增自激防线注释并拆分正则为 `CODE_MARKER_EN_RE` / `CODE_MARKER_CN_RE`（[第 99-104 行](src/backlog-collect.
