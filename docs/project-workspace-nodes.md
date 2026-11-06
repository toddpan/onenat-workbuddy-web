# 项目工作区与执行节点

本功能对应 backlog task-55～task-60。项目始终绑定文件归属节点与工作区；执行节点由新建会话时选择。

## 数据与选择规则

- `Project.dshRef`、`Project.workspace`、`Project.apiKey`：文件归属节点、文件根目录及其凭证，文件浏览与 backlog 继续使用它们。
- `Project.defaultExecutionNodeRef`：新会话默认执行节点；缺省为文件归属节点。
- `WorkTask.nodeRef`：本任务执行节点的快照；创建时显式选择优先于项目默认节点。修改项目默认节点不迁移已创建会话。
- 项目任务仍继承项目指令、技能和默认协作成员。子智能体回自身绑定节点运行，必要时也访问项目的远程工作区。
- ONENAT mapping/app ID 用于节点身份。连接前实时解析入口；公网端口不参与项目唯一性计算。

项目工作区按“文件归属节点稳定引用 + 规范化绝对根目录”唯一约束。不同节点相同路径不会合并；同一仓库的不同 checkout 也不合并。普通创建/编辑冲突返回 409；导入可在权限允许时复用原项目。已有重复项目不会被自动删除或跨权限合并；本版不自动发现符号链接或不同 ONENAT 映射其实指向同一物理目录的别名。

## 跨节点文件与命令访问

文件属于另一节点时，不能把其绝对路径作为执行节点本地工作目录。WorkBuddy 为主会话和子会话安装不含凭据的远程工作区工具，并注入文件归属的稳定 mapping 引用、ONENAT 目录地址、工作区根目录与鉴权使用方式。主会话无需 `@` 即可获得指引。旧长会话在下一轮自动安装 v3 helper，替换只支持固定 `--base` 的早期版本和缺少有界结果读取的 v2（含编号副本）。主、子会话共用目录时，DSH 可能把第二次上传改名为 `.workbuddy-workspace-remote-v3-1.mjs`；安装与缓存识别同版本的编号文件名，并核对返回的绝对路径与文件名一致，避免误判安装失败。

`workspace-remote.mjs` 使用文件归属节点的 DSH Web Service：在该节点创建短期会话，通过既有会话文件接口上传不含凭据的 Node worker，说明具体请求并允许模型检查脚本，再执行短命令 `node <上传路径>`。worker 自删脚本、将带随机 nonce 和请求摘要的 JSON 原子写入临时结果文件；helper 经 HTTP 文件接口直接读回并验证，随后清理脚本、结果文件及短期会话。结果注明 `executionEvidence: http-read-worker-result`，带临时会话 ID 和 DELETE 确认；模型负责命令执行，不再转述文件内容或长 base64 结果。这仍依赖受信任的文件节点，不构成密码学执行证明。DSH DELETE 可能保留归档历史，本功能不声称物理抹除聊天记录。它不依赖未经验证的远端 exec API。

prompt 已发送但响应丢失或超时时，helper 只读取本次结果文件，不重发命令；有效结果可核验，否则报 `OUTCOME_UNCERTAIN`，提示操作可能已经发生，应 read/CAS 核验后决定后续。结果下载同时检查 Content-Length 和实际流式字节数，上限 32 MiB；超限、损坏 JSON 或 nonce/operation/requestHash 不匹配均拒绝。目录解析失败、尚未发送 prompt 则保留解析错误。临时脚本、结果 JSON、`.tmp` 或会话清理失败明确报错；404 视为已清理，401/403 与目录离线错误不吞掉。

- `list/read`：真实路径边界校验后返回目录/文件；读取返回内容哈希。
- `write`：使用读取的 SHA256 或明确目标不存在作为前置条件，获取协作锁后检查并原子替换；冲突报错，不覆盖新内容。
- `exec`：在归属工作区执行 argv 命令，进行路径 guards 校验、协作锁与超时控制。构建、测试、Git 操作保留归属节点上的依赖环境。
- ONENAT 连接使用 `--node-ref mapping:ID --onenat-base URL`。每次 DSH HTTP 请求（创建会话、上传 worker、提示执行、读回结果、清理临时文件、清理会话）都重新查询 `/api/v1/resources`，不缓存公网端口；目录不可用、离线或引用缺失时失败，不使用旧地址，也不重试不确定的写入/命令。
- helper 可接受 `app:ID`，但该 app 必须唯一绑定一个 mapping；多映射返回 `AMBIGUOUS_NODE`。WorkBuddy 注入时把 app 本轮解析结果固定到具体 mapping，避免同一应用模板被多台机器共用时操作其他节点。一次操作中若 app 指向不同 mapping，拒绝迁移临时会话。
- 显式 direct 节点继续使用互斥的 `--base API_BASE`，没有 ONENAT 漂移能力。HTTP 浏览/下载示例仅是本轮快照，持续跨机访问使用稳定引用 helper。
- 具体参数运行 `node <工具路径> --help`。节点凭据通过 `WORKBUDDY_WORKSPACE_API_KEY`、目录凭据通过 `WORKBUDDY_ONENAT_API_KEY` 环境变量传入，不写入 helper；仍须信任接收提示词的执行节点。

