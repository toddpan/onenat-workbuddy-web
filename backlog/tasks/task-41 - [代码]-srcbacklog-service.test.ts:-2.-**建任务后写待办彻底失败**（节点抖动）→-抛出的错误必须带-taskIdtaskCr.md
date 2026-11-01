---
id: task-41
title: '[代码] src/backlog-service.test.ts: 2. **建任务后写待办彻底失败**（节点抖动）→ 抛出的错误必须带 taskId/taskCreated，'
status: Done
assignee:
created_date: '2026-11-01T10:05:08Z'
updated_date: '2026-11-01T11:02:55Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 41000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:7f9a17dc430c18a2 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog-service.test.ts（第 7 行）
- 命中标记：2. **建任务后写待办彻底失败**（节点抖动）→ 抛出的错误必须带 taskId/taskCreated，
- 文件修改时间：2026-11-01 03:16 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog-service.test.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T11:01:46Z 派发为任务
task-c8dc2d0a · mode=orchestrate · 成员=2

### 2026-11-01T11:02:55Z 派发执行（成功）
任务 task-c8dc2d0a · 结果=成功
第 7 行的“标记”位于文件的头部文档注释中——它描述了测试 #2 覆盖的内容，而不是 TODO/FIXME。我来核实一下该行为是否确实已实现且测试通过。核查完成，结论：**该标记是测试文档说明，不是待办，保留原样**。无代码改动。

## 核查结果

**#1 标记性质确认**
`src/backlog-service.test.ts:7` 的文本位于文件头部 JSDoc 注释内，是测试套件的覆盖范围说明（对应 `docs/design-backlog-mcp-tool.md §7.1「派发失败的不可重试语义」`），**不是 TODO/FIXME**——采集器把它误判成了待办标记。它精确描述了下方第 114-146 行测试的意图。

**行为已实现且测试通过**
- 实现：`src/backlog-service.ts:123` 在写待办彻底失败时抛出 `{ status: 502, code: 'WRITEBACK_FAILED', taskId, taskCreated: true, itemId }`，调用方可提示「任务已创建，勿重复派发」✅
- 测试：`dispatch：建任
