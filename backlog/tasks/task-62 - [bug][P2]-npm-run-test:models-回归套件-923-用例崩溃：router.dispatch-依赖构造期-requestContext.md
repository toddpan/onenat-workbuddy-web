---
id: task-62
title: '[bug][P2] npm run test:models 回归套件 9/23 用例崩溃：router.dispatch 依赖构造期 requestContext，测试桩未初始化即 TypeError'
status: Done
assignee:
created_date: '2026-11-06T23:22:25Z'
updated_date: '2026-11-06T23:57:52Z'
labels:
  - bug
  - test
  - regression
  - router
dependencies:
priority: P2
ordinal: 62000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
复现：npm run test:models → 退出码 1，23 用例中 14 过 9 崩溃（连续 2 轮复现，2026-11-07 验证重跑；两轮数字完全一致）。

崩溃签名：TypeError: Cannot read properties of undefined (reading run) at WorkBuddyRouter.dispatch (dist/router.js:1135:36) ← scripts/model-catalog-regression.mjs:79 plannerOptions()。

失败用例（9 个）：unavailable selected/task node never substitutes the planner catalog、planner catalog preserves the same model metadata、task-authoritative node wins over a conflicting node query、an unavailable task never falls back、remote model errors return an empty catalog、legacy unbound task uses its actual planner execution catalog、welcome without a selected node、changing a project node within the same task invalidates the cached catalog。

根因：commit cf50d8f（feat(workspace) 工作区解耦系列落地 task-55~60）给 dispatch 增加了 this.requestContext.run(...)（AsyncLocalStorage 会话上下文），requestContext 仅在 WorkBuddyRouter 构造函数初始化；而回归脚本的 plannerOptions 桩用 Object.create(WorkBuddyRouter.prototype) 绕过构造函数再手工挂字段，requestContext 为 undefined → 9 个走 planner/options 的用例全部崩溃。生产路径不受影响（服务端经构造函数创建 router，smoke-standalone 93 项含 planner 相关全部通过）。

影响：npm 脚本化的模型目录回归门禁完全不可用（套件恒红），该回归原为 2026-11-06「任务内模型目录按 taskId 权威解析」修复（22032d1）的守护测试，失效后该修复失去自动防回归屏障。

建议修复：plannerOptions 桩补 this.requestContext = new AsyncLocalStorage()（或调用 WorkBuddyRouter 真实构造后覆写依赖字段），并对 23 用例全量跑绿做验收。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 npm run test:models 退出码 0，23/23 用例通过
- [ ] #2 plannerOptions 测试桩正确初始化 requestContext（与生产 dispatch 契约一致）
- [ ] #3 修复后在 README/CI 约定中保持 test:models 为门禁之一
<!-- AC:END -->

### 2026-11-06T23:54:51Z 派发为任务
task-02819340 · mode=chat · 成员=1

### 2026-11-06T23:57:52Z 派发执行（成功）
任务 task-02819340 · 结果=成功
23/23 全绿。再核对验收 #3（test:models 保持门禁）：task-62 修复完成，验收清单 3/3 全过：

## 修复内容（仅 `scripts/model-catalog-regression.mjs`，测试桩问题，未动生产代码）

1. **#2 requestContext 契约修复**：`plannerOptions` 桩用 `Object.create(WorkBuddyRouter.prototype)` 绕过构造函数，缺 `dispatch()` 依赖的 `requestContext`。已补：
   - 顶部新增 `import { AsyncLocalStorage } from 'node:async_hooks'`（与 `src/router.ts:15` 同源）
   - 桩的 `Object.assign` 里注入 `requestContext: new AsyncLocalStorage()`，并附注释说明与生产构造函数契约的对应关系
2. **附带修复 1 个非崩溃型红用例**：`changing a project node with


### 2026-11-07T08:10:00+08:00 修复合入与 Lead 独立复验（全门禁归零）
三笔修复（MCP 派发 task-27a66aff / task-02819340 / task-411b9d10）已合入工作树，Lead 独立复跑全门禁：typecheck 0 错误、build 通过、test:models 23/23（原 9 用例崩溃归零）、smoke:xiaozhi 34/34（原契约断言失败归零）、test:unit 223/223、smoke 93/93。执行者自验：删除项目→立即 SIGTERM→重启不复活（原始竞态场景闭环）。本条与修复一并入库。
