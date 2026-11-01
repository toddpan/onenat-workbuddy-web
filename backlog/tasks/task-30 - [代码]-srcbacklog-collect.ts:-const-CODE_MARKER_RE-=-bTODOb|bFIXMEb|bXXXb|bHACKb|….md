---
id: task-30
title: '[代码] src/backlog-collect.ts: const CODE_MARKER_RE = /\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b|…'
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T11:11:50Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:b1c5dfa7cef3801c -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog-collect.ts（第 99 行）
- 命中标记：const CODE_MARKER_RE = /\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b|待办|待补充|未完成/i
- 文件修改时间：2026-11-01 06:04 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog-collect.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T11:05:22Z 派发为任务
task-f787e8a7 · mode=orchestrate · 成员=2

### 2026-11-01T11:11:50Z 派发执行（成功）
任务 task-f787e8a7 · 结果=成功
这条 backlog 来自工作区扫描对 `src/backlog-collect.ts` 自身的误报：命中"标记"的其实不是真实待办，而是**标记正则的定义行本身**（正则字面量里写着 `TODO|FIXME|待办|待补充|未完成`）。先确认根因仍在、再修。命中根因已明确：这条待办不是真实的遗留工作，而是采集器对**自身源码**的自激误报——被登记的"标记"是 `CODE_MARKER_RE` 正则定义行本身（现已拆成 EN/CN 两条），此外本文件注释/字符串里还有多处「待办/未完成/'todo'」字样会持续自触发。先看单测再动手。根因清楚了。现在确认 `todo` 相关 label 是否有消费方，避免重命名破坏兼容：采集器自激问题定位完毕，改动范围收敛在 `backlog-collect.ts` 自身：它的注释/字符串里裸写了「待办/未完成/TODO/'todo'」这些标记词，被自己的扫描器反复登记。先看测试怎么跑，再加回归用例：测试会把源码连注释一起编译到 `dist-test/`，所以用例里可以对自己编译产物做真实自扫描断言。开始修改源码——原则：**采集器自身的注释与字符串里
