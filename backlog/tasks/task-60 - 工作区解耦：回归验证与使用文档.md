---
id: task-60
title: 工作区解耦：回归验证与使用文档
status: Done
assignee:
created_date: '2026-11-06T13:48:34Z'
updated_date: '2026-11-06T21:57:09Z'
labels:
  - workspace-decoupling
  - feature
dependencies:
  - task-55
  - task-56
  - task-57
  - task-58
  - task-59
priority: High
ordinal: 60000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
实现需求：一个工作区对应一个项目；项目可以选择任意授权在线 DSH 节点发起会话，远端文件在归属节点访问。当前开发会话直接实现，登记依赖和验收，不额外派发重复实现任务。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 类型检查、单测、build、smoke 通过并保留既有用户修改
- [x] #2 覆盖双节点共享文件、不同节点同路径、重复导入、离线和冲突
- [x] #3 提供模型说明、兼容行为、节点能力要求及可复现验证记录
<!-- AC:END -->

### 2026-11-06T14:21:08Z 开发实现与本地验证记录
当前开发会话已直接实现本条关联功能，未重复dispatch创建第二轮实现任务。
类型检查与build通过；完整单测202/202、独立smoke93/93、远程工具/提示词13项（含UI文件19条检查）通过；双节点mock项目集成验证通过。
说明文档 docs/project-workspace-nodes.md；真实ONENAT双节点模型执行未验收，本地3080 DSH接口未可达。保留In Progress等待真实节点验收和正式交付，未以人工状态冒充平台dispatch自动完成。

### 2026-11-06T15:00:17Z 执行中独立回归发现
node --test --test-name-pattern=task-55 dist-test/tool-ops.test.js：新增2项项目唯一性/私有项目信息保护测试通过。
直接运行node --test dist-test/tool-ops.test.js：6/7通过，task-54超大回包测试fixture缺少engine.logTask导致TypeError；此文件在原test:unit命令中只编译未执行。最终验收需修复fixture并将该测试纳入实际执行，不能只引用202单测通过。

### 2026-11-06T15:04:54Z 工具测试复验更新
工具fixture的engine.logTask已修复；再跑node --test dist-test/tool-ops.test.js仍6/7：task-54断言summary===undefined，实际空字符串。task-55两项仍通过。最终需对齐摘要缺省契约并全部执行通过。

### 2026-11-06T15:11:55Z 工具回归缺口已复验通过
最新构建下独立运行node --test dist-test/tool-ops.test.js：7/7通过。此前engine.logTask模拟缺失和summary缺省值断言已修复；已确认package.json实际纳入tool-ops.test.js执行。最终仍需收集完整单测与所有集成结果。

### 2026-11-06T17:49:02Z 最终验证补充：发布资源和证据版本一致性
task57运行时依赖scripts/workspace-remote.mjs，deploy-standalone.sh已补资源tar/hash；最终需在隔离干净安装树核对dist模块可读helper并完成注入，不能只以bash -n代替资源完整性。不得实际部署正式服务。
最新helper采用v3；最终文档与测试应区分旧v2真实4/4证据、v3最终真实4/4证据，以及v1/v2/编号v2存量升级单测。
task58浏览器mock7/7与真实5/5已通过，早期文件侧栏关闭使用handler的限制需与后续isTrusted真实点击补验分别表述。合并验收前检查源代码/生成产物未因并发构建漂移。

### 2026-11-06T17:55:24Z 真实节点复验资源预算边界
task58补验确认：隔离fixture冷启动探测会消耗凭据接口每分钟2次预算，新加入第三节点可能拿不到凭据并缓存失败。最终复验应共享现有目录实例、遵循正常刷新与预算恢复；不要修改全局保护额度或误将探测限流归为节点选择功能失效。
task57入口补验发现单个@子智能体按现有设计进入规划DAG；若验证runChatTurn须明确入口，不能把DAG结果宣称为直接聊天入口通过。最终报告分别列出真实公共入口、私有方法集成及mock证据。

