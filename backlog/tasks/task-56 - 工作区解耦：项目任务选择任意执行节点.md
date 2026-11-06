---
id: task-56
title: 工作区解耦：项目任务选择任意执行节点
status: Done
assignee:
created_date: '2026-11-06T13:48:30Z'
updated_date: '2026-11-06T16:00:28Z'
labels:
  - workspace-decoupling
  - feature
dependencies:
  - task-55
priority: High
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
实现需求：一个工作区对应一个项目；项目可以选择任意授权在线 DSH 节点发起会话，远端文件在归属节点访问。当前开发会话直接实现，登记依赖和验收，不额外派发重复实现任务。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 项目默认执行节点与文件归属节点独立保存
- [x] #2 项目会话支持 projectId + nodeRef，旧任务不随项目默认节点修改迁移
- [x] #3 主会话和子智能体都不会把远程项目路径当本地 cwd
<!-- AC:END -->

### 2026-11-06T14:21:05Z 开发实现与本地验证记录
当前开发会话已直接实现本条关联功能，未重复dispatch创建第二轮实现任务。
类型检查与build通过；完整单测202/202、独立smoke93/93、远程工具/提示词13项（含UI文件19条检查）通过；双节点mock项目集成验证通过。
说明文档 docs/project-workspace-nodes.md；真实ONENAT双节点模型执行未验收，本地3080 DSH接口未可达。保留In Progress等待真实节点验收和正式交付，未以人工状态冒充平台dispatch自动完成。

### 2026-11-06T15:23:47Z 派发为任务
task-e244b73a · mode=chat · 成员=1

### 2026-11-06T15:27:11Z 顺序跟进只读预检
重点核对forkTask旧任务无nodeRef且项目默认执行节点已变更时的续接语义：原任务必须保留原文件节点执行，新建fork是否继承原有效节点或当前默认节点需明确并给测试证据。
相关基线独立复验6/6通过：显式/默认快照、跨节点fork、主会话cwd隔离、端口漂移、app身份及退出项目。尚不能代替子智能体cwd和持久化重启专项验收。

### 2026-11-06T15:35:51Z 顺序执行交叉验证
独立使用package.json相同tsc编译后执行node --test --test-name-pattern=task-56 dist-test/engine.test.js dist-test/tool-ops.test.js：4/4通过，覆盖@项目快照、规划和主/子会话异机cwd、回退workDir、mapping/app/direct透传与按节点去重。
已核对artifacts/task56/unit-final.log：215项、215通过、0失败；仍需持久化/HTTP路由及真实跨节点执行验收，未人工修改完成状态。

### 2026-11-06T15:37:38Z 新增集成独立复验中间结果
首次独立运行node scripts/project-execution-e2e.mjs，第一组111行失败：PUT defaultExecutionNodeRef:null预期200实际400。请区分当前dist/源码构建与字段清除契约；最新构建需完整8组通过后再验收。日志/tmp/wb-task56-independent-e2e.log。

### 2026-11-06T15:45:03Z 真实跨节点结果交叉核对
已读取artifacts/task56/live-acceptance.json：主会话在brain执行、cwd为executor临时目录，通过HTTP读取KB136 owner文件且SHA256一致；修改默认节点后旧会话不迁移、新任务使用新默认均PASS。
子会话真实验收FAIL：远端模型空回答，尚不能标记全部通过。报告显示本次测试会话、目录和新增workspace全部清理成功。需选择实际可用模型并重新验收，保留首轮失败证据。

### 2026-11-06T15:49:21Z 真实节点第二轮证据交叉确认
已核对live-acceptance.log及json：真实节点4/4 PASS；主会话与子会话均在brain executor临时目录运行并读取KB136 owner文件，哈希一致；默认节点变更不迁移旧会话。
首轮失败报告已另存live-acceptance-first.json/log；原因为测试agent model误填provider/model，第二轮正确分离provider/model。最新报告所有会话删除、目录及新增workspace清理均成功。仍等待原任务完成最终回归和自动终态回写。

