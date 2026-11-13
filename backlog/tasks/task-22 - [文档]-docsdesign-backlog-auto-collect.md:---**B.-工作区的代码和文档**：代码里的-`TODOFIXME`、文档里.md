---
id: task-22
title: '[文档] docs/design-backlog-auto-collect.md: - **B. 工作区的代码和文档**：代码里的 `TODO/FIXME`、文档里未勾选的验收项/「待确认」「未完成」标记…'
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T10:57:30Z'
labels:
  - auto-collect
  - source-doc
  - doc-status
dependencies:
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=doc:906b16d5cc16dc11 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：docs/design-backlog-auto-collect.md（第 37 行）
- 命中标记：- **B. 工作区的代码和文档**：代码里的 `TODO/FIXME`、文档里未勾选的验收项/「待确认」「未完成」标记、未完成的设计文档。
- 文件修改时间：2026-11-01 06:08 UTC
- 定位：项目工作区 → 右侧栏文件树 → `docs/design-backlog-auto-collect.md`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该未勾选项/待确认内容是否仍需跟进
- [ ] #2 处理后同步勾选或更新文档
<!-- AC:END -->

### 2026-11-01T10:56:58Z 派发为任务
task-5c71b3a9 · mode=orchestrate · 成员=2

### 2026-11-01T10:57:30Z 派发执行（成功）
任务 task-5c71b3a9 · 结果=成功
我核对了 `docs/design-backlog-auto-collect.md` 第 37 行及其上下文，结论如下：

## 结论：这是一条**误报（假阳性）**，无需跟进

**命中内容**（第 37 行）：

> - **B. 工作区的代码和文档**：代码里的 `TODO/FIXME`、文档里未勾选的验收项/「待确认」「未完成」标记、未完成的设计文档。

**为什么是误报**：

1. **它不是未完成事项，而是决策定义本身**。这一行是 §1 需求清单里用户已确认的 D1 决策（「A+B 双源」，见第 4、615 行决策定稿表「用户确认 2026-11-01」），是**已完成的设计决策**，不是挂起工作。
2. **命中原因是自指**：这份文档本来就是描述「待确认」「未完成」等采集标记词的设计文档，正文里出现这些字面词是必然的——正如方案自己在 §4.1 和风险 3 里预判的「TODO 噪音」。采集器扫这份文档永远会命中它。
3. **该文档的真实未完成项已在文档头部如实标注**（第 3 行）：「简版手动采集已落地，其余（定时/状态文件/门禁/工具通道）待排期」——这是文档作
