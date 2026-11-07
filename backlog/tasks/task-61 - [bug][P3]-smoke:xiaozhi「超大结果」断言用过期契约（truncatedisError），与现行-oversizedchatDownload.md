---
id: task-61
title: '[bug][P3] smoke:xiaozhi「超大结果」断言用过期契约（truncated/isError），与现行 oversized/chatDownloadUrl 降级实现不符，套件必失败'
status: Done
assignee:
created_date: '2026-11-06T23:22:11Z'
updated_date: '2026-11-06T23:56:27Z'
labels:
  - bug
  - test
  - smoke
  - mcp
dependencies:
priority: P3
ordinal: 61000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
复现：npm run smoke:xiaozhi → 退出码 1，31/32 项通过，唯一失败项「超大结果被单帧上限替换为结构化提示」（连续 2 轮复现，2026-11-07 验证重跑）。

证据：scripts/smoke-xiaozhi-mcp.mjs:328-334 断言 bigJson.truncated===true && bigStatus.result.isError===true；实际 task_status detail:full 超大（123675B > 32768B）返回 {ok:true, oversized:true, bytes:123675, thresholdBytes:32768}（无 truncated 字段、非 isError）。

根因分析：commit 45b654a「fix(mcp): 超大任务详情降级为聊天内容下载 URL」把实现与对外 SKILL.md 契约统一为 oversized + ok:true + chatDownloadUrl（明确定义「绝不会报结果过大丢失内容」），但 smoke-xiaozhi-mcp.mjs 仍按旧契约（truncated + isError）断言，测试脚本未随契约升级。实现行为与现行文档一致，属测试脚本过期，非服务故障。

影响：npm run smoke:xiaozhi 恒为退出码 1，无法作为回归门禁；每次全量重跑都被误报为失败，掩盖真实回归。

建议修复（任选其一并保持三方一致）：A. 升级断言为新契约（oversized===true && ok===true && chatDownloadUrl 存在 && 正文不被截断）；B. 如坚持旧契约则需 reverted 45b654a 并同步文档——不推荐。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 npm run smoke:xiaozhi 退出码 0，全部断言通过
- [ ] #2 「超大结果」断言与 SKILL.md/workbuddy-mcp 文档描述的降级契约一致（oversized + chatDownloadUrl）
- [ ] #3 断言同时校验：超大正文未被半截返回（正文长度 < 单帧上限且无截断 JSON）
<!-- AC:END -->

### 2026-11-06T23:54:50Z 派发为任务
task-27a66aff · mode=chat · 成员=1

### 2026-11-06T23:56:27Z 派发执行（成功）
任务 task-27a66aff · 结果=成功
The download works; my second check misapplied the 64KB limit — `bytes` is the size of the *full detail* (which is allowed to exceed the frame), while the actual guarantee is that the tool **response** itself stays small. Fixing:修复完成，采用 backlog 建议的方案 A（升级断言到现行降级契约）。

## 改动（scripts/smoke-xiaozhi-mcp.mjs:322-343）

把旧契约断言（`truncated===true && isError===true`）替换为与 commit 45b654a / SKILL.md 一致的三段校验：

1. **降级契约**：`ok===true && oversized===true && truncated===undefined && chatDownloadUrl 为合法 URL && byt


### 2026-11-07T08:10:00+08:00 修复合入与 Lead 独立复验（全门禁归零）
三笔修复（MCP 派发 task-27a66aff / task-02819340 / task-411b9d10）已合入工作树，Lead 独立复跑全门禁：typecheck 0 错误、build 通过、test:models 23/23（原 9 用例崩溃归零）、smoke:xiaozhi 34/34（原契约断言失败归零）、test:unit 223/223、smoke 93/93。执行者自验：删除项目→立即 SIGTERM→重启不复活（原始竞态场景闭环）。本条与修复一并入库。
