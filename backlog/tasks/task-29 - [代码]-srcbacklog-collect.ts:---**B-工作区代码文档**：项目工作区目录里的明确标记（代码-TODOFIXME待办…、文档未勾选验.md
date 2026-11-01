---
id: task-29
title: '[代码] src/backlog-collect.ts: - **B 工作区代码/文档**：项目工作区目录里的明确标记（代码 TODO/FIXME/待办…、文档未勾选验收 /'
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T11:14:28Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:370f1b04c3c75584 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog-collect.ts（第 6 行）
- 命中标记：- **B 工作区代码/文档**：项目工作区目录里的明确标记（代码 TODO/FIXME/待办…、文档未勾选验收 /
- 文件修改时间：2026-11-01 06:04 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog-collect.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T11:12:30Z 派发为任务
task-116944a2 · mode=orchestrate · 成员=2

### 2026-11-01T11:14:28Z 派发执行（成功）
任务 task-116944a2 · 结果=成功
这一项命中来自采集器自身的头部文档注释——采集器标记了它自己的描述。我来检查一下代码标记是如何匹配的，以决定是修复扫描器还是修改文本。第 6 行误报了——那是采集器自带的头文档注释，它恰好包含 "TODO" 和 "待办" 这些词（来自对扫描器自身的描述）。我来检查一下是否已有现成的排除机制和相关的测试。已经有一个自扫描回归测试，预期候选数量为零，但第 6 行仍然匹配。让我通过运行单元测试来验证一下。测试全部通过，但 task-29 是从第 6 行收集的。我来检查一下当前的 parser 对该文件到底返回了什么。处理完成，结论：**该条不是真实待办，无需改代码，可直接关闭 task-29。**

## 复核结论

**#1 该处是否仍需处理？—— 否，是历史误报**

`src/backlog-collect.ts` 第 6 行命中的是采集器**自己的文件头设计说明注释**（描述“B 工作区代码/文档”采集逻辑的那段文字），其中恰好含有字面词 "TODO/FIXME/待办"。它是在**旧版扫描器**下被自激登记的（2026-11-01 06:04 UTC）。

当前代码已修复此问题：
-
