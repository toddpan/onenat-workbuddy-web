---
id: task-17
title: '[文档] docs/feat-backlog-collect-mvp.md: 2. **B 工作区代码/文档**：项目工作区里的明确标记 —— 代码 `TODO / FIXME / XXX / HA…'
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T10:38:37Z'
labels:
  - auto-collect
  - source-doc
  - doc-status
dependencies:
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=doc:d95fa12b9d798964 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：docs/feat-backlog-collect-mvp.md（第 13 行）
- 命中标记：2. **B 工作区代码/文档**：项目工作区里的明确标记 —— 代码 `TODO / FIXME / XXX / HACK / 待办 / 待补充 / 未完成`，文档未勾选验收 `- [ ]`、文档状态标记 `TBD / 待确认 / 待定 / WIP / 状态：草稿|进行中`；
- 文件修改时间：2026-11-01 06:46 UTC
- 定位：项目工作区 → 右侧栏文件树 → `docs/feat-backlog-collect-mvp.md`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该未勾选项/待确认内容是否仍需跟进
- [ ] #2 处理后同步勾选或更新文档
<!-- AC:END -->

### 2026-11-01T10:35:28Z 派发为任务
task-05f335ee · mode=orchestrate · 成员=2

### 2026-11-01T10:38:37Z 派发执行（成功）
任务 task-05f335ee · 结果=成功
我核对了 `docs/feat-backlog-collect-mvp.md` 第 13 行及其上下文，结论如下：

## 判定：误报（false positive），无需跟进开发

- **命中原因**：扫描器 B 源（文档未勾选验收 `- [ ]`）把第 13 行**描述扫描规则本身的示例文本** `` `…文档未勾选验收 `- [ ]`…` `` 当成了真实的未勾选验收项。这一行是反引号代码片段里的字面量，不是待办。
- **文档实际状态**：文档头部明确标注「状态：**已实现并本地验证通过**（2026-11-01）」，§6 验证结果齐全（typecheck / 120 项单测 / 83 项 smoke / e2e / 真实节点 19/19 全过），无真实未完成项；§7 列出的 6 项「未实现」属于 v3 完整方案的显式排期项，且都被扫描器以 `TBD`/清单形式正确豁免（它们是有意的后续规划，不算本轮遗留）。

## 验收清单处理

- **#1 确认是否仍需跟进**：✅ 已确认——不需要。这是扫描器对「规则自描述文本」的已知误报类别：文档在介绍标记语法时字面引用了 `- [