### 2026-11-06T18:09:04Z 独立隔离安装资源检查通过
Lead已在临时ESM树仅复制dist/workspace-access.js与scripts/workspace-remote.mjs，调用installWorkspaceAccessCli，stub upload收到31158字节并返回v3路径；模块相对资源路径可用。临时根wb-install-resource-check-XxiwVO，未部署、未连真节点。
此检查证明模块/资源布局，不等于完整安装包端到端。最终仍需检查deploy tar资源清单和依赖，避免过度宣称干净部署通过。

### 2026-11-06T18:23:20Z 撤回后公开入口真实验收证据已完成
最终优先引用artifacts/task57/public-live-acceptance.json：2026-11-06T18:22:15.842Z完成，4/4 PASS，21条cleanup无error。公开POST /tasks/:id/messages → sendUserMessage → runOrchestrateTurn → runSubtask，child同session编号v3上传回包与操作关联，main无@对照。
当前runChatTurn已撤回无生产触发依据的刷新task；人工upsert替换测试删除，公开单@派发测试替代并独立1/1通过。最终完整单测220/220、串行工具25/25、smoke93/93；旧chat-live报告包含曾用防护，只作历史，不当最终代码证据。
原失败未采集helper上传回包，编号兼容是独立真实复现且有确定代码缺陷，但不可宣称是原失败唯一根因；验收文档已收窄表述。

### 2026-11-06T18:46:26Z 实际发布资源缺口：npm打包遗漏helper
Lead运行npm pack --dry-run --json成功：1085文件，dist/workspace-access.js已入包，但scripts/workspace-remote.mjs不在包中。package.json files只列scripts/install-skill.sh，deploy tar包含helper不能替代npm包检查。
task60修复package.json files清单纳入helper，并用npm pack隔离解包后安装函数验证真实资源读取；不发布npm、不部署。检查日志/tmp/wb-task60-package-files.json。

### 2026-11-07T05:52:16Z 发布资源修复与AC收口
- package.json files 已纳入 scripts/workspace-remote.mjs（修复后 pack 1088 文件，dist/workspace-access.js 与 helper 均在包内）。
- 隔离安装树验证 6/6 PASS：真实 npm pack → tarball 解包临时树 → 调用真实 installWorkspaceAccessCli，stub 捕获 31158 字节、与仓库 helper SHA256 一致（6c561494101a81de…）、返回编号 v3 路径。证据 artifacts/task60/pack-resource-verify.log、artifacts/task60/pack-files.json。
- AC#1：本轮 fresh 回归 typecheck 0、build 0、完整单测 223/223（test:unit 已实际执行 tool-ops.test.js）、独立 smoke 93/93；既有用户改动全部保留，本轮仅改 package.json files、docs/project-workspace-nodes.md 与本记录。
- AC#2：双节点共享文件/异机同路径（task-57 真实 v3 4/4：owner 归属、brain 无同路径）、重复导入（task-55 集成 10/10）、离线拒绝（task-57/58 独立报告）、冲突（task-57 stale-CAS、task-59 并发）均有已登记证据；本轮未重跑真实节点，不将历史证据重复计入。
- AC#3：docs/project-workspace-nodes.md 含模型说明、v2/v3 兼容区分、节点能力要求与可复现验证记录，本轮追加 task-60 发布资源补充小节。
- 保持 In Progress：commit/push/正式部署与真实交付留待用户决定；本轮未发布 npm、未部署正式服务、未派发后续任务。

### 2026-11-06T21:53:42Z 派发为任务
task-71b9d5a9 · mode=chat · 成员=1

### 2026-11-06T21:53:47Z 派发为任务
task-11d25f20 · mode=chat · 成员=1

