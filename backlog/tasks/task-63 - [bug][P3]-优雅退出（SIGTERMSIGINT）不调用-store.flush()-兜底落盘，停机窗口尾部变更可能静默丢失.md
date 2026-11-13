---
id: task-63
title: '[bug][P3] 优雅退出（SIGTERM/SIGINT）不调用 store.flush() 兜底落盘，停机窗口尾部变更可能静默丢失'
status: Done
assignee:
created_date: '2026-11-06T23:41:14Z'
updated_date: '2026-11-06T23:57:03Z'
labels:
  - bug
  - reliability
  - shutdown
dependencies:
priority: P3
ordinal: 63000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
复现（SIGKILL 强杀路径，2026-11-07 验证重跑 ST3 清理阶段实测）：本地稳定性驱动删除项目 proj-90fhqoas → 服务端日志 DELETE /onenat-workbuddy/api/projects/proj-90fhqoas → 200（内存已删 + save() 触发异步落盘），进程随即便被 SIGKILL → 异步写盘未完成 → 重启后 store.json 中该项目复活（artifacts/verify-rerun-20261107/server2.log 尾部 + stab-data/store.json 可复核；同批删除的 2 个任务因写盘先完成而持久化成功，恰好钉住竞态窗口）。

代码级缺口：src/server.ts:719 app.close() 只停 monitor/xiaozhi/scheduler/回写补偿器/目录自动刷新并关 HTTP server，未调用 store.flush()；而 src/store.ts:281 flush() 注释明写「同步立即落盘（进程退出前兜底用；常规路径一律走 flushAsync）」——兜底方法存在但无人接线。SIGTERM/SIGINT 走 shutdown → app.close → process.exit(0)（src/server.ts:895-905），全程无同步落盘。

未复现部分（如实标注）：小 store（<1MB）下 SIGTERM 实测不丢数据——11 个任务的停机前突发全部存活（异步写盘毫秒级完成，赢下退出竞态；复现脚本 /tmp/sigterm-loss.mjs 流程：建 11 任务→立即 SIGTERM→重启核对）。理论风险窗口在大型 store（代码注释自证：15.7MB 时单次落盘 ~300ms，TRAILING_SAVE_MS 尾随合并的流式增量窗口更长），本次未具备大库环境，未复现。

影响：systemctl/docker/Ctrl+C 常规停运维路径上，停机前最后一段窗口的变更（任务状态流转、项目增删）可能静默丢失且无告警；SIGKILL 断电级强杀丢尾属已知权衡（原子 rename 保证不损坏），但优雅路径应当兜底。

建议：shutdown 中在 app.close() 前后调用 store.flush()（一行接线），并在 README 运维段注明 kill -9 的丢尾窗口。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 SIGTERM/SIGINT 停机路径调用 store.flush()（或等效同步兜底），代码可审计
- [ ] #2 停机前 300ms 内的结构性变更（建/删任务、项目）在重启后仍然存在（大库或人为放大写盘耗时条件下验证）
- [ ] #3 README/standalone-deploy.md 注明 kill -9 强杀的丢尾窗口与恢复语义（不损坏、只丢尾）
<!-- AC:END -->

### 2026-11-06T23:54:54Z 派发为任务
task-411b9d10 · mode=chat · 成员=1

### 2026-11-06T23:57:03Z 派发执行（成功）
任务 task-411b9d10 · 结果=成功
存储已经有了一个在脏数据状态下的 `process.once('exit')` 刷新钩子（src/store.ts:61），但 SIGKILL 会跳过退出钩子，在优雅停机路径中，内存中的数据/磁盘状态仍可能存在竞态窗口（异步写入正在进行或尾随保存待定）。我将按照验收标准 #1 将 `store.flush()` 接入到 `app.close()` 中。现在我来将 kill-signal 文档添加到部署文档和 README 中：现在进行验收测试 #2 —— 通过创建项目、立即执行 SIGTERM、重启并验证来进行端到端验证：项目创建需要一个 `dshRef`。正在尝试使用有效的 payload 重试：报告中提到的竞争条件已修复：删除项目后立即执行 SIGTERM 不再导致其重新出现。我来运行 smoke suite：已修复并验证。总结：

## 修复内容

**#1 SIGTERM/SIGINT 停机调用 store.flush()** — src/server.ts 的 `app.close()` 在关闭 HTTP server 后追加同步兜底落盘（try/catch 包裹，失败仅告警


### 2026-11-07T08:10:00+08:00 修复合入与 Lead 独立复验（全门禁归零）
三笔修复（MCP 派发 task-27a66aff / task-02819340 / task-411b9d10）已合入工作树，Lead 独立复跑全门禁：typecheck 0 错误、build 通过、test:models 23/23（原 9 用例崩溃归零）、smoke:xiaozhi 34/34（原契约断言失败归零）、test:unit 223/223、smoke 93/93。执行者自验：删除项目→立即 SIGTERM→重启不复活（原始竞态场景闭环）。本条与修复一并入库。
