---
id: task-59
title: 工作区解耦：权限与共享工作区并发
status: Done
assignee:
created_date: '2026-11-06T13:48:32Z'
updated_date: '2026-11-06T22:11:11Z'
labels:
  - workspace-decoupling
  - feature
dependencies:
  - task-57
  - task-58
priority: High
ordinal: 59000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
实现需求：一个工作区对应一个项目；项目可以选择任意授权在线 DSH 节点发起会话，远端文件在归属节点访问。当前开发会话直接实现，登记依赖和验收，不额外派发重复实现任务。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 远程工作区访问沿用项目授权，无权限用户不能读取或写入
- [x] #2 写入检测读取版本，冲突不覆盖，限制路径逃逸
- [x] #3 会话绑定使用稳定节点身份，端口漂移不导致错误迁移
<!-- AC:END -->

### 2026-11-06T14:21:07Z 开发实现与本地验证记录
当前开发会话已直接实现本条关联功能，未重复dispatch创建第二轮实现任务。
类型检查与build通过；完整单测202/202、独立smoke93/93、远程工具/提示词13项（含UI文件19条检查）通过；双节点mock项目集成验证通过。
说明文档 docs/project-workspace-nodes.md；真实ONENAT双节点模型执行未验收，本地3080 DSH接口未可达。保留In Progress等待真实节点验收和正式交付，未以人工状态冒充平台dispatch自动完成。

### 2026-11-06T14:54:26Z 顺序验收补充边界
MCP浏览器登录身份需要从server.handleRequest传递到最终ToolCallContext.session；仅handleRequest opts声明session而execute ctx遗漏session仍会按服务通道放权。
应覆盖同MCP会话不同用户、权限撤销后的重放缓存；项目工具变更必须保持create/update幂等性，不能为避免缓存泄漏而使同id请求重复创建无workspace项目。

### 2026-11-06T17:47:41Z 顺序验收预读：文件能力需独立授权回归
已独立复跑project-identity-e2e：10/10，通过项目元数据MCP/HTTP身份、撤销后same RPC ID读取重放与写入幂等。此结果不替代文件能力授权。
需直接验证workbuddy_file_manage list/download/upload/delete、upload_resumable_init/upload_register，以及HTTP项目文件路由：无权限用户不可读写或获得节点凭据；同MCP会话换用户及权限撤销后的缓存不能泄漏内容/直传凭据。检查文件工具execute与canReplay；不要仅凭项目get/upsert测试判AC1通过。
AC2/3可复用task57真实主/子CAS、路径边界及漂移受控测试证据，明确真实与mock边界。等待task57/58正常完成后只派发一次；目前无task59关联任务。

### 2026-11-06T18:19:28Z HTTP与MCP文件授权需分别覆盖读写
只读预读：router.resolveFsTarget(projectId)仅canSeeProject(view)，各fs路由共用；需证明普通只读成员的mkdir/upload/delete等写入是否受edit权限保护，不仅无成员404。
通用node/agent查询未带projectId是否可绕过项目授权，需结合产品角色/节点授权契约验证，禁止仅加projectId分支检查却留下等价路径旁路。文件路径/root约束也需覆盖相同节点不同私有项目。
先读取权限模型与已有角色契约，再用隔离mock统计真实FS调用，授权失败应在节点HTTP请求前拒绝；不要输出真实节点密钥或改线上权限。

### 2026-11-06T18:41:15Z 派发为任务
task-355cd5c5 · mode=chat · 成员=1

### 2026-11-06T18:51:35Z 共享路径检查需覆盖root别名并注明竞态边界
预读workspace-files.ts：requireWorkspacePath按词法root和节点别名比较项目；checkWorkspaceFsPath从fsList(root)起步。需测试授权项目root自身/祖先为symlink指向另一无权项目时是否绕过跨项目隔离；不能只测试root下面的子链接。
remote helper明确允许root通过symlink解析，且只协调协作worker、不防敌对目录替换。HTTP先list后download/delete存在TOCTOU边界，需明确可信owner/非敌对本地写者假设，不将逐级list称作原子或OS级隔离。
普通macOS /var与/private/var等合法root别名仍需兼容；如缺远端原子安全文件API，明确能力拒绝或限制，而非声称词法检查已证明真实路径隔离。

### 2026-11-06T18:53:24Z CAS接入需验证现有控制台上传契约
src/web-ui.ts项目和任务文件上传当前仅multipart文件，无expectedSha256；后端CAS接入后需验新建成功、同名文件拒绝并明确冲突提示、合法带版本更新。不可为UI兼容恢复盲覆盖。
上传多文件若部分成功后另一文件冲突，响应须明确已写入哪些文件，避免返回笼统失败后用户重试产生误判。相同MCP请求重放既要幂等又要重新授权。
另注意workspace-files动态import依赖scripts/workspace-remote.mjs，npm包缺此资源已记录task60修复；本条测试尽量不改发布清单，避免范围重叠。

### 2026-11-06T18:54:48Z canReplay也需覆盖重叠项目路径权限变化
当前fileManage.canReplay仅fileScope检查task/project成员关系。若已缓存父项目内子目录的download，后来该子目录注册成当前用户无权的私有项目，父项目成员关系未变，重放可能绕过requireWorkspacePath。
请测试相同RPC ID下载后新增重叠私有root/调整其成员，重放须按当前路径权限重新校验；同样考虑task.projectId/workspace/dshRef改变后旧内容回放。建议缓存应绑定实际授权scope版本/指纹，或禁用敏感读取回放并重新读取。不要只测父项目撤销成员。

