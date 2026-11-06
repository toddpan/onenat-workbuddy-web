# task-57：远程文件访问与命令通道验收

验收日期：2026-11-07（Asia/Shanghai），机器报告采用 UTC。本文只记录现有 [task-57](../backlog/tasks/task-57%20-%20工作区解耦：远程文件访问与命令通道.md) 的复核、缺口修复与证据；前置 task-55、task-56 依赖保留。正式服务未部署，未 commit/push、创建第二个实现任务、派发后续待办或向原宿主 task-10560a65 递归发送消息。task-58 并行维护控制台，本轮没有编辑其 UI 源码或 UI 专项测试。

## 收尾结论

本次只读复核既有 [最终 v3 实测报告](../artifacts/task57/live-acceptance.json)：`finishedAt=2026-11-06T17:39:16.658Z`，**4/4 PASS**；main 安装 v3 原名、child 安装编号 v3-1，两者独立下载 SHA256 与源码一致；**19 条清理记录无失败**。该轮子派发入口为 `retrySubtask → runSubtask`，与后文 chat / 公开入口补充证据分别保留。

**task-57 验收结论：AC 3/3 通过，现有范围收尾。** 无 @ 主会话与子会话获得远程能力，目录/文本/写回/CAS 保持 owner 为事实源，命令在 owner 执行且稳定引用实时解析、错误明确。旧失败、原失败上传回包缺失、真实端口漂移未人为制造、归档历史可能保留等限制不变。不再增加无新失败驱动的完整真实运行；不提交、不推送、不部署。原派发终态由最终答复结束后的正常流程自动回写，未人工改成功或手改待办为 Done。

## 逐条验收

| AC | 当前证据 | 结论边界 |
| --- | --- | --- |
| #1 跨节点主会话无需 @ 自动获得能力，子智能体同样可用 | 公开 REST 无 @ main、公开单 @ child、完整方法级 chat、实际 retrySubtask 分别登记。最新公开入口在未刷新 task 下4/4，通过同session上传请求/编号回包、归档首条prompt、独立helper字节核验。 | 最新child公开消息链路实际用系统静态规划兜底，不声称LLM规划成功；原失败上传回包缺失，不唯一归因。旧版本升级由主/子单测验证，不混淆三种入口。 |
| #2 目录、文本、写回与冲突检测，文件保留在 owner | 主/子各执行 list、read、write、stale-CAS、read、exec 六步；写回后控制端通过 owner HTTP 独立下载 txt 和 built 文件核对 SHA256、内容与大写构建结果；旧版本写入返回 CAS_MISMATCH，最终内容不被覆盖。 | 通过。两路 txt 与 built 独立 HTTP 下载哈希匹配；executor 上 owner 同路径明确报不存在，陈旧 CAS 均拒绝，最终内容不被覆盖。 |
| #3 命令在 owner 执行、缺能力/离线报错、实时 ONENAT | 远程 Node 构建命令返回 owner cwd/hostname，控制端独立读回产物；每次 DSH 请求均实时解析 `/api/v1/resources`。三端口 mock 覆盖创建、上传、prompt、结果下载及清理；真实目录离线拒绝有单独报告。 | 通过。真实 exec 的 cwd/产物在 owner，真实离线明确拒绝。漂移由受控 HTTP mock 验证，未人为重连线上隧道；能力拒绝、丢回包、超限及错误信封由 worker + mock HTTP 测试验证。 |

## 本轮修复

- [远程 helper](../scripts/workspace-remote.mjs) 接受稳定 mapping 或唯一 app 引用，在每次 DSH HTTP 请求前重新解析目录；一次操作固定 mapping 身份，拒绝 app 歧义或实体迁移，不回退旧公网地址。显式 direct 继续使用互斥的 `--base`，没有 ONENAT 漂移能力。
- worker 通过会话文件 API 上传真实字节，模型可检查脚本并执行短命令。结果 JSON 由 helper 经 HTTP 直接下载并校验 nonce、operation、requestHash，结果标记 `http-read-worker-result`。prompt 已发出但超时/丢回包时只读回本次结果；没有有效结果返回 OUTCOME_UNCERTAIN，不透明重放 write/exec。
- 结果下载接入 `readResult`，同时检查 Content-Length 和实际流式字节数，最大 32 MiB。损坏 JSON、错误 nonce/op/hash、头部或流式超限均失败。读/CAS 输入仍最多 8 MiB，exec stdout/stderr 合计最多 4 MiB。
- [安装与上下文](../src/workspace-access.ts) 和 [引擎](../src/engine.ts) 保持文件 owner、接收会话实际稳定身份与目录凭证相互独立。v3 basename 使存量 v1、v2、编号 v2 在下一轮重新安装；当前 v3 的编号副本可复用。标准发布资源包含 helper；仅检查打包逻辑和脚本语法，未部署。
- 精确清理 worker、结果 JSON、`.tmp` 和临时会话；404 视为已经清理，401/403、目录不可达和 DELETE 失败明确报告。文件路径边界、协作锁、SHA256 CAS、原子替换继续由 owner worker 执行。

