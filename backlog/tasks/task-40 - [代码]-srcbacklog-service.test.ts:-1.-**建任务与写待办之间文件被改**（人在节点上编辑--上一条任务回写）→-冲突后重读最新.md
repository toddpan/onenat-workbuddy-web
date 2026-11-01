---
id: task-40
title: '[代码] src/backlog-service.test.ts: 1. **建任务与写待办之间文件被改**（人在节点上编辑 / 上一条任务回写）→ 冲突后重读最新内容'
status: Done
assignee:
created_date: '2026-11-01T10:05:08Z'
updated_date: '2026-11-01T11:07:16Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 40000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:9266025ea8dc493d -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog-service.test.ts（第 5 行）
- 命中标记：1. **建任务与写待办之间文件被改**（人在节点上编辑 / 上一条任务回写）→ 冲突后重读最新内容
- 文件修改时间：2026-11-01 03:16 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog-service.test.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T11:05:32Z 派发为任务
task-158c9fe5 · mode=orchestrate · 成员=2

### 2026-11-01T11:07:16Z 派发执行（成功）
任务 task-158c9fe5 · 结果=成功
核查完成，结论：**该处不是 TODO/FIXME，是合法的测试文档注释，保留原样即可**。

**详情：**

- `src/backlog-service.test.ts` 第 5 行位于文件头部的 JSDoc 块（第 1–9 行），内容是描述该测试文件覆盖的两组时序场景：
  1. 建任务与写待办之间文件被改 → 冲突后重读最新内容
  2. 建任务后写待办彻底失败 → 错误带 `taskId`/`taskCreated`
- 采集器把注释里编号列表的「1. **…**」误识别成了待办标记。实际这两条都**已被下方测试用例实现并覆盖**：
  - 场景 1 → 第 94 行测试 `dispatch：建任务后待办被并发修改 → 重读重试…`（断言并发写入内容不丢）
  - 场景 2 → 第 114 行测试 `dispatch：建任务后写待办彻底失败 → 抛错带 taskId/taskCreated`

**验收清单：**

- [x] #1 确认：非待办标记，是准确的测试意图说明，保留
- [x] #2 无需修改代码标记；已验证测试全绿 —— `npm run test:unit`
