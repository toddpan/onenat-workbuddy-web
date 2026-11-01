---
id: task-44
title: '[代码] src/backlog-tool.ts: 三态：未给 = 默认（overview 侧按「只看未完成」处理）；给了就按布尔字面量'
status: Done
assignee:
created_date: '2026-11-01T10:05:08Z'
updated_date: '2026-11-01T11:03:19Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 44000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:7d64b8ed572120f3 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog-tool.ts（第 152 行）
- 命中标记：三态：未给 = 默认（overview 侧按「只看未完成」处理）；给了就按布尔字面量
- 文件修改时间：2026-11-01 03:17 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog-tool.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T11:01:50Z 派发为任务
task-448bb84f · mode=orchestrate · 成员=2

### 2026-11-01T11:03:19Z 派发执行（成功）
任务 task-448bb84f · 结果=成功
代码语义已经实现了这个三态逻辑（152-153 行的解析，177 行的过滤，363-371 行的概览默认）。我来检查一下为什么扫描器标记了这一行：已找到根本原因：采集器会将注释行中的中文关键词（`待办|待补充|未完成`）标记为待办事项，而第 152 行的注释中包含了「只看未完成」——这是设计逻辑，并非待办事项。代码本身已经正确实现了三态语义。修复方案：重写该注释以在保留原意的同时避免触发误报。第 363 行也有相同的误报问题，因此我也将对其进行修复。现在我来重新构建并验证（类型检查 + 烟雾测试）：同文件下的另外两条注释属于同一误报类别——为了防止再次被标记，也一并修复了它们：处理完成。验收结论与改动如下：

## 判定：该标记是误报，无需转正式待办

- `src/backlog-tool.ts:152` 的注释并非 TODO，而是对 `includeDone` **三态语义的设计说明**，代码本身已完整实现该语义：
  - 解析侧（原 152-153 行）：`includeDone` 未给 = `undefined`（默认态）；给了就按布尔字面量。
  - 过滤侧（177 行）：仅
