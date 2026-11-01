---
id: task-37
title: '[代码] qa-20261101/task1-cmdk-backlog/qa-env.mjs: - 第二个可达项目 C（同 stub 节点、另一 workspace、init + 2 条待办）→ 验证跨项目命中'
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T11:07:54Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:50e8c1ca3d65323a -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：qa-20261101/task1-cmdk-backlog/qa-env.mjs（第 6 行）
- 命中标记：- 第二个可达项目 C（同 stub 节点、另一 workspace、init + 2 条待办）→ 验证跨项目命中
- 文件修改时间：2026-11-01 05:11 UTC
- 定位：项目工作区 → 右侧栏文件树 → `qa-20261101/task1-cmdk-backlog/qa-env.mjs`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T11:05:27Z 派发为任务
task-b9943b9f · mode=orchestrate · 成员=2

### 2026-11-01T11:07:54Z 派发执行（成功）
任务 task-b9943b9f · 结果=成功
第 6 行并不是一个待处理标记——它是已经实现的功能的文档字符串文档（项目 C 在第 317-330 行构建，在 371/378 行进行了检查，并通过截图 `task1-03-desktop-cmdk-itemid-crossproject.png` 进行了验证）。让我检查一下是什么触发了 workspace scanner，以免它一直重新注册这个误报。扫描器会将代码文件中包含“待办/未完成/待补充”的注释行进行标记。第 6 行（以及很可能第 59 行）属于误报：它们是记录已经实现的测试数据的 JSDoc。修复方法是将这些文档注释行中的“待办”替换为“条目”（即工作台使用的通用术语），这既能保留含义，又能停止重新注册。让我找出所有出现的地方：所有“待办”出现的地方中，只有注释行会触发 CN 标记 (L6, L13, L58, L59, L298, L317, L378)；字符串字面量（例如第 308 行的条目标题）会被正确忽略。我将重写这七行注释，将“待办”改为“条目”/“backlog”（保留含义，移除误报触发器）：现在验证扫描器不再对该文件产生任何标记（使用构建好的 `parseW
