# task-56：项目任务选择任意执行节点验收

验证日期：2026-11-06；真实双节点复验报告时间为 `2026-11-06T15:47:23Z`（北京时间 23:47:23），最终本地回归在该轮之后执行。

本轮仅补齐和验收 [task-56](../backlog/tasks/task-56%20-%20工作区解耦：项目任务选择任意执行节点.md)，沿用已有实现。前置 [task-55](../backlog/tasks/task-55%20-%20工作区解耦：统一身份与项目唯一性.md) 已由原流程回写为 Done；依赖继续保留。未 commit/push、部署正式服务、派发后续 backlog、创建第二个实现任务或向原宿主任务递归发送消息。真实测试使用随机端口的隔离 WorkBuddy 实例及临时远端文件；正式 WorkBuddy 配置未改动。

## 逐条结果

| AC | 结果 | 实际证据 |
| --- | --- | --- |
| #1 项目默认执行节点与文件归属节点独立保存 | 通过 | REST PATCH/PUT 与 MCP 项目更新可只传默认节点；省略保留、null 清除、重启后仍保持独立。逐字段核对文件 `dshRef`、根目录、归属凭证与默认执行引用。文件路由始终到归属节点，执行节点鉴权不使用归属节点密钥。见 [8 组执行集成日志](../artifacts/task56/project-execution.log)。 |
| #2 支持 projectId + nodeRef；旧任务不随默认节点修改迁移 | 通过 | REST 与实际 MCP HTTP 协议接受 mapping/app/direct 显式引用，显式覆盖与默认快照均持久化；@项目首次绑定也快照。精确和首句近似去重按项目及执行节点区分。修改默认值及模拟公网端口漂移后旧任务仍保持稳定引用及原远端会话；进程重启保持已保存任务的执行节点快照。旧无 nodeRef 的任务继续使用文件节点；同项目默认 fork 继承这个有效节点。真实两节点测试进一步验证旧会话复用和新任务采用新默认。 |
| #3 主会话与子智能体不把远程项目路径作为本地 cwd | 通过 | 单测及 HTTP 集成检查实际规划/主会话/子会话的创建载荷，异机不发送归属 cwd/workspaceId，也不在异机 mkdir 归属路径。子智能体保留其自身目录；回退其他节点时不沿用原子智能体目录。真实 DSH 会话查询确认主、子会话 cwd 均为执行节点临时目录，并从文件节点 HTTP 读回随机文件及正确哈希；执行节点上归属路径在前后都不存在。见 [真实复验报告](../artifacts/task56/live-acceptance.json)。 |

这里的“任意节点”指通过现有目录/鉴权可访问的 DSH 节点。离线选定节点在主会话路径上明确失败，不改投文件节点或补建同路径目录；mock 集成包含这一拒绝断言。已有编排规划器的可用成员节点回退机制保留，回退时不携带不属于接收节点的 cwd。

## 本轮修复

- [engine.ts](../src/engine.ts)：@项目首次绑定快照执行节点；规划前只有目录归属与目标节点身份相符时才 mkdir/传 plannerCwd；同项目 fork 继承原任务有效节点，兼容旧任务没有 nodeRef 的情况。
- [tool-ops.ts](../src/tool-ops.ts)：工具创建通过统一校验支持 mapping/app/direct，拒绝无效引用；按有效执行节点及项目计算精确/近似去重，防止同一项目换节点后错误复用旧任务；工具参数说明补齐默认快照规则。
- [router.ts](../src/router.ts) 与上述工具：更新已有项目时省略 name 可沿用原名称，因此只修改/清除默认执行节点无需重传项目其他配置。
- [engine.test.ts](../src/engine.test.ts)、[tool-ops.test.ts](../src/tool-ops.test.ts)：增加 5 项 task-56 回归；保留既有显式/默认快照、稳定身份、凭证隔离和文件访问测试。
- [执行节点集成脚本](../scripts/project-execution-e2e.mjs)：临时持久化目录、动态端口、真实 HTTP/MCP、mock ONENAT 及两个 DSH 身份，覆盖 8 组跨层行为。
- [真实节点验收脚本](../scripts/project-execution-live.mjs)：需显式 `WORKBUDDY_LIVE_ACCEPTANCE=1`，仅使用实时目录解析映射，不固定公网端口；凭据从已有授权读取，不写入报告。