### 2026-11-06T15:55:36Z task-56 最终验收记录

三项 AC 已有实际证据并勾选；详细实现、复现命令、日志与边界见 [task-56 验收记录](../../docs/task-56-acceptance.md)。

- #1：文件归属 dshRef/根目录/凭证与默认执行节点独立保存；REST/MCP 仅改默认节点不要求重传名称，省略保留、null 清除，重启保持配置；文件请求仍路由文件节点。
- #2：projectId + mapping/app/direct nodeRef 均支持；@项目首次绑定快照执行节点；精确/近似去重按项目和节点区分；改默认值、重启及模拟公网端口漂移不迁移旧任务。旧无 nodeRef 任务继续用文件节点，同项目默认 fork 也继承该有效节点；显式改节点或切项目按新选择。
- #3：实际规划/主/子会话创建载荷不使用远程项目 cwd/workspaceId、不在异机 mkdir 归属路径；子智能体保留自身目录，异机回退不继承旧 workDir。真实两节点主/子会话 cwd 均为 brain 临时目录，通过 KB136 文件接口读回随机文件及相同 SHA256；前后确认 brain 不存在 owner 路径。
- 最终 typecheck/build 通过；完整单测 216/216、执行节点 HTTP/MCP 集成 8/8、task-55 身份权限集成 10/10、smoke 93/93、MCP smoke 28/28；既有双节点集成、远程工具 12/12、UI 函数专项 19 条、ws-inject 与 orch-file 通过；git diff --check 通过。
- 真实 ONENAT 复验 4/4，实时解析 mapping 6cc2987d（KB136，文件）与 5602f2c2（brain，执行），未固定公网端口。报告 [live-acceptance.json](../../artifacts/task56/live-acceptance.json)。首轮 3/4 失败报告保留，测试子智能体 provider/model 配置修正后通过；远端会话、临时目录和新增 workspace 两轮均清理成功。
- fork 旧数据回归曾 215/216，修复前日志保留；最终 216/216。规划回归最初终态断言写错已更正，未把那次断言错误冒充 cwd 失败证据。
- 限制：未部署/验收正式 WorkBuddy，未做新的真实浏览器交互；公网端口漂移为 mock 演练；真实子会话经确定性单项计划运行实际派工链路，未声称真实 LLM 拆解全链路验收；task-57 的远程写入/构建/Git 实测不在本条范围。
- dependencies 保留 task-55（已 Done）；仅处理本条，无后续或重复实现派发。保留全部未提交修改，未 commit/push/部署。状态仍为 In Progress，原任务 task-e244b73a 正常终态由平台自动回写，未人工设成功。

### 2026-11-06T16:00:28Z 派发执行（成功）
任务 task-e244b73a · 结果=成功
我会按 task-56 的三条验收逐项复核，先读已有说明、实现和测试，再补实际发现的缺口。本次会使用已加载的三个技能核对接口与节点行为；保留现有修改，不重复派发任务，不提交、不部署。
已确认 task-55 已由原任务自动回写为 Done，task-56 的依赖登记正确。现有实现已经拆分了文件归属节点和默认执行节点；已有双节点测试主要覆盖主会话，我会继续核对持久化、旧会话续聊及子智能体的 cwd，补足能证明这三条验收的证据。
发现了两处与验收直接相关的缺口：编排器仍可能在异机执行节点创建项目目录并传给规划会话；通过 `@项目` 首次绑定时，也没有保存默认执行节点快照。MCP 创建路径另有 app 引用未透传、去重未区分节点的问题，我会一起补回归测试，并按 `agent-experience` 技能核对工具说明。真实节点探测首次失败是因为本地配置指向已停止的 mock ONENAT；接下来改用实时目录对应的配置。
已通过实时 ONENAT 目录确认 KB 136 和 brain 两个 DSH 节点可达，鉴权和模型目录读取均成功，可以开展真实跨节点验收。本地新增回归已复现 `@项目` 快照
