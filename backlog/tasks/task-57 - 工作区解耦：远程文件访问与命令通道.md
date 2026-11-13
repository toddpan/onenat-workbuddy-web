---
id: task-57
title: 工作区解耦：远程文件访问与命令通道
status: Done
assignee:
created_date: '2026-11-06T13:48:31Z'
updated_date: '2026-11-06T18:41:12Z'
labels:
  - workspace-decoupling
  - feature
dependencies:
  - task-55
  - task-56
priority: High
ordinal: 57000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
实现需求：一个工作区对应一个项目；项目可以选择任意授权在线 DSH 节点发起会话，远端文件在归属节点访问。当前开发会话直接实现，登记依赖和验收，不额外派发重复实现任务。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 跨节点主会话无需 @ 自动获得远程访问能力，子智能体同样可用
- [x] #2 支持目录浏览、文本读取、写回和冲突检测，文件保留在归属节点
- [x] #3 命令在文件归属节点执行，能力缺失或离线明确报错，连接实时解析 ONENAT
<!-- AC:END -->

### 2026-11-06T14:21:06Z 开发实现与本地验证记录
当前开发会话已直接实现本条关联功能，未重复dispatch创建第二轮实现任务。
类型检查与build通过；完整单测202/202、独立smoke93/93、远程工具/提示词13项（含UI文件19条检查）通过；双节点mock项目集成验证通过。
说明文档 docs/project-workspace-nodes.md；真实ONENAT双节点模型执行未验收，本地3080 DSH接口未可达。保留In Progress等待真实节点验收和正式交付，未以人工状态冒充平台dispatch自动完成。

### 2026-11-06T14:50:19Z 顺序执行前只读预检
重点核对AC3：当前workspace-remote.mjs只接收--base URL，需验证长会话中ONENAT端口漂移后每次工具操作是否能重新解析稳定mapping/app身份；不能仅凭提示词创建时resolve一次宣称持续实时解析。
真实节点验收应使用隔离临时目录和小文件，记录list/read/write冲突/exec位置及失败清理证据；不能用mock结果替代真实模型执行结论。

### 2026-11-06T16:00:50Z 派发为任务
task-10560a65 · mode=chat · 成员=1

### 2026-11-06T16:03:03Z 远程请求漂移与重放验收边界
稳定引用解析需覆盖创建临时会话、prompt和DELETE清理三个阶段的端口漂移；已有session只能随同一稳定节点更新入口，不得因目录变化迁移到另一实体。
写入/exec在网络断开或prompt超时后结果可能已发生，禁止透明重放；应明确结果不确定并提供read/CAS核验路径。新增测试需区分解析失败未发送与已发送但回包丢失。

### 2026-11-06T16:04:03Z 注入上下文一致性补充
workspace-access.ts目前helper和curl读取配方都固定base，最后一行仅要求刷新上下文。新增稳定引用应同时更新主会话/子智能体注入：helper可用时优先稳定解析配方，静态curl明确是本轮快照，离线不允许误用本地目录。
目录授权凭据与DSH节点凭据需分开；helper上传文件保持无凭据。报告及新增测试产物不得包含真实token。

### 2026-11-06T16:08:10Z 已有会话helper升级检查
引擎现有workspaceAccessCliPath会缓存旧helper路径。新增稳定参数上线后，已有远端会话不可继续调用不认识--node-ref的旧脚本；请验证版本化文件名/绑定标记或必要重新上传，涵盖重启后旧会话续聊。
同节点判断应使用稳定引用；缺directory配置的稳定项目须明确不可用，不得静默降级固定--base并宣称实时解析。

### 2026-11-06T16:09:56Z 稳定解析独立回归中间失败
独立运行node --test scripts/workspace-remote-test.mjs：10/13通过，3项稳定解析场景失败。resolveWorkspaceTarget拼接根URL后生成//api/v1/sessions，mock返回500；日志/tmp/wb-task57-stable-regression.log。
请修复URL pathname规范化后完整复验；当前目录失败清理场景尚未执行到目标断言，不能将其当作清理逻辑失败证据。

### 2026-11-06T16:16:04Z 真实往返验收证据要求复核
workspace-roundtrip-live.mjs已检查语法；主/子lane执行完成后，控制端应独立通过owner HTTP下载txt和built产物核对最终哈希，确认executor无owner同路径；模型回复/报告文件不能单独作为写回证明。
remote()当前prompt fetch失败而DELETE成功时仍原样抛网络错误，CLI泛化UNVERIFIED_OR_UNSUPPORTED；请复核用户能否明确知道写入/exec可能已发生，增加已发送请求丢回包测试和明确不确定文案，禁止自动重放。

