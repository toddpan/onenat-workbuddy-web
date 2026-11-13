---
id: TASK-2
title: "backlog 回写失败自动重试（退避补偿）"
status: Done
assignee:
created_date: '2026-11-01T00:00:00Z'
updated_date: '2026-11-01T10:41:38Z'
labels:
  - "backlog"
  - "reliability"
dependencies:
priority: "high"
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
现状：任务终态钩子 `backlogWritebackFire`（src/engine.ts，见 docs/design-backlog-integration.md §6.3）回写失败时只在 task 上打 `backlogWritebackFailed` 标记，必须人工在看板点「重试回写」（`POST /api/projects/:id/backlog/retry-writeback/:taskId`）。节点短暂抖动/端口漂移期会留下大量「回写未确认」，需要人值守。

目标：加后台补偿器，对带 `backlogWritebackFailed` 标记且任务已终态的记录自动重试回写，指数退避（如 1min → 5min → 15min，最多 3 次），成功即清除标记并写审计（`audit('backlog.writeback-retry', ...)`）；超过上限保持标记，交回人工。

实现约束：
- 复用现成的重试入口/内部方法，不要复制回写逻辑；重试必须走 ONENAT 实时解析（勿缓存端口，符合项目约束）；
- 定时器随服务启停（server.ts 生命周期内注册并清理），禁止未捕获异常导致进程退出；
- 只对 backlogRef 存在且 summary 已产出的任务重试，避免无限空转；
- 退避状态需持久化（store）或在重启后从标记时间推算，不能重启即清零无限重试。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 服务启动后自动对失败任务按退避间隔重试，成功时清除 backlogWritebackFailed
- [ ] #2 达到上限后停止重试并保留标记，UI 仍显示「回写未确认」并可人工重试
- [ ] #3 重启进程后重试计数不清零、不产生无限重试
- [ ] #4 单测覆盖「失败→重试→成功清除」与「达上限停止」两条路径
- [ ] #5 npm run build / typecheck / test:unit / smoke 全通过
<!-- AC:END -->

### 2026-11-01T10:35:32Z 派发为任务
task-176a53be · mode=orchestrate · 成员=2

### 2026-11-01T10:41:38Z 派发执行（成功）
任务 task-176a53be · 结果=成功
现在我已经了解整体情况了。正在实现补偿器：现在来看 `engine.ts`。首先，在 `backlogWritebackFire` 附近添加补偿器：Now the success path in `runBacklogWriteback` — clear retry state and write audit:Wire into server.ts lifecycle:让手动重试路由共享同一个失败记录器：接下来是测试。让我查看一下测试夹具（test fixture）：All 123 unit tests pass (including the 3 new compensation tests). Now build + smoke:All green. Add a brief note to the design doc (§6.3 area):TASK-2 完成。全部验收项通过：

## 改动摘要

**核心实现 — [src/engine.ts](src/engine.ts#L720-L793)**
- 新增后台补偿器：`startBacklogWritebackRetrySwee