### 2026-11-06T21:56:59Z 派发执行者独立复跑回归（不重复实现，仅验证）
本会话为 task-60 派发任务执行者，未改任何源码，仅独立复跑回归并核验证据：
- AC#1 全新复跑全绿：typecheck exit=0、build exit=0、完整单测 223/223（含 tool-ops/task-53/54/55/56 回归）、独立 smoke 93/93。日志 artifacts/task60/regression-rerun-dispatch.log。git 已跟踪改动保持 29 个文件未增减，既有用户修改全部保留。
- AC#2 证据逐项核验：双节点共享文件+异机同路径 → artifacts/task57/public-live-acceptance.json 4/4 PASS（owner 6cc2987d / executor 5602f2c2，childRoute=public，文件仅落 owner、无 helper 会话泄漏）；重复导入 → scripts/project-identity-e2e.mjs 10/10（/projects/import 复用与唯一性冲突）；离线 → artifacts/task57/offline-live.json NODE_OFFLINE PASS（真实离线节点不发请求）；冲突 → task-57 stale-CAS 写步骤 PASS + artifacts/task59/permissions-final15.log 授权并发 15/15（activeSessions=0）。
- AC#3 文档四要素齐备：docs/project-workspace-nodes.md 含模型说明（数据与选择规则）、v2/v3 兼容区分（兼容与权限 + task-60 小节）、节点能力要求（Node>=20、DSH 会话接口、模型工具权限）、可复现验证记录（验证章节 + task-55～60 补充）。
- 派发记录存在两条（task-71b9d5a9 / task-11d25f20，21:53:42Z/47Z），属重复派发；终态回写由服务端自动完成，本会话不手工改待办状态、不 commit/push、不部署、不再派发后续条目。

### 2026-11-07T05:56:41+08:00 回归验证独立复跑（AC#1 全链路复核）
本会话全新复跑，非引用历史日志：typecheck 0 错误；完整单测 223/223（tool-ops.test.js 实际纳入执行，含 task-53/54/55/56 用例）；build 通过（dist/server.js）；独立 smoke 93/93。npm pack --dry-run 复核：1088 文件，dist/workspace-access.js 与 scripts/workspace-remote.mjs 均在包内（此前 files 清单缺口保持已修复）。
工作区漂移检查：tracked 修改仍为开工时同一批 29 个文件，既有用户改动全部保留；本轮仅由构建脚本再生 dist/，未手工改动产物。
AC#2/#3 沿用已登记证据不重复计入：task-57 真实 v3 4/4（双节点共享文件、异机同路径）、task-55 集成 10/10（重复导入）、task-57 stale-CAS 与 task-59 并发（冲突）、task-57/58 离线拒绝；使用文档 docs/project-workspace-nodes.md 含模型说明、v2/v3 兼容、节点能力要求与可复现验证记录。
维持 In Progress：commit/push、正式部署与真实 ONENAT 双节点模型验收留待用户决定；本轮未发布 npm、未部署正式服务、未派发重复实现任务。

### 2026-11-06T21:57:09Z 派发执行（成功）
任务 task-71b9d5a9 · 结果=成功
我来处理 backlog 待办 task-60「工作区解耦：回归验证与使用文档」。先了解仓库当前状态，再执行回归验证。分支上有大量未提交的工作区解耦实现（task-55~59）。先读 task-60 待办原文和相关验收文档，确认验收口径。task-60 此前已有实现与验收记录（最近一条 05:52 收口），本轮交付重点是**在本会话做一次全新的回归验证**并确认使用文档与证据完整。先看脚本定义与既有证据，再跑完整回归。证据与文档齐备（`artifacts/task60/`、`docs/project-workspace-nodes.md` 补充小节）。现在按 AC#1 做本会话全新回归验证。typecheck 通过。继续单测（修正 todo 格式）。单测 223/223 全部通过。继续 build + smoke。smoke 93/93 通过。复核 npm pack 资源清单与工作区改动状态。全部回归项通过。现在把本轮复跑记录登记进 task-60 待办文件。task-60「工作区解耦：回归验证与使用文档」本轮独立复跑完成，全部通过。

## 回归验证结果（本会话全新执行，非引用历史日