### 2026-11-06T16:30:07Z 已复现：写入请求丢回包缺明确不确定提示
隔离fetch故障注入已复现：POST sessions成功，POST prompt抛TypeError模拟写入后丢回包，DELETE成功。remote()返回code=null、仅原始网络消息；调用顺序正确无重放，但用户不知道操作可能已发生。日志/tmp/wb-task57-lost-response.log。
请为已发送prompt无有效回包增加明确OUTCOME_UNCERTAIN或同义code/文案并回归；不要把目录解析失败未发送请求也标成已执行不确定。此复现无真实网络或文件写入。

### 2026-11-06T16:33:56Z 上传worker回归补充检查
独立验证makeWorkerSource生成脚本list正常且自删除。上传worker包含写入正文和exec参数，请覆盖有效冲突结果也自删除、prompt拒绝未运行时按精确上传路径清理、目录离线清理失败明确报告，不留下正文临时文件却声称成功。
prompt目前称read-only worker script，但write/exec会修改文件；请改为不可编辑的uploaded worker之类准确措辞，避免模型误以为这是只读授权。

### 2026-11-06T16:40:42Z 最新真实运行启动前失败需保留原始错误
最新live报告No actual executor session且requests=[]、mainStatus=failed，失败发生于worker之前。verifyLane只断言binding掩盖原始任务错误；请在清理前脱敏保存final.error/last turn/任务日志，以定位节点解析、鉴权或测试配置问题。
透明提示仍需单次真实list验证，不要将启动前失败归因为模型拒绝。保留本轮报告后修复明确原因再运行，避免只重复全套测试。

### 2026-11-06T16:45:12Z 独立发布资源完整性检查
独立核对deploy-standalone.sh：当前资源tar仅打包skills和scripts/install-skill.sh，未包含运行时workspace-access.ts读取的scripts/workspace-remote.mjs。请修复打包/漂移检测或明确关联task-60验收，确保干净安装可注入工具；本轮不实际部署。

### 2026-11-06T16:54:03Z HTTP结果文件通道验收边界
结果文件改造后请覆盖：prompt超时但有效JSON已生成只读回不重放；nonce/op/requestHash错误拒绝；JSON损坏或超大结果明确失败；404表示脚本/结果已不存在时清理幂等但不吞鉴权/目录离线错误。
目前mode=result直接response.text()没有大小边界，worker可返回8MiB正文base64和exec输出；应给合理上限并避免无限内存。结果及.tmp文件均可能含项目正文，成功与失败路径都需精确清理。

### 2026-11-06T17:03:25Z 派发执行（成功）
任务 task-10560a65 · 结果=成功
我会先核对现有文档、代码和测试，保留全部未提交修改；只修复 task-57 的验收缺口。重点验证远程工具每次操作是否按稳定节点身份重新解析 ONENAT，并在真实节点的隔离目录中实测文件访问、冲突检测和命令位置，逐项记录证据。执行时会遵循已加载的 dsh-web-service、onenat-workbuddy 和 workbuddy-mcp 技能。
预检确认了 AC3 的缺口：现有 helper 固定使用提示词里的 `--base`，一次长回合内端口变化后不会刷新连接。前置 task-55、task-56 均已由原流程回写为 Done；我已保存开工基线。接下来会给 helper 加入稳定 mapping/app 引用，并让远程请求重新查询目录，同时保留离线、执行结果不确定和清理失败的明确报错。
稳定引用通道已加入；每次 DSH 请求前都会重新查目录，连临时会话清理也会重新解析，避免操作中途端口变化后仍用旧地址。我还补了两个边界：旧会话会重新安装新版 helper；共享 app 模板不能让文件操作静默切换到另一台机器，注入时会固定到已解析的 mapping。接下来验证漂移、离线、目录失

### 2026-11-06T17:05:47Z 自动Done与真实验收不一致，撤回完成结论
原任务task-10560a65自动completed/Done，但最新live-acceptance.json子会话检查FAIL，AC仍0/3；真实主会话通过、17条清理记录成功不能替代子会话验收。恢复In Progress等待修复验证，不重复实现。
已停止顺序自动派发监控；需诊断子会话失败、补超大/损坏JSON专项测试并完成证据后才接受Done。