## 原失败证据与独立编号缺陷复现

上一轮六步操作均成功，但子会话自动注入实际失败。原 [失败报告](../artifacts/task57/continuation-baseline/live-child-injection-failed.json) 和 [日志](../artifacts/task57/continuation-baseline/live-child-injection-failed.log) 保留：`session-01ddb29a-952e-47b3-b390-816bf1b39ca3` 对应 `workspaceSection=true`、`stableOwner=false`。归档首条提示词的 [脱敏摘录](../artifacts/task57/failed-child-initial-prompt.json)（user seq9、原随机根 `37e2ba6368bb09f1`）明确包含“远程操作工具未能安装，仅提供 HTTP 读取”。摘录文件没有单独记录 sessionId/history URL，不能仅凭该文件声称完整会话 provenance；须与原报告关联。旧 `helperV2` 标志仅匹配原文件名，有效 `v2-1` 也会 false，不能单独据它判断缺失 helper。六步产物成功不能替代自动注入断言，也不能从仅有工具名的记录重建模型后续怎样补救。

本次又通过实时目录和授权凭证只读取得该原归档 session 的历史，见 [原会话直接关联证据](../artifacts/task57/causal-original-archive.json)：明确保存 sessionId、history 请求路径、43 条消息、user seq9、原根路径、提示词 SHA256 和脱敏工作区段。再次确认只读降级，且没有向原会话发 prompt、上传或重放。这补齐提示词与原 session 的直接关联，未补出缺失的旧上传回包。

**原失败会话的 helper 上传 HTTP 请求/回包没有采集。** [当时脚本](../artifacts/task57/continuation-baseline/scripts__project-workspace-live.mjs) 只观察建会话和 prompt，没有 `/sessions/:id/files` 回包字段。因此原会话的读 helper 异常、上传失败、空 files、解析失败等路径仍无法唯一排除；撤回此前“根因已确证为编号、并非采集遗漏”的过度表述。

真实 [上传重名复现](../artifacts/task57/helper-upload-collision.json) 是另一轮独立实验：`2026-11-06T17:15:15.734Z`、随机根 `f5dfde45cf59e54c`、另两个会话直接调用 `DshClient.uploadFiles`；第一次得到 `.workbuddy-workspace-remote-v2.mjs`，第二次 DSH 返回 `.workbuddy-workspace-remote-v2-1.mjs`。[旧安装函数](../artifacts/task57/continuation-baseline/src__workspace-access.ts) 仅接受原名，收到该编号回包时确定会返回 undefined，随后产生同样的只读降级。这个编号兼容缺陷有明确代码因果和独立实测，能解释原症状；它不是原失败 session 的上传回包，不能据此断言原 session 的唯一根因。现校验同版本原名或正整数编号、绝对路径及 name/path 一致性。

原失败脚本实际使用 `retrySubtask → runSubtask → transformFileMentionsForAgent → buildWorkspaceAccessSection`：先无 @ main，再草稿 child 中预置单项 DAG 并 retry；不是公开单 @ 或首次 `runChatTurn`。隔离服务从构建后的 `dist/server.js` 导入该链路，没有另一个旧 `runChild` 注入实现。此前 [217/218 红灯日志](../artifacts/task57/child-injection-red.log) 覆盖真实 retry 方法、HTTP stub 下的编号响应，第二轮复用编号 helper 的回归保留。公开消息入口新增回归与真节点证据在下文单独登记。