已将开工前 tracked diff 保存为 [基线补丁](../artifacts/task56/baseline.patch)，并与最终 tracked diff 比较。除上述 5 个源/测试文件外，其他 21 个原有 tracked 修改保持原样；本轮源代码增量单独保存在 [增量补丁](../artifacts/task56/incremental.patch)。原有 untracked 实现、文档与其他 backlog 继续保留。

## 实际执行的检查

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | [类型检查日志](../artifacts/task56/typecheck-final.log) |
| `npm run build` | 通过，含嵌入页面脚本检查 | [构建日志](../artifacts/task56/build-final.log) |
| `npm run test:unit` | 216/216，0 失败 | [最终单测日志](../artifacts/task56/unit-final.log) |
| `node scripts/project-execution-e2e.mjs` | 8/8 组 | [执行集成日志](../artifacts/task56/project-execution.log) |
| `node scripts/project-identity-e2e.mjs` | 10/10 组，task-55 回归 | [身份权限集成日志](../artifacts/task56/project-identity.log) |
| `npm run smoke` | 93/93 | [smoke 日志](../artifacts/task56/smoke.log) |
| `npm run smoke:mcp` | 28/28 | [MCP smoke 日志](../artifacts/task56/mcp.log) |
| `node scripts/project-workspace-e2e.mjs` | 通过 | [既有项目双节点日志](../artifacts/task56/project-workspace.log) |
| `node --test scripts/workspace-remote-test.mjs scripts/workspace-access-test.mjs` | 12/12 | [远程工具和提示词日志](../artifacts/task56/workspace-tools.log) |
| `node scripts/project-node-ui-test.mjs` | 19 条检查通过 | [UI 函数专项日志](../artifacts/task56/ui-focused.log) |
| `npm run smoke:ws-inject` | 通过，3 个场景 | [工作区注入日志](../artifacts/task56/ws-inject.log) |
| `npm run smoke:orch-file` | 通过 | [编排文件传递日志](../artifacts/task56/orch-file.log) |
| `WORKBUDDY_LIVE_ACCEPTANCE=1 node scripts/project-execution-live.mjs` | 4/4，退出码 0 | [真实节点日志](../artifacts/task56/live-acceptance.log)、[结构化报告](../artifacts/task56/live-acceptance.json) |
| `git diff --check` | 通过 | [空白检查日志](../artifacts/task56/diff-check.log) |

最终主回归任务为 `bash-2d981033eba245e9`，退出码 0；真实复验任务为 `bash-6a7235ce91a340bd`，退出码 0。单测仍有既有 `MaxListenersExceededWarning`：fixture 多次创建 store 注册 process exit listener，本轮未扩展范围修改该生命周期。

执行集成 8 组覆盖：独立字段保存/清除、任务创建及旧任务 fork 快照、MCP 节点引用/去重、磁盘重启、主会话目录/文件路由/凭证、稳定映射端口漂移及原会话复用、实际规划和子会话载荷、离线失败无迁移。

## 真实 ONENAT 双节点证据

每次调用从实时目录和授权凭据解析以下稳定 mapping：

| 角色 | ONENAT 节点 | 本轮用途 |
| --- | --- | --- |
| 文件归属 | `6cc2987d`，KB 136 环境 | `/tmp/wb-task56-6858a76996b96c4a-owner` 中只放随机 marker 文件。 |
| 执行 | `5602f2c2`，brain 环境 | 主、子会话在 `/tmp/wb-task56-6858a76996b96c4a-executor` 运行。 |

