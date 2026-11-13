---
id: task-35
title: '[代码] src/backlog.ts: if (raw === undefined) throw new Error(''待办文件读取失败'')'
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T10:49:21Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:4ac9c6af8935ade6 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog.ts（第 391 行）
- 命中标记：if (raw === undefined) throw new Error('待办文件读取失败')
- 文件修改时间：2026-11-01 06:04 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [x] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T10:46:29Z 派发为任务
task-4163d0e1 · mode=orchestrate · 成员=2

### 2026-11-01T10:55:00Z 执行记录
结论：采集扫描误报（false positive），代码保留不改。
- src/backlog.ts:391 的 `throw new Error('待办文件读取失败')` 是合法的错误处理：`readItem` 在底层下载失败时必须抛错（writeItem/verify 依赖该语义），行内并无 TODO/FIXME 标记。
- 误报根因：backlog-collect.ts 的 CODE_MARKER_RE 裸匹配中文关键词「待办」，命中了错误消息字符串。
- 修复（治本）：backlog-collect.ts 拆分 CODE_MARKER_EN_RE / CODE_MARKER_CN_RE，中文关键词仅注释行命中；新增回归单测（src/backlog-collect.test.ts）。
- 验证：npm run typecheck ✓ · test:unit 124/124 ✓ · build ✓ · smoke 83/83 ✓
- 代码中无需保留或删除任何标记（标记在采集器逻辑里，已更新）。

### 2026-11-01T10:49:21Z 派发执行（成功）
任务 task-4163d0e1 · 结果=成功
这是一个误报：扫描器的 `CODE_MARKER_RE` 在 `backlog.ts:391` 的**错误消息字符串**中匹配到了子字符串 `待办`（`'待办文件读取失败'`），而不是一个真正的 TODO 标记。那一行是合法的防御性错误处理（`readItem` 在底层下载失败时必须抛出异常——`writeItem`/`verify` 依赖于此），因此代码本身是正确的，应予以保留。

真正的修复方法是提高扫描器的精度：中文关键字（`待办|待补充|未完成`）应该只在注释行中视为标记，因为在这个以待办管理为主的代码库中，它们会出现在标识符、UI 文本和错误消息中。让我检查一下扫描器测试和待办事项文件：结论已明确。现在我将修复根本原因（扫描器精度），并通过待办事项（backlog item）闭环：现在我将回归测试添加到 `scanner` 测试中：124/124 个单元测试已通过。正在根据仓库约定进行构建和冒烟测试：现在我在待办事项文件中关闭待办事项（勾选 ACs，Done 状态，执行记录）：## task-35 处理完成 ✅

**结论：采集扫描误报（false positive），`sr