复核进一步发现沿用 v2 名称会让已有会话跳过本次有界结果读取修复，因此最终采用 v3，并覆盖主/子缓存的 v1、v2、编号 v2 升级。新建会话的成功结果不替代这一存量会话回归。

## 补充：首次新子会话 `runChatTurn` 与对象替换

用户指出 `runChatTurn` 在 `ensureSession` 前取得 task，随后仍把原引用传给 transformer，而安装 helper 读取 `task.sessions[targetAgent.id]`。核对 [WorkStore](../src/store.ts) 后，当前 `getTask` 返回存储对象本身、`mutateTask` 原地修改，异步落盘只序列化数据，不替换任务。因此，仅凭这三处行号不能认定“mutateTask 换对象”是此前真实失败原因；此前共享目录编号上传的独立证据仍成立。

新增 [完整入口回归](../src/engine.test.ts) 直接运行 `runChatTurn`：空 sessions、无附件、无主 binding，由真实 `ensureSession` 创建首个 child binding，随后核对实际 `streamPrompt` 的 helper、稳定 owner、独立目录凭证及第二轮只上传一次。未加 task 刷新时此用例已经通过，确认当前原地修改语义下首轮可见。

前轮第二个用例在 `createSession` 异步边界人为调用 `store.upsertTask(structuredClone(currentTask))`，制造新旧对象身份分离，随后用刷新 task 修复这个人为场景。[当时红灯](../artifacts/task57/chat-runChatTurn-red.log)、[绿灯](../artifacts/task57/chat-unit-green.log)、[曾用增量](../artifacts/task57/chat-production-review.patch) 和 [当时范围](../artifacts/task57/chat-scope-review.json) 仅作为历史保留。用户补充排除后确认：唯一生产 `upsertTask` 调用是创建任务，未找到建会话期间自然对象替换依据；因此**已撤回刷新 task 生产改动，并删除人为替换用例**。当前 `runChatTurn` 恢复传原 task，没有改 store 语义。

替代用例从公开 `sendUserMessage('@child …')` 发起：初始 sessions 为空、附件为 0，不预置 DAG、不直接调用 chat/transformer/retry；planner stub 仅确定计划内容，实际公开路由和 `runOrchestrateTurn → executeDag → launchSubtask → runSubtask` 负责建 binding/上传/注入/派发。模拟 DSH 返回当前版本 `v3-1`，断言同一 child session 收到上传、实际 prompt 带编号 helper/稳定 owner、store 原对象身份不变。正常完整 chat 回归继续保留。

为确认新回归能识别已证实编号缺陷，在临时隔离的编译副本中只把安装谓词换为旧 exact-name，见 [唯一变更](../artifacts/task57/causal-numbered-red-mutation.patch)：公开入口回归 [失败](../artifacts/task57/causal-public-red.log)，绑定 helper 变成 undefined；源码与正常构建没有被改坏，临时副本已清理。当前未刷新 task 的 [完整单测 220/220](../artifacts/task57/causal-unit.log) 同时覆盖正常 chat 与公开单 @ 两入口；[类型检查](../artifacts/task57/causal-typecheck.log)、[构建](../artifacts/task57/causal-build.log) 通过。

本次 [远程工具首跑](../artifacts/task57/causal-workspace-tools.log) 为 23/25，两个短时限用例在 worker 结果生成前超时；[隔离复核](../artifacts/task57/causal-timing-isolated.log) 和 [串行完整 25/25](../artifacts/task57/causal-workspace-tools-rerun.log) 均通过，未修改生产代码或时限。[smoke 93/93](../artifacts/task57/causal-smoke.log) 通过。撤回后重新执行的[执行集成8/8](../artifacts/task57/causal-project-execution.log)、[项目工作区](../artifacts/task57/causal-project-workspace.log)、[ws-inject](../artifacts/task57/causal-ws-inject.log)、[orch-file](../artifacts/task57/causal-orch-file.log) 均退出0；前轮日志另保留为当时结果。既有 MaxListeners 与旧 fixture 异步 rename ENOENT 日志保留，没有改通用 store。

首轮曾尝试用 `sendUserMessage('@child …')` 作入口，但当前路由在单个 @ 时进入规划器，得到 DAG 和 `success`，不是 `runChatTurn`。保留 [初次误判日志](../artifacts/task57/chat-first-baseline.log) 与 [路由识别日志](../artifacts/task57/chat-snapshot-red.log)，不将它们作为 chat 回归证据。最终单测及真节点脚本显式调用完整 `runChatTurn`，保留真实建会话、权限、安装、组装提示词与派发；不 mock 路由来伪装公开 @ 接口覆盖。既有 `retrySubtask → runSubtask` 证据独立保留。