此通道要求两侧可运行 Node.js >=20，文件归属 DSH 支持创建/提示/删除会话，且模型具备执行命令的工具权限。拒绝执行、缺少可信格式结果、离线与超时均返回失败；不能把生成的指令当作执行成功凭证。能力不可用时保留原文件服务的浏览/下载指引，并明确写回和命令不可用。

路径校验覆盖 worker 管理的文件操作和命令工作目录/guards，不是操作系统级命令沙箱。任意授权命令仍有该 DSH 账号本身的访问权限。协作锁协调通过该工具进行的操作，不能阻止终端、编辑器或其他未遵循协议的进程并发改文件；执行全目录变更前仍应保持项目写操作串行。

## 兼容与权限

旧项目无需搬迁目录；未设置执行节点时仍在原文件节点运行。文件归属节点凭证不用于鉴权另一执行节点。WorkBuddy 现有项目可见性和任务操作权限保持有效；远端调用沿用节点自身授权能力，不会为节点 API 凭证增加更细的工作区权限。不要向不可信节点派发含敏感文件凭证的任务。

文件树与 backlog 使用归属节点；会话历史、模型和附件会话按实际执行节点解析。文件节点离线时不在执行节点补建相同路径作为替代工作区。

### 项目文件权限与冲突保护（task-59）

REST、HTTP 工具和 MCP 文件入口共用项目 scope：普通成员可读、owner/平台管理员可写、归档只读，非成员无权读写。旧无 owner/members 项目仍对已登录用户可读，写入仅管理员。普通用户必须提供 projectId 或项目 taskId，不能通过通用 node/agent、执行节点或 P2P 凭据绕过；项目 owner 也不能取得节点级直传 key。服务/AI API 令牌尚不绑定用户，保留服务范围能力，不等同普通成员身份。

项目文件固定在归属节点根内；同节点 mapping/app/direct 别名下的私有重叠项目分别检查权限。目录检查从文件系统根逐级验证祖先、项目 root 和目标，链接或未知元数据拒绝。macOS /var 是链接时请使用真实 /private/var。预检后原生文件请求仍有目录替换 TOCTOU，需要可信节点和非敌对本地写者；不是 OS 沙箱，不能保证硬链接或未登记物理别名自动隔离。

文件工具 download 返回 sha256，upload 更新携带 expectedSha256；新建以 expectAbsent 检查。项目 multipart/任务附件也复用 worker 锁内 CAS 和原子 rename：缺版本 428、旧版本 409，不盲覆盖。多文件部分失败返回已完成 files/partial/failedFile，附件同时登记成功项；不提供整批回滚。普通用户控制台安全创建并显示冲突/只读错误，当前没有图形化版本编辑界面。mkdir/delete 仍是原生接口，没有版本 CAS。worker 单次写入上限 8 MiB。

MCP 读取每次重新授权和读取；成功写入的重复请求重新检查权限、路径及项目/root/node/task 指纹后才幂等返回。新增私有子项目或成员撤权不能重放旧结果。TaskSessionBinding 保存 nodeRefKey 与 resolvedMappingId；已有会话按原 mapping 的当前入口读取、追问和控制，app 改绑或原节点离线不将旧 sessionId 交给其他节点。旧 URL-only/app-only 未验证绑定拒绝控制，正常执行时新建会话。

