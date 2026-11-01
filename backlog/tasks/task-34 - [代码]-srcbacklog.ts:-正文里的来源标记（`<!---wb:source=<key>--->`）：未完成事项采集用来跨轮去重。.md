---
id: task-34
title: '[代码] src/backlog.ts: 正文里的来源标记（`<!-- wb:source=<key> -->`）：未完成事项采集用来跨轮去重。'
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T10:46:47Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:9486af53e7420e55 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog.ts（第 61 行）
- 命中标记：正文里的来源标记（`<!-- wb:source=<key> -->`）：未完成事项采集用来跨轮去重。
- 文件修改时间：2026-11-01 06:04 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T10:46:28Z 派发为任务
task-874bb405 · mode=orchestrate · 成员=2

### 2026-11-01T10:46:47Z 派发执行（成功）
任务 task-874bb405 · 结果=成功
查看 [src/backlog.ts:61](src/backlog.ts#L61) 后确认：命中内容并不是 TODO/FIXME 待办标记，而是 `BacklogItem.sourceKeys` 字段的 JSDoc 文档注释——它解释的是代码中**实际存在**的 `<!-- wb:source=<key> -->` 去重机制（该机制在下方 `sourceKeys?: string[]` 与 `description` 字段声明中被真实使用）。

验收结论：

- **#1 保留**：这不是未完成事项，无需转成正式待办；采集器把它误判为待办标记属于扫描器对「描述性注释含 `<!-- wb:... -->` 示例文本」的误报。
- **#2 无需改动代码**：正文里没有需要删除/更新的标记；文档注释本身就是对现存机制的准确描述。

代码零改动，无需重新 build；如需降低此类误报，可在未完成事项采集的扫描规则里把「JSDoc 注释内的示例标记」排除，那是另一项独立工作，本次不擅自扩大范围。