补充真节点脚本使用 `WORKBUDDY_LIVE_CHILD_ROUTE=chat` 选择本入口，缺省 `dag` 仍保留前轮验收方式。chat 分支先建隔离 draft，断言 sessions 为空、附件为 0、此前 helper 上传为 0，先跑子会话，再运行原有无 @ 主会话；实际 `runChatTurn` 自己完成 ensureSession 和 helper 安装，没有预安装 helper、手工拼装注入段或伪造派发成功。测试驱动脚本通过 owner/executor 文件 API 准备 fixture，不登记为任务附件或创建 binding。

### 首次 chat 双真节点最终结果

[完整报告](../artifacts/task57/chat-live-acceptance.json)、[日志](../artifacts/task57/chat-live-acceptance.log) 与 [精简证据](../artifacts/task57/chat-live-summary.json) 已完成：**4/4，通过且进程退出 0**，开始 `2026-11-06T17:57:03.033Z`、结束 `2026-11-06T18:01:42.321Z`（北京时间 2026-11-07 01:57:03～02:01:42）。仍使用授权 owner `mapping:6cc2987d` 与 executor `mapping:5602f2c2`，每次通过目录解析；没有改正式服务。

首个执行者是 child，报告 `sessionsBefore=[]`、`attachmentsBefore=0`、`planPresent=false`，之后仅出现该 child binding，无 `__node__`。该 session 确实上传当前 helper 并收到带稳定 owner 的 prompt，随后完成 list/read/write/stale-CAS/read/exec 六步，控制端独立从 owner 下载 txt/built 核对哈希。之后无 @ 主会话也通过同样六步；两路 `workspaceSection/stableOwner/helperCurrent` 全为 true。

| lane（顺序） | 实际执行会话 | helper 文件名 | 独立 owner txt SHA256 | 独立 built SHA256 |
| --- | --- | --- | --- | --- |
| child（先） | `session-021b3146-02f9-4880-8f94-f6601485de63` | `.workbuddy-workspace-remote-v3.mjs` | `44ac772d8cc30d029e2c639e9f2f44290254ef97b4073d647e3686954623fd67` | `9806eefff86513f9f97387ac2c40ea3cf64903041a38cea7790a1dba948a9f90` |
| main（后） | `session-6e23da5c-6a95-48ea-94d0-637d56be69c0` | `.workbuddy-workspace-remote-v3-1.mjs` | `6d3014949df58cff04611a05ed727449eba4bf666c6cdcd704eef99217869aa6` | `dcc50fe31f8bb56e10ba36a022a371e72ff3647f544046203ff209d78a0a3e39` |

两份 helper 均为 31158 字节、独立下载 SHA256 均等于源码 `6c561494101a81de7b50a82b9cb63eb38b351b27cb206edb9ec4e1720a31b4cc`。exec cwd 均为 `/tmp/wb-task57-0aefdfe258846542-owner`，executor 无 owner 同路径。finally 的 19 条清理记录无错误：12 个操作会话和 2 个执行会话收到 DELETE 确认，2 个随机目录及 1 个新增 workspace 已删除；6 次精确路径缺失检查仅接受包含目标路径的明确 HTTP 缺失错误。归档历史仍可能保留。

复验命令（不含凭证，凭证由目录配置读取）：

```sh
WORKBUDDY_LIVE_ACCEPTANCE=1 WORKBUDDY_FILE_NODE=6cc2987d \
  WORKBUDDY_EXECUTION_NODE=5602f2c2 WORKBUDDY_LIVE_CHILD_ROUTE=chat \
  WORKBUDDY_LIVE_REPORT=artifacts/task57/chat-live-acceptance.json \
  node scripts/project-workspace-live.mjs
```

[当时只读复核](../artifacts/task57/chat-readonly-review.json) 记录的是前轮状态。覆盖边界：该轮仅证明完整方法级 `runChatTurn` 的首次 child 行为，没有覆盖公开消息路由；运行时曾包含现已撤回的 task 刷新，因此此 4/4 不用来证明刷新必要，也不冒充当前撤回后的公开入口结果。人工 upsert 场景不再作为生产修复依据。