合法模型目录校验后使用 `deepseek-official` / `deepseek-v4-flash`。主会话通过 WorkBuddy REST 项目任务入口发起，`projectId + nodeRef` 生效，实际 DSH 会话为 `session-60b98ae4-d8d9-4c07-ab57-ab3a43d329f6`。远端查询 cwd 与执行目录一致；接收到了真实 bash 工具调用事件。模型通过文件节点 HTTP 下载得到的随机 marker 与本地独立上传内容一致，SHA256 为 `ae95efedf9b50f9a3fb3bf5c683bd8c973d5aa70608f9cfca9e0e0a6a0e4800f`；该随机内容和哈希没有预先包含在执行提示词中。

更新项目默认节点到文件节点后，旧任务 `task-153c096c` 再次运行仍复用相同远端会话、仍绑定 brain；新草稿任务 `task-57ce791c` 则快照 KB 136 为执行节点。文件浏览仍从 KB 136 读取 marker。

子会话使用隔离实例中的确定性单项计划，通过实际 retry 路由及 `runSubtask` 派工，避免再下发实现任务或依赖 LLM 规划。子会话 `session-c50dbb88-5874-4e59-8742-5915659c1f2c` 的远端 API cwd 与自身 workDir 一致，输出正确的随机 marker 和同一 SHA256。本轮没有声称真实 LLM 拆解链路已全程验收；规划会话 cwd 的行为由实际 HTTP mock 和单测覆盖。

真实报告保存会话创建载荷、远端 cwd、工具事件摘要、模型回复、随机内容哈希和清理结果；API key 未入日志。两轮结束均删除本轮远端会话、两个临时目录和新增 workspace；隔离本地服务停止，临时数据目录删除。

## 失败记录与复验

1. 开工基线为 211/211；新增第一批回归后曾为 212/215。@项目未快照和跨节点工具去重被复现；规划用例最初错误断言 `completed`，实际编排终态为 `success`，当时未运行到 cwd 断言，不能把该次失败当作 cwd 缺陷执行证据。修复后第一批为 215/215。原始 [失败日志](../artifacts/task56/unit-regression-before.log) 保留。
2. 新增 HTTP 集成首次在只传 `defaultExecutionNodeRef:null` 的 PUT 返回 400，原因为项目更新仍要求 name；MCP 部分更新也存在相同约束。补齐既有名称回退、重新 build 后，8 组全部通过。
3. 旧无 nodeRef 的默认 fork 新增回归先失败（215/216），修复为继承原有效节点后最终 216/216，HTTP 同时验证原任务记录不迁移。见 [fork 修复前日志](../artifacts/task56/unit-legacy-fork-before.log)。
4. 真实首轮为 3/4：测试脚本错误把 `deepseek-official/deepseek-v4-flash` 合并填入子智能体 model，provider 为空，导致子会话空回答及回退模型无产出。修正为两个独立字段后真实复验 4/4。首轮 [失败报告](../artifacts/task56/live-acceptance-first.json) 与 [日志](../artifacts/task56/live-acceptance-first.log) 保留，未改写为成功。
5. 初始只读探测曾遇到本地旧 mock 配置 `127.0.0.1:18080` 已停服，随后改从当前 ONENAT 配置加载实时目录。公司节点 `0c93ebda` 未取得有效 API key，鉴权探测失败，未计为通过；本轮真实验收仅使用上述两台已授权节点。

## 范围与未验证项

三项 task-56 AC 已有上述实际证据。本轮没有部署或验证正式 WorkBuddy 实例；控制台 UI 仅运行已有函数专项及构建脚本检查，未追加真实浏览器交互验收。公网端口漂移使用目录 mock 演练，没有人为重连线上隧道。

真实模型测试覆盖异机文件 HTTP 读取及 cwd，不把它扩大为 task-57 的真实远程写入/构建/Git 命令验收；helper 写入/CAS/exec 的通过项来自本地 worker 与 mock 测试。远端模型输出仍属于模型转述的工具结果，结合独立上传的随机字节/哈希与 DSH 会话 cwd 核对，不是密码学执行证明。没有逐一试遍所有授权节点、所有模型或所有节点引用别名。

本地 AC 已勾选，task-56 状态维持 In Progress，等待原派发任务 `task-e244b73a` 正常结束并自动回写；未通过平台工具人工设为成功，也未派发 task-57～60。