2026-11-06 UTC 本地最终：typecheck/build、unit223/223、smoke93/93、MCP28/28、权限smoke74/74、授权并发15/15（11次实际本地worker，563个mock节点请求，activeSessions=0）、身份10/10、执行8/8、项目workspace及P2P/ws-inject/orch-file串行集成均通过；helper/访问+UI回归29/29，项目UI19条、上传UI3条通过。UI为DOM/函数fixture，本轮没有新增浏览器或真实ONENAT模型验收。前置task-57/58均Done，真实证据保留在各自报告；npm包helper资源缺口留task-60修复。完整失败历史、证据和限制见 [task-59 验收记录](task-59-acceptance.md) 和 [权限设计 §12](design-user-project-management.md#12-项目工作区文件授权与并发task-59)。

## 验证

完成实现后运行：

```sh
npm run typecheck
npm run test:unit
npm run build
npm run smoke
node --test scripts/workspace-remote-test.mjs scripts/workspace-access-test.mjs
```

项目双节点集成测试 `node scripts/project-workspace-e2e.mjs` 验证选节点、项目重复冲突、归属节点凭证与文件访问、远程 helper 注入及旧会话快照。

本轮本地验证结果：typecheck/build 通过；完整单测 202/202；独立 smoke 93/93；远程工具与提示词 12 项通过，UI 定向 19 条检查通过；双节点 mock 集成、`smoke:ws-inject` 与 `smoke:orch-file` 通过。隔离控制台浏览器检查登录、项目创建表单及 390px 移动宽度，无页面横向溢出。测试包含原有测试清理时的 MaxListeners 警告，不影响通过结果。

真实 ONENAT 双节点模型执行尚未验收，本地 3080 DSH 接口未可达；mock 不能证明线上模型必定执行命令。上述是初轮 task-55～task-60 的实现记录，正式服务未部署。

### task-55 独立验收补充（2026-11-06T15:18:13Z）

本轮仅补齐并验收统一身份与项目唯一性，三项 AC 均通过。最终 build/typecheck、完整单测 211/211、独立 smoke 93/93、MCP smoke 28/28、创建/编辑/导入/MCP 集成 10/10、既有双节点 mock 集成通过。详见 [task-55 验收记录](task-55-acceptance.md)，其中列出日志、隐私与旧数据断言、先前第 5 组导入回调 409 的复验说明。

导入只复用发起人当前有权访问的项目，并保留原成员和配置；旧重复项目不自动合并，旧 ownerless 项目编辑不被自动认领。HTTP/MCP 注入服务端验证的请求身份，MCP 缓存按身份隔离并检查当前项目权限；慢请求或登出不会串用管理员/服务权限。

task-55 无前置依赖，task-56 已依赖 task-55。本条本地验收完成；原平台任务终态由正常流程回写，未派发后续条目，未 commit/push/部署。真实 ONENAT 模型执行仍未验证，后续条目的运行验收不由本条 mock 结果替代。

### task-56 独立验收补充（2026-11-06T15:55:36Z）

本轮只补齐并验收项目任务执行节点，三项 AC 均通过。默认执行节点与文件归属独立持久化；REST/MCP 支持只修改/清除默认节点；projectId + mapping/app/direct nodeRef 可独立指定，@项目首次绑定快照执行节点，去重按项目及节点区分。旧任务不随默认值迁移；旧无 nodeRef 任务在原文件节点运行，同项目默认 fork 也快照这个原有效节点。规划/主/子会话目录只在接收节点有归属时使用，异机不补建项目路径；子智能体回退其他节点不沿用旧 workDir。

最终 typecheck/build、unit 216/216、独立 smoke 93/93、MCP smoke 28/28、执行节点 HTTP/MCP 集成 8/8、task-55 身份权限集成 10/10 通过；既有项目双节点、远程工具 12/12、UI 函数专项 19 条、ws-inject、orch-file 及 git diff --check 通过。详见 [task-56 验收记录](task-56-acceptance.md)，包含失败复现、修复和最终日志。

真实 ONENAT 两节点复验 4/4：文件归属 KB136（mapping 6cc2987d）、执行 brain（mapping 5602f2c2）均按实时目录解析；主/子会话实际 cwd 为 brain 临时目录，经 HTTP 读回 KB136 随机文件及正确 SHA256；改默认节点后原会话复用、新任务采用新默认。首轮测试子智能体 model/provider 填写错误导致 3/4，原失败报告保留；配置修正后复验成功，两轮临时会话/目录/新增 workspace 均清理。

这些真实结果覆盖 task-56 的节点/cwd 和异机文件读取，不替代 task-57 的真实远程写入、构建或 Git 操作验收。规划 cwd 由 HTTP mock 和单测覆盖；本轮未做新浏览器交互、未部署正式服务，也未人为重连公网隧道。task-56 依赖已 Done 的 task-55，AC 已本地登记，平台终态留给原任务 task-e244b73a 正常回写，未派发后续条目或人工设成功。

### task-57 独立验收补充（2026-11-06T17:39:16.658Z）

三项 AC 均通过。最终 v3 真实双节点 4/4：无 @ 主会话和实际 `retrySubtask → runSubtask` 子会话都自动注入稳定 owner，分别安装原名与 `-1` 编号 helper，独立下载源码 SHA256 一致；各完成 list/read/write/stale-CAS/read/exec 六步。控制端从 KB136 独立下载两路 txt/built 核对最终哈希，命令 cwd/产物在 owner，brain 无 owner 同路径。12 个 helper 会话、2 个执行会话、2 个隔离目录和 1 个新增 workspace 清理成功，目录缺失用明确 HTTP 错误核验；归档历史可能仍保留。

原 child 归档首条 prompt 的只读降级已证实；原会话的 helper 上传回包当时未采集，不能唯一断言失败来自编号。另一组独立同目录两会话实验实证 DSH 对重复上传加 `-1`，旧安装函数只认原名会确定产生同样降级；这是已证实的兼容缺陷和与原症状一致的解释，不冒充原会话回包。原始失败、独立上传复现及 red/green 测试均保留。最终 helper 升至 v3，确保存量 v2 会话获得 32 MiB 有界结果读取；主/子 v1、v2、编号 v2 只升级一次由回归覆盖。

最终 typecheck/build 通过、unit 218/218、工具专项 25/25、执行节点集成 8/8、项目双节点集成、smoke 93/93、MCP 28/28、ws-inject、orch-file 和 diff 检查通过。真实离线拒绝有独立报告，持续端口漂移与丢回包不重放由 HTTP mock 覆盖，未人为重连线上隧道。详见 [task-57 验收记录](task-57-acceptance.md) 的完整哈希、失败记录、日志及限制。

本条依赖 task-55、task-56；本地登记 AC 后，原宿主终态留给正常自动回写。本轮没有手工将 task-10560a65 设成功、派发后续待办、修改 task-58 UI、commit/push 或部署正式服务。

### task-57 首次新子会话 chat 补充（2026-11-06T18:01:42.321Z）

核对发现当前 `getTask` 返回活对象、`mutateTask` 原地修改，因此“mutateTask 换对象导致首个 binding 不可见”不作为当前根因。完整 `runChatTurn` 空 sessions/无附件/无主 binding 回归在未刷新 task 时已通过。前轮曾人为 upsert 替换对象并加刷新 task；按用户补充排除，现已撤回该生产改动及人工替换测试，生产 engine 精确恢复至前轮基线。保留正常 chat 回归，新增公开单 @ 的 `sendUserMessage → planner → runSubtask` 回归，原对象身份/首个 binding/编号 helper/实际 prompt 同时断言，未预置 DAG；当前单测 220/220。旧假设、日志和纠正历史保留，不能作为生产缺陷依据。

完整 `runChatTurn` 双真节点补充 4/4、exit 0：先 child、后无 @ main，无预建 binding/任务附件；两路稳定 owner/helper 注入全为 true，helper 源码、owner txt/built 均经独立下载核验。14 个会话、2 个随机目录、1 个 workspace 清理完成，19 条记录无错误，6 次精确路径缺失核验。当前公开单 @ 会进入规划器，本补充显式调用完整方法，不声称覆盖公开队列/activeJobs 路由。typecheck/build、工具25/25、执行集成8/8、项目工作区集成、smoke93/93、ws-inject、orch-file 通过；详细红绿日志、哈希和边界见 [task-57 验收记录](task-57-acceptance.md) 与 [chat 精简证据](../artifacts/task57/chat-live-summary.json)。未改 task-58 UI、正式服务或原宿主终态。

### task-57 因果排除与公开入口补验（2026-11-06T18:22:15.842Z）

已撤回无生产对象替换证据的 task 刷新和人为 upsert 回归；当前 engine SHA256 与提出该假设前一致。原失败 session 只读历史再次核验：43条消息、首个工作区 user seq9 确认降级，直接关联到原 session；原 helper 上传回包仍缺，不能唯一归因。[原归档直接证据](../artifacts/task57/causal-original-archive.json)与独立编号实验分开登记。

未刷新 task 的公开 REST 单 @ 入口双真节点4/4、exit0：无任务附件/binding，文件 API 预放原名制造重名；实际经过 sendUserMessage→runOrchestrateTurn→runSubtask，LLM 规划报错后使用系统静态兜底，未手工预置DAG。child自动上传200返回v3-1、main后返回v3-2；同session上传字节/独立helper下载哈希一致，历史首条prompt哈希与发送值一致，稳定owner/helper存在且无降级。两路owner txt/built独立核验通过；16个会话、2个目录、1个workspace共21条清理记录无错误，6次精确缺失检查。公开入口旧exact-name谓词隔离红灯、当前逻辑绿灯证实编号兼容缺陷，不据此补造原失败回包。typecheck/build、unit220/220、串行工具25/25、smoke93/93及相关集成通过；短时限工具首跑23/25与隔离复跑2/2日志保留。详见[验收记录](task-57-acceptance.md)与[公开入口证据摘要](../artifacts/task57/public-live-summary.json)。

### task-58 独立验收补充（2026-11-06T17:40:04Z）

task-58 三项 AC 已本地实测通过，依赖 task-56 当前 Done。项目新会话保持 projectId 并独立携带所选 nodeRef；项目编辑区分文件归属与默认执行并展示直接/远程访问状态；文件树和 backlog 固定归属节点，离线返回错误不迁移到执行节点。详见 [task-58 验收记录](task-58-acceptance.md)。

本轮只补齐实际浏览器发现的三个UI缺口：节点菜单按实际尺寸/可视视口限制定位，切换执行节点后更新文件树来源说明，768px关闭抽屉完整移出屏幕不再截获发送。桌面及320/390/768px浏览器7/7组通过；真实ONENAT浏览器5/5组通过，KB136文件归属、brain执行，远端会话cwd与随机文件SHA256核验一致。真实运行采用隔离draft临时workDir；一键首消息POST由mock浏览器覆盖，详细限制均已登记。

最终typecheck/build、unit218/218、smoke93/93、UI19+4项、远程工具25/25、执行集成8/8、项目workspace集成及diff检查通过。本轮期间有并行engine/helper更新，早先失败与最终通过日志均保留，不将并行成果归到本条。所有临时服务、会话、目录及增量workspace已清理；真实微信/X5与移动软键盘仍未验证。用户要求的补充复验已在隔离页移除翻译扩展独立容器，320/390/768px文件侧栏关闭均通过真实浏览器点击、命中及isTrusted事件核验；完整流程7/7通过，未改产品源码，原遮挡日志保留。当前helper/remote统一25/25、结果边界独立2/2通过（边界是前者子集），详见task-58验收补充。未commit/push/正式部署或重复派发；原平台终态留给task-22da2aa8正常回写。

### task-60 发布资源修复与回归补充（2026-11-07T05:45+08:00）

**发布资源缺口修复**：`npm pack` 此前 1085 文件中不含 `scripts/workspace-remote.mjs`——`dist/workspace-access.js` 运行时按 `new URL('../scripts/workspace-remote.mjs', import.meta.url)` 相对读取该 helper，npm 安装树上必然断链（deploy tar 单独同步 helper 不构成 npm 包内的保证）。已将 `scripts/workspace-remote.mjs` 加入 `package.json` `files` 白名单。

**安装树布局验证（6/6 PASS）**：真实 `npm pack` 打包 → tarball 解包到隔离临时树 → 在安装树上调用真实的 `installWorkspaceAccessCli`（stub upload 捕获字节）：上传 31158 字节、与仓库 `scripts/workspace-remote.mjs` SHA256 一致（`6c561494101a81de…`）、返回编号 v3 路径、pack 清单含 helper 与 `dist/workspace-access.js`。证据：`artifacts/task60/pack-resource-verify.log`、`artifacts/task60/pack-files.json`（修复后 pack 1088 文件）。该检查证明模块/资源布局，不等于完整安装包端到端部署；未发布 npm、未部署正式服务。

**本轮回归（AC #1）**：typecheck 0、build 0、完整单测 223/223（`test:unit` 已实际执行 `tool-ops.test.js`，含 task-53/54/55/56 回归）、独立 smoke 93/93、helper/remote 工具专项 25/25。既有用户改动全部保留，本轮仅改 `package.json` files、本文档与 backlog 记录。

**兼容表述**：v3 为最终 helper；旧 v2 真实 4/4 与 v3 最终真实 4/4 证据、v1/v2/编号 v2 存量升级单测按 task-57 记录区分表述。真实 ONENAT 双节点模型执行的公开入口验收以 task-57 `artifacts/task57/public-live-acceptance.json`（4/4）为准，本轮未重跑真实节点，不将历史证据计入本轮发布资源检查。

**派发执行者独立复跑（2026-11-06T21:56Z）**：task-60 派发任务会话未改源码，全新复跑 typecheck/build/单测 223/223/smoke 93/93 全绿（日志 `artifacts/task60/regression-rerun-dispatch.log`），并逐项核验 AC#2 场景证据（task-57 公开入口 4/4、task-55 导入集成 10/10、离线 NODE_OFFLINE、stale-CAS 与 task-59 并发 15/15）。未 commit/push、未部署、未重复派发。