## 排除旧快照后的公开消息入口复验

[公开入口完整报告](../artifacts/task57/public-live-acceptance.json)、[日志](../artifacts/task57/public-live-acceptance.log) 和 [摘要](../artifacts/task57/public-live-summary.json)：**4/4，进程退出 0**，`2026-11-06T18:17:56.474Z～18:22:15.842Z`（北京时间 2026-11-07 02:17:56～02:22:15）。运行的生产 engine 已撤回 task 刷新，SHA256 精确等于前轮原基线 `29d3bc55a9d82e2255b91af1f9431482cdebb5367bee89d72ac05fc2dc659951`。

先通过文件 API 放置一份原名 helper，制造共享 cwd 的重名条件；这份 fixture 不是任务附件，没有创建会话/binding。随后 child 草稿 `sessionsBefore=[]`、`attachmentsBefore=0`，用真实 REST `POST /tasks/:id/messages` 单 @ 发起，未手工调用 transformer/chat/retry 或预置 plan；实际经过 `sendUserMessage → runOrchestrateTurn → runSubtask`。**该轮 LLM 规划返回错误、对账无正文，公开链路使用系统静态兜底计划**；这是实际路由验证，不声称 LLM 规划成功。最终仅一个 child 子任务、无 task main binding。main 无 @ 对照在 child 之后执行。

本轮把同一 session 的四类直接证据关联，补上旧采集方式的缺口：

| lane | 实际 session | 上传 HTTP 200 返回文件名 | 原始上传字节 / 下载 helper SHA256 | 归档首个 user prompt SHA256（等于发送观测值） |
| --- | --- | --- | --- | --- |
| child | `session-61071d93-16b2-4977-8b61-1251ff3bf81d` | `.workbuddy-workspace-remote-v3-1.mjs` | `6c561494101a81de7b50a82b9cb63eb38b351b27cb206edb9ec4e1720a31b4cc` | `cebaf779f493f21b41957af9b59928850a1d6d1a6a9dfa80b803013e7a87adef` |
| main | `session-d00a74f6-92d9-4e79-8399-b0daa0f6316b` | `.workbuddy-workspace-remote-v3-2.mjs` | `6c561494101a81de7b50a82b9cb63eb38b351b27cb206edb9ec4e1720a31b4cc` | `ca2a8fdde86282ef9c425fc790f806b87a2a89cc6158fd1ada0bf834b319b988` |

两次请求上传名均为原名，响应各返回编号名，安装后独立下载源码字节一致；历史 user seq9 的 `workspaceSection/stableOwner/helperCurrent=true`、`readOnlyFallback=false`，原始 prompt 和凭证不落报告。child / main 的 owner txt 哈希分别为 `a0e972dec0752de1cf10091b3bbac902ac72b2a85c5b0fd4a6c884c8515fd164` / `523398b554d20d6be86567c709ff35d12b3a5c68b81ffbfc85804bf85a8425d3`，built 为 `69096af5632ffd06c4cd1da4a11b00e2414423472d99ce789a6c72ccc6b27aad` / `00d847be03de49b1c6f3cffd87774ab9e5f621ec0d2e4ea4958d48a91192a058`；控制端独立 HTTP 下载核验内容与哈希，两路 exec cwd 在 owner，陈旧 CAS 被拒绝。

finally 共21条记录无错误：12个操作会话、2个执行会话、规划/汇总2个额外会话均收到 DELETE 确认，2个随机目录及1个新增workspace已清理，6次精确路径缺失检查通过。规划/汇总会话由响应中真实 sessionId 纳入清理，不依赖 task binding；不删除运行前已存在的会话。DSH 归档历史可能仍可读。

```sh
WORKBUDDY_LIVE_ACCEPTANCE=1 WORKBUDDY_FILE_NODE=6cc2987d \
  WORKBUDDY_EXECUTION_NODE=5602f2c2 WORKBUDDY_LIVE_CHILD_ROUTE=public \
  WORKBUDDY_LIVE_REPORT=artifacts/task57/public-live-acceptance.json \
  node scripts/project-workspace-live.mjs
```