### 2026-11-06T17:42:53Z task-57 最终逐项验收通过

三项 AC 已据完整证据勾选；状态暂保留 In Progress，供原宿主正常终态流程自动回写，未人工将 task-10560a65 设成功，也没有递归消息、第二个实现任务或后续条目派发。17:03 的中途自动成功记录及 17:05 撤回记录保留，不把它们当作本次最终证据。

（后续因果复核已收窄本段）原 child 归档首条 prompt 明确只读降级，但原会话上传回包未采集，不能唯一断言是编号导致。另一组独立实验实证 DSH 对同目录第二次 helper 上传加 `-1`，旧安装逻辑只认原名会复现同症状；该缺陷已修复，不将独立回包冒充原 session 证据。当前版本原名/编号名的绝对路径校验和缓存复用保留；最终升为 v3，主/子缓存的 v1、v2、编号 v2 下一轮升级一次。结果读取接入 32 MiB Content-Length/流式双重上限，坏 JSON/nonce/op/hash 拒绝；丢回包或超时只读回结果，不重放写入/exec；精确文件及会话清理覆盖 404 幂等、401 和目录离线失败。

最终真实 v3 测试于 2026-11-06T17:39:16.658Z 完成，4/4、exit 0。文件 owner=mapping:6cc2987d，executor=mapping:5602f2c2；无 @ 主会话与实际 retrySubtask 子会话各执行 list/read/write/stale-CAS/read/exec 六步。两路独立 HTTP 下载 txt/built 哈希全部匹配，cwd/产物在 owner，executor 上 owner 同路径明确不存在；主/子安装原名及编号 v3 的源码 SHA256 均为 6c561494101a81de7b50a82b9cb63eb38b351b27cb206edb9ec4e1720a31b4cc。

12 个临时操作会话与 2 个执行会话均有 DELETE 确认，2 个随机目录及 1 个新增 workspace 已删除，并记录精确路径 HTTP 400“目录不存在”；19 条 finally 清理记录均成功、无 cleanup error。DSH 归档历史可能仍可读，不宣称物理删除历史。此前 v2 真实 4/4 和 v3 父列表截断导致准备失败的报告均保留，最终验收不依赖中途输出。

本地 typecheck/build、unit218/218、远程专项25/25、执行节点集成8/8、项目双节点集成、smoke93/93、MCP28/28、ws-inject、orch-file、部署脚本语法与 diff 检查通过。真实离线 NODE_OFFLINE 有单独证据；公网漂移使用三入口 HTTP mock，每次请求重新解析，未人为重连线上隧道。既有 store 测试 fixture 警告/异步清理日志已在验收文档注明。

完整记录：[task-57 验收](../../docs/task-57-acceptance.md)、[最终真实报告](../../artifacts/task57/live-acceptance.json)、[最终证据摘要](../../artifacts/task57/final-live-summary.json)。现有 task-55/task-56 依赖和既有修改保留；未编辑 task-58 UI、commit/push 或部署正式服务。

### 2026-11-06T18:01:42.321Z 首次新子会话 runChatTurn 补充验收

按用户定位核对 getTask/mutateTask：当前 store 保留活对象并原地修改，普通首次 binding 在旧变量中可见；空 sessions、无附件/主会话的完整 runChatTurn 回归在未刷新 task 时已经通过。前轮另人为 upsertTask 替换对象并刷新 task，日志保留。按本次补充排除，该人工场景没有生产调用依据，现已撤回刷新和人工替换测试；保留正常 chat，换为公开 sendUserMessage 单 @ 经 planner→runSubtask 的回归，断言同一个存储对象、首个 binding、自动上传和编号 helper 的实际提示词。生产 engine 已恢复前轮基线，220/220 通过。

补充双真节点4/4、exit0（2026-11-06T17:57:03.033Z～18:01:42.321Z）：先完整 runChatTurn child、后无 @ main，owner6cc2987d/executor5602f2c2 实时目录解析；child sessionsBefore=[]、attachmentsBefore=0、无 DAG/主 binding。两路自动稳定 owner/helper 注入均true，各执行六步且 owner txt/built 独立下载哈希一致；child helper原名、后续main为v3-1，两者源码SHA256一致。14个会话、2个随机目录、1个新增workspace清理完成，19条finally无错误、6次精确缺失核验。

