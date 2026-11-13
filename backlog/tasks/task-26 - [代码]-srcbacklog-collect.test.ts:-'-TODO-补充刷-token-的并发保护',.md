---
id: task-26
title: '[代码] src/backlog-collect.test.ts: ''// TODO 补充刷 token 的并发保护'','
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T10:59:39Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:fc220f69c51425c7 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog-collect.test.ts（第 142 行）
- 命中标记：'// TODO 补充刷 token 的并发保护',
- 文件修改时间：2026-11-01 06:06 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog-collect.test.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [x] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T10:57:05Z 派发为任务
task-e8d4a6df · mode=orchestrate · 成员=2

### 2026-11-01 复核关闭（误报，保留标记）

- **定性**：src/backlog-collect.test.ts:142 的 TODO 是 `parseWorkspaceMarkers` 测试用例的**夹具数据**（第 143-149 行断言依赖该标记文本验证代码标记解析），非真实工程事项；与 task-32（backlog-e2e.mjs:9 场景注释）同类误报。
- **技术核查**：全仓库唯一会话令牌滑动续期在 `validateSession`（src/auth.ts），纯同步内存 Map 读写（比对与写 `expiresAt` 之间无 await），Node 单事件循环下无并发竞争；AI 令牌落盘为原子 `writeFileSync`，登录已有进程内防双击保护（auth.ts L99）。无需补充并发保护。
- **处置**：标记**保留**（测试依赖）；在夹具上方加澄清注释（task-26/task-32 复核结论），标记文本未变 → dedup key 稳定，不会重复登记。
- **验证**：npm run build ✅；typecheck ✅；backlog-collect 单测 10/10 ✅；npm run smoke 83/83 ✅。

### 2026-11-01T10:59:39Z 派发执行（成功）
任务 task-e8d4a6df · 结果=成功
TODO 标记位于一个 **测试夹具字符串** 中（`parseWorkspaceMarkers` 的测试数据），而非实际的实现代码。我来检查一下代码库中是否确实存在会被关注的 `token-refresh` 代码路径：TODO 本身位于测试夹具内部。让我检查一下 backlog 扫描器是如何决定扫描哪些文件的，因为扫描器标记它自己的测试夹具听起来像是一个潜在的误报循环：之前的任务 task-32 已经制定了一个先例：测试夹具的误报通过复核文档关闭，且保留该标记。让我来定位 task-26 的 backlog 文件和设计文档：分析完成。发现总结：

- **该 TODO 是测试夹具数据**，位于 `parseWorkspaceMarkers` 的测试用例里（[src/backlog-collect.test.ts:142](src/backlog-collect.test.ts#L142)），被断言（第 149 行）依赖，用于验证代码标记解析功能——**不是真实工程待办**，标记必须保留。
- **背后的真实关切已不存在**：全仓库唯一的会话令牌滑动续期在 `validateSessi