### 2026-11-06T19:22:35Z Lead独立扩展集成复验13/13通过
独立执行node scripts/workspace-permissions-e2e.mjs，退出0；13场景PASS、10次mock worker执行、466次节点请求、activeSessions=0。日志/tmp/wb-task59-lead-expanded.log。
涵盖multipart创建/版本更新/冲突/并发CAS/部分成功清单、project task附件scoped CAS、缓存写入root/node/task绑定及读取fresh scope。属于隔离模拟DSH实际worker执行，不是真实ONENAT验收。不据此手动Done，等待原任务剩余验证和正常终态回写。

### 2026-11-06T20:03:52Z 当前开发会话完成实现与本地验收

三个AC已勾选；前置task-57、task-58当前均Done，dependencies保持不变。原派发task-355cd5c5只有一次，无重复实现或后续派发；本地status保留In Progress，原平台终态由正常回写处理，不人工设成功。

共用workspace-files策略覆盖REST/HTTP工具/MCP文件7动作：成员读、owner/admin写、归档只读，无权在节点IO前拒绝；通用node/agent与P2P密钥仅admin/服务令牌。重叠私有项目、root/祖先/后代链接和不可信元数据拒绝；MCP读取fresh scope，写重放重新授权并绑定root/node/task。项目multipart/附件使用真实本地worker CAS，版本缺失428、过期409，并发同版本一成一败，部分成功有清单且附件入账。会话持久化逻辑/物理节点身份，端口漂移复用、app改绑拒绝，历史/追问/控制/直传登记不回退旧地址或其他节点。

最终typecheck/build通过、unit223/223、smoke93/93、MCP28/28、权限smoke74/74、文件授权并发15/15（11次实际本地worker、563次mock节点请求、activeSessions=0）、身份10/10、执行8/8、项目workspace集成通过；helper/访问+控制台29/29、项目UI19条、上传UI3条、P2P/ws-inject/orch-file串行集成通过。日志artifacts/task59/，完整映射docs/task-59-acceptance.md，规则已同步权限设计§12和project-workspace-nodes。

本轮没有新增真实ONENAT/模型或浏览器验收；DOM/函数UI检查不冒充浏览器。task57真实CAS证据独立引用。预检TOCTOU、协作锁只约束协议写者、mkdir/delete非版本CAS、canonical root要求、admin/服务令牌范围能力均已披露；npm包helper遗漏仍归task60修复。旧P2P服务REST可见性兼容已修并补回归；新增fixture ID错误与已有同步/异步flush测试竞态保留失败日志，后者仅修正常关闭测试时序，未声称产品存储竞态已修。未commit/push/部署。

### 2026-11-06T20:13:50Z 派发执行（成功）
任务 task-355cd5c5 · 结果=成功
我会在当前开发会话直接完成 task-59，按已加载的 WorkBuddy 与 DSH Web Service 技能核对接口和项目约定，登记依赖并逐项验证三个验收条件。
已确认 task-57、task-58 都已完成，task-59 的依赖登记正确。现有远程工具已有版本校验和稳定节点解析；本条要重点补齐文件访问授权，尤其是普通成员写入、通用节点入口，以及 MCP 缓存重放是否能绕过项目权限。
代码中确认了两个授权缺口：HTTP 文件写入只检查项目“可见”，MCP 文件工具则没有检查请求用户的项目权限。节点目录按现有契约对全员可选，但文件权限需要单独保护。我会让项目写入使用 owner/admin 权限，并限制普通用户通过通用 node/agent 文件入口访问任意目录。
接下来会同步补两处边界：项目文件路径必须落在授权根目录内，MCP 缓存命中时也要重新检查当前权限。由于会调整文件工具参数，我也会应用刚加载的 agent-experience 技能，让版本前置条件和权限限制在工具说明中可见。
授权和路径检查已开始收口到 REST、HTTP 工具和 MCP 共用的逻辑。项目上传将要求创

### 2026-11-06T22:11:11Z 派发执行（成功）
任务 task-355cd5c5 · 结果=成功
我会在当前开发会话直接完成 task-59，按已加载的 WorkBuddy 与 DSH Web Service 技能核对接口和项目约定，登记依赖并逐项验证三个验收条件。
已确认 task-57、task-58 都已完成，task-59 的依赖登记正确。现有远程工具已有版本校验和稳定节点解析；本条要重点补齐文件访问授权，尤其是普通成员写入、通用节点入口，以及 MCP 缓存重放是否能绕过项目权限。
代码中确认了两个授权缺口：HTTP 文件写入只检查项目“可见”，MCP 文件工具则没有检查请求用户的项目权限。节点目录按现有契约对全员可选，但文件权限需要单独保护。我会让项目写入使用 owner/admin 权限，并限制普通用户通过通用 node/agent 文件入口访问任意目录。
接下来会同步补两处边界：项目文件路径必须落在授权根目录内，MCP 缓存命中时也要重新检查当前权限。由于会调整文件工具参数，我也会应用刚加载的 agent-experience 技能，让版本前置条件和权限限制在工具说明中可见。
授权和路径检查已开始收口到 REST、HTTP 工具和 MCP 共用的逻辑。项目上传将要求创