本轮typecheck/build、unit220/220、工具25/25、执行集成8/8、项目工作区集成、smoke93/93、ws-inject、orch-file通过。公开单@当前走规划器，该轮真机显式调用完整runChatTurn，仅保留作当时方法级证据，不证明现已撤回的刷新必要，不声称覆盖公开排队/activeJobs或真节点自然对象替换。范围与限制、初次错误路由尝试及历史红绿日志见[验收记录](../../docs/task-57-acceptance.md)、[chat完整报告](../../artifacts/task57/chat-live-acceptance.json)、[chat证据摘要](../../artifacts/task57/chat-live-summary.json)。只补原task-57，不改状态或任务依赖，不创建重复/后续实现任务，不人工设置原宿主终态；未编辑task-58 UI、commit/push或部署。

### 2026-11-06T18:22:15.842Z 排除旧快照与公开消息入口补验

已撤回task刷新及人工upsert替换测试，src/engine.ts SHA256精确恢复到旧假设前基线。新增公开sendUserMessage单@回归，不预置plan、不直接chat/retry/transformer，走planner→runSubtask并断言store同对象、首个binding、编号上传/实际prompt；正常首次完整chat回归保留，完整220/220通过。临时编译副本只改旧exact-name谓词，公开入口回归确实红灯；该隔离副本清理，不改源码或产物。

原归档session-01ddb29a-952e-47b3-b390-816bf1b39ca3只读取得43条历史，user seq9和原随机根匹配，明确只读降级，见[直接归档证据](../../artifacts/task57/causal-original-archive.json)。原上传回包未采集，无法唯一归因；独立编号实验是另外的root/session，已修复编号缺陷能解释原症状，不把它当原请求。

本次公开REST消息双真节点4/4、exit0，18:17:56.474Z～18:22:15.842Z，生产不刷新task。无附件/binding，文件API预放helper原名制造碰撞；单@经真实sendUserMessage→runOrchestrateTurn→runSubtask，LLM规划错误后用系统静态兜底、未手工预置DAG。child自动上传200返回v3-1、随后main返回v3-2，两路上传/下载helper哈希一致、同session归档首条prompt哈希等于发送值、稳定owner/helper均true且无降级；各六步、owner txt/built独立核验通过。16个会话、2个目录、1个workspace，21条清理记录无错误，6次精确缺失检查。见[公开报告](../../artifacts/task57/public-live-acceptance.json)与[摘要](../../artifacts/task57/public-live-summary.json)。

当前typecheck/build、unit220/220、串行工具25/25、smoke93/93、执行集成8/8、项目工作区、ws-inject、orch-file通过；工具首跑23/25短时限失败及隔离2/2/完整25/25复跑均保留，未放宽时限或改生产逻辑。原task状态与依赖保持，未重复派实现/后续待办、未改task58 UI、未人工回写宿主终态、commit/push或正式部署。

### 2026-11-06T18:38:48Z 既有范围收尾

按用户收尾指令只读核对既有最终v3报告：finishedAt=2026-11-06T17:39:16.658Z，main原名v3、child编号v3-1，4/4 PASS、19条清理无失败；不新增真实运行。三项AC均已勾选，AC3/3通过，验收文档已补明确最终结论。旧失败与证据边界保留，详见[收尾结论](../../docs/task-57-acceptance.md)。本条实施和验收范围完成，待原派发正常终态自动回写；未手改Done、人工设宿主成功、重复派发、提交/推送或部署。

### 2026-11-06T18:41:12Z 派发执行（成功）
任务 task-10560a65 · 结果=成功
**本任务已完成，AC 3/3 通过，必要清理已结束。**

- 最终 v3 真实验收 **4/4 PASS**，主会话原名 v3、子会话编号 v3 均验证通过，**19 条清理记录无失败**。
- 旧快照假设已排除，相关刷新改动已撤回；helper 编号兼容修复保留。
- 既有 UI mock **7/7**、live **5/5** 结果沿用；扩展 handler 与非必要扩展真实点击的验证局限保留。
- [验收文档](</Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/docs/task-57-acceptance.md>)已记录最终结论，旧失败和证据边界完整保留。

当前执行到此结束，交由宿主正常 `completed` 流程自动回写。未重新执行历史调查或重复完整真实测试，未新建或派发后续任务，未提交、推送或部署。