结论区分：原归档降级属实；原上传回包缺失，原会话唯一根因仍不能确证；编号兼容缺陷由独立真机回包、旧谓词公开入口红灯和当前逻辑公开真机绿灯证实。当前实现不需要靠刷新 task 通过这些验证。

## 本地检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | 当前撤回后通过 | [类型检查](../artifacts/task57/causal-typecheck.log) |
| `npm run build` | 当前撤回后通过，含嵌入页面脚本语法关卡 | [构建](../artifacts/task57/causal-build.log) |
| `npm run test:unit` | 当前未刷新 task：220/220，正常 chat + 公开单 @；前轮218/218保留 | [当前单测](../artifacts/task57/causal-unit.log)、[前轮单测](../artifacts/task57/unit-final.log) |
| `node --test --test-concurrency=1 scripts/workspace-remote-test.mjs scripts/workspace-access-test.mjs` | 当前25/25；默认并发首跑23/25短时限失败另保留 | [当前远程专项](../artifacts/task57/causal-workspace-tools-rerun.log)、[首跑](../artifacts/task57/causal-workspace-tools.log) |
| `node scripts/project-execution-e2e.mjs` | 当前8/8 组 | [执行节点集成](../artifacts/task57/causal-project-execution.log) |
| `node scripts/project-workspace-e2e.mjs` | 当前通过 | [项目双节点集成](../artifacts/task57/causal-project-workspace.log) |
| `npm run smoke` | 当前93/93 | [独立 smoke](../artifacts/task57/causal-smoke.log) |
| `npm run smoke:mcp` | 28/28 | [MCP smoke](../artifacts/task57/mcp-final.log) |
| `npm run smoke:ws-inject` | 当前三场景通过 | [工作区注入](../artifacts/task57/causal-ws-inject.log) |
| `npm run smoke:orch-file` | 当前通过 | [编排文件传递](../artifacts/task57/causal-orch-file.log) |
| `bash -n scripts/deploy-standalone.sh` | 通过，仅语法检查 | 未运行部署脚本 |
| `git diff --check` | 通过 | [空白检查](../artifacts/task57/diff-check.log) |

专项包括：真实 worker 文件边界和 symlink 拒绝、读/命令预算、CAS 并发只有一个赢家、锁和命令超时、写后丢回包不重放、prompt 超时但有效结果已生成可读回、坏 JSON/nonce/op/digest 拒绝、头部/无长度头流式超限、结果 `.tmp` 清理、404 幂等及 401 清理失败、实时目录三端口漂移、app 歧义与离线拒绝。超限/坏 JSON 修复前 [红灯日志](../artifacts/task57/result-limits-red.log) 保留，未改写为成功。

单测存在既有的 process exit listener MaxListeners 警告；此前218项那轮另有 store fixture 异步 rename 在临时目录清理后报 ENOENT，断言及进程退出均通过，当前220项结果单独保留。这些 fixture 生命周期日志不属于远端 helper 清理证据；本轮没有修改通用 store 生命周期。

## 真实节点与清理

真实测试仅使用授权目录中的文件节点 `mapping:6cc2987d`（KB136）与执行节点 `mapping:5602f2c2`（brain）。主/子模型经两侧模型目录校验为 `deepseek-official/deepseek-v4-flash`；owner 的 helper 临时会话保持其默认模型，没有调整正式节点的权限或全局模型。

第一轮编号修复成功报告为 [4/4 v2 实测](../artifacts/task57/live-acceptance-v2-numbered-pass.json)，完成于 `2026-11-06T17:28:57.783Z`：主、子都注入稳定 owner，第二个 helper 的实际路径带 `-1`，两个安装文件独立 SHA256 都等于当时源码，12 个临时操作会话和两个执行会话均经 DELETE，两个临时目录及一个新增 workspace 清理成功。该证据针对当时的 v2 文件名，最终 v3 结果单独记录。

v3 首次复验在准备阶段失败：验收脚本要求 `/tmp` 父列表完整，但 executor 上列表截断；没有派发主、子操作。保留 [报告](../artifacts/task57/live-v3-parent-truncated.json) 和 [日志](../artifacts/task57/live-v3-parent-truncated.log)。两侧删除接口均确认成功，后续 [精确路径检查](../artifacts/task57/missing-path-status.json) 均为 HTTP 400 且明确“目录不存在”。最终脚本改为仅接受包含精确随机路径的 DSH 缺失错误，不接受鉴权、网络错误或被截断父列表作为不存在证据。

