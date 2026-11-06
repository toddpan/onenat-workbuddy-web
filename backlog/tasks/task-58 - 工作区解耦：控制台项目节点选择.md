---
id: task-58
title: 工作区解耦：控制台项目节点选择
status: Done
assignee:
created_date: '2026-11-06T13:48:32Z'
updated_date: '2026-11-06T18:02:23Z'
labels:
  - workspace-decoupling
  - feature
dependencies:
  - task-56
priority: High
ordinal: 58000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
实现需求：一个工作区对应一个项目；项目可以选择任意授权在线 DSH 节点发起会话，远端文件在归属节点访问。当前开发会话直接实现，登记依赖和验收，不额外派发重复实现任务。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 项目内新会话可选择在线节点并携带 nodeRef
- [x] #2 项目编辑区分文件节点和默认执行节点，展示远程访问状态
- [x] #3 文件树与 backlog 始终访问文件归属节点，移动端 <=768px 可用
<!-- AC:END -->

### 2026-11-06T14:21:06Z 开发实现与本地验证记录
当前开发会话已直接实现本条关联功能，未重复dispatch创建第二轮实现任务。
类型检查与build通过；完整单测202/202、独立smoke93/93、远程工具/提示词13项（含UI文件19条检查）通过；双节点mock项目集成验证通过。
说明文档 docs/project-workspace-nodes.md；真实ONENAT双节点模型执行未验收，本地3080 DSH接口未可达。保留In Progress等待真实节点验收和正式交付，未以人工状态冒充平台dispatch自动完成。

### 2026-11-06T17:03:40Z 派发为任务
task-22da2aa8 · mode=chat · 成员=1

### 2026-11-06T17:40:04Z task-58 独立验收

依赖 task-56 当前 Done；保留该依赖，未另派发实现或后续条目。三项 AC 已本地逐项验收，详细证据见 [task-58 验收记录](../../docs/task-58-acceptance.md)。

本轮仅修复实测缺口：移动节点菜单按实际高度/可视视口定位；同项目切换执行节点时刷新文件访问说明并保留目录树；768px 关闭抽屉按 -100vw 完全隐藏，避免拦截发送按钮。产品增量仅 src/web-ui.ts；保留所有原有未提交改动及本轮并行engine/helper更新。

最终typecheck/build通过，unit218/218、smoke93/93、UI专项19条+新增4项、远程工具25/25、执行集成8/8、项目workspace集成、diff检查通过。实际mock浏览器桌面+320/390/768px共7/7组；真实ONENAT浏览器5/5组：KB136归属文件、brain执行会话完成，实际cwd为brain临时目录，文件/backlog从KB136读取且随机文件SHA256一致。目录新增/离线故障测试也通过；先前失败日志完整保留。

真实运行采用正常draft落盘后由隔离fixture指定临时workDir再发送；mock覆盖一键首消息POST携带projectId+nodeRef。首次移动文件侧栏关闭因翻译扩展遮挡曾调用原生按钮处理器，不能作为用户点击证据；已按用户要求补做隔离扩展后的真实点击复验，详见下方记录。未验真实微信/X5/移动软键盘，不能将Chromium模拟当真机证明。

临时会话、两侧目录、增量workspace、本地临时数据均清理；Ego任务空间已结束。未commit/push/正式部署，未递归发送原宿主任务。保留In Progress，终态由原派发task-22da2aa8正常流程回写，不人工设平台成功。

### 2026-11-07 用户要求的真实点击复验（北京时间）

独立读取原 browser-run-second.log，确认#1/#2 PASS，后续是kiss-translator-fab拦截关闭按钮；保留原文件并记录SHA256。仅在隔离测试页移除扩展fab/box独立容器并监控重新注入，没有改产品源码，也没有evaluate强制click。320/390/768px均实测elementFromPoint命中btn-ws-close、浏览器page.click产生isTrusted=true事件、侧栏确实关闭，后续完整浏览器7/7通过。

当前工作树统一typecheck/build、unit218/218、smoke93/93、UI4/4通过，helper/remote合跑25/25、结果边界单独2/2（是前者子集，不能相加）；并行中间态旧失败保留，不归为当前缺陷。本轮只更新测试与证据；详情及失败复验日志在docs/task-58-acceptance.md与artifacts/task58/interaction-retest/。临时fixture正常退出并清理，浏览器空间15已结束，无正式部署/重复派发。

### 2026-11-06T17:59:43Z 最终收尾

独立核对原mock browser7/7、live browser5/5均PASS；live fixture-report清理5/5成功（会话、两侧临时目录、新增workspace、本地数据）。AC3/3已勾选，依赖task-56不变。原mock轮收起文件栏曾因翻译扩展遮挡使用handler点击，不能称该轮全真实点击；后续独立指针复验保留为补充证据，未改写原轮局限。

仅收尾已有范围，不再扩张测试；未提交/部署。任务完成结论通过最终答复交还原派发task-22da2aa8正常自动回写，不手工设平台成功。完整证据见docs/task-58-acceptance.md。

### 2026-11-06T18:02:23Z 派发执行（成功）
任务 task-22da2aa8 · 结果=成功
task-58 已完成，**AC 3/3、验收文档和必要清理均已收尾**，交由原派发任务按正常 `completed` 流程自动回写。

已有证据：UI mock **7/7**、live **5/5**；fixture 清理 **5/5 成功**。[最终验收记录](<docs/task-58-acceptance.md#L92>)已登记结果与边界。

原 mock 轮收起文件栏使用 handler 点击，不能称为全真实点击；该局限保留。微信/X5 真机及移动软键盘仍未验证。

本轮不再执行历史调查或重复真实测试；未另开任务、派发后续任务、提交或部署。