最终 v3 真实验收 **4/4 通过，进程退出 0**。开始 `2026-11-06T17:34:53.359Z`，结束 `2026-11-06T17:39:16.658Z`（北京时间 2026-11-07 01:34:53～01:39:16）。[完整报告](../artifacts/task57/live-acceptance.json)、[日志](../artifacts/task57/live-acceptance.log)、[精简证据](../artifacts/task57/final-live-summary.json) 均保留。随机 tag 为 `wb-task57-6b1e0ce4ab4dc544`；owner/executor 隔离根目录分别使用该 tag 加 `-owner`、`-executor`。

| lane | 实际执行会话 | helper 安装文件名 | 独立 owner txt SHA256 | 独立 built SHA256 |
| --- | --- | --- | --- | --- |
| main | `session-c822f7bb-94ae-48cd-b3e8-ed0d4fc2f119` | `.workbuddy-workspace-remote-v3.mjs` | `864fe4b499004ead67b50a9475671f8a5d193aaa190300227ec0c642a646d78e` | `0f6e4d2eaf016379acd975c895a4397dd8d5889fda7ab6f154f3c821a78f81b5` |
| child | `session-46298a72-6a0c-45ff-9c2e-034da48e8102` | `.workbuddy-workspace-remote-v3-1.mjs` | `93b433f64d21d3ab5a5e34dc478c46ae2a186f4a8e0868b35287a993e3fbfece` | `c199d37b834a56c2d6fc37cb13dbf191f0c260f207654a658a30bee546afc227` |

两份 helper 均从 executor 安装位置独立下载，31158 字节，SHA256 均为 `6c561494101a81de7b50a82b9cb63eb38b351b27cb206edb9ec4e1720a31b4cc`，与本地 helper 源码一致。两路发出 prompt 的 `workspaceSection/stableOwner/helperCurrent` 全为 true，且都有实际命令工具事件。主/子操作产生 12 个不同临时会话，全部返回 DELETE 确认；owner 中只保留本次 txt/built 产物，没有 worker/result/锁残留。

finally 再次精确清理本轮 12 个 helper 会话与 2 个执行会话（DSH 归档语义）、2 个随机根目录、1 个新增 workspace 及本地隔离服务数据；报告 19 条清理记录均成功（其中 2 条为明确缺失验证），无 cleanup error。两个目录删除后均通过 `/fs/list` 返回 HTTP 400 且包含精确路径及“目录不存在”，不是将鉴权/网络失败视为不存在。最终报告保留了 6 次精确缺失核验，覆盖操作前后 executor 无 owner 同路径及 finally 的两侧清理。

[真实离线拒绝](../artifacts/task57/offline-live.json) 验证授权目录中 `6be407b8` 离线，返回 NODE_OFFLINE，没有向离线 DSH 发请求。公网端口漂移测试使用三个真实本地 HTTP 入口、共享 session 身份与变化目录，每个请求都重新解析；两个连续操作共 16 次目录请求，包含下载和三种临时文件清理及会话删除。未用真实隧道重连制造漂移。

## 改动保留与限制

开工前 [tracked 基线](../artifacts/task57/baseline/tracked.patch) 与 [续作基线](../artifacts/task57/continuation-baseline/tracked.patch) 均保留；最终范围核对随 [增量复核](../artifacts/task57/incremental-review.patch) 和 [续作复核](../artifacts/task57/continuation-review.patch) 保存。既有修改不回退，task-58 的并行 UI 变化单独识别；UI 专项测试未被本轮修改。

owner 是受信任节点；`http-read-worker-result` 与独立文件/哈希核验提供运行证据，不是密码学执行证明。DSH DELETE 可能保留归档历史，不声称聊天记录物理抹除。协作锁只协调此 helper，不能阻止编辑器或终端绕过锁；任意授权命令仍有 owner DSH 账号自身权限，路径 guards 不等于操作系统沙箱。

本轮真实 exec 是 Node 文件构建与 cwd 核对，未实际执行 Git 提交、推送、正式项目构建或部署；未试遍所有节点/模型，也未追加控制台浏览器验收。原宿主的终态应在上述最终验收全部完成后由正常流程自动回写，未通过工具人工设成功。
