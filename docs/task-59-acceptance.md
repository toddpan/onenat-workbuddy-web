# task-59 项目文件授权、并发与稳定节点验收

验收日期：2026-11-06 UTC（北京时间 2026-11-07）。当前开发会话直接实现，原派发任务为 `task-355cd5c5`，未重复派发。前置依赖 task-57、task-58 当前均为 Done；task-60 仍承接发布资源与最终集成文档。本地三个 AC 已验证，原平台终态由正常回写流程处理，不人工设成功。

## 结论与范围

本轮补齐文件入口的项目 view/edit 授权、共享路径约束、项目上传 CAS 和会话物理节点绑定。REST、HTTP 工具与 MCP 共用 `src/workspace-files.ts`；项目任务文件固定访问文件归属节点。普通成员只读，owner/admin 可写，归档只读；通用 node/agent 文件与 P2P 节点凭据限制为 admin/服务令牌。

开始时工作树已有大量 task-55～58 及其他改动，基线保存在 `artifacts/task59/baseline-status.txt` 和 `baseline.patch`。没有重置、提交、推送或部署，也没有将整个 Git diff 归为本条成果。

## 按 AC 验收

| AC | 结果 | 证据与覆盖范围 |
| --- | --- | --- |
| #1 远程工作区访问沿用项目授权，无权限用户不能读取或写入 | PASS（本地） | 授权集成 15/15：REST 文件/附件与 HTTP/MCP 文件工具的 list/download/mkdir/upload/delete/upload_resumable_init/upload_register；非成员拒绝、普通成员只读，包含无 owner 的历史任务。失败统计节点请求数不增加；不能通过通用 node/agent、执行节点或直传 key 绕过。实际 initialize 的同一 MCP 会话跨用户/同 RPC ID、撤销成员与 owner、后增私有子项目均重新授权。 |
| #2 写入检测读取版本，冲突不覆盖，限制路径逃逸 | PASS（协议范围） | 工具 download 返回 SHA256；项目 upload/任务附件调用实际 Node worker。新建 expectAbsent，更新 expectedSha256，缺版本 428、旧版本 409；两个同版本并发写入一成一败。multipart 与附件部分成功有清单并登记。覆盖词法越界、同节点别名重叠私有 root、root/祖先/后代 symlink、不可信元数据和递归父目录删除。helper/访问工具专项 25/25，另 4 项控制台布局回归。 |
| #3 会话绑定使用稳定节点身份，端口漂移不导致错误迁移 | PASS（受控测试） | 持久化 nodeRefKey/resolvedMappingId；同 mapping 新端口复用，app 改绑拒绝。历史/追问、主会话、控制与 P2P 登记按原 mapping 新入口访问；离线不向旧 URL 请求。旧 URL/app-only 绑定不能把旧 sessionId 发到新节点探测。重启保留物理 mapping；P2P 初始化后会话变化拒绝登记。对应 engine/tool-ops 单测和执行节点 8/8 集成。 |

AC2 的“冲突不覆盖”指通过该协议的文件写回；不是批次事务、原生 mkdir/delete 的版本 CAS，也不是针对敌对本地进程的隔离保证。

## 实现要点

- `src/workspace-files.ts`：项目读写权限、通用节点门禁、根目录和子名称规范化、重叠项目 ACL、逐级元数据验证、远程 CAS worker 接入。
- `src/router.ts`：所有项目文件和任务附件路径复用策略；多文件失败回传已完成项；部分成功附件仍入账。服务令牌通过外层鉴权后可读 REST 任务，文件仍经过项目/路径/归档检查；无凭据请求 401。
- `src/tool-ops.ts`：文件工具执行/重放均检查当前身份与 scope。读取禁用旧结果重放；成功写入幂等缓存绑定项目/root/node/task/调用者，scope 变更要求新 RPC ID。聊天工具历史和追问也使用稳定会话解析器，并支持节点主会话。
- `src/types.ts`、`src/engine.ts`：保存逻辑与物理节点身份；已有会话按原 mapping 实时解析，禁止离线 URL 回退或把旧 sessionId 迁往 app 新 mapping。附件初始化和登记绑定会话与节点。
- `src/web-ui.ts`：普通用户附件走项目 multipart 创建，不下发节点级 key；冲突/只读错误展示且不自动盲重试。管理员保留原有 P2P 通道。
- 测试新增 `scripts/workspace-permissions-e2e.mjs`、`scripts/workspace-files-ui-test.mjs`，扩展 engine/tool-ops 单测及项目 mock 元数据。旧注入 fixture 改为两个独立 mock 节点，分别验跨机与本地指引。
- 规则同步到 `docs/design-user-project-management.md` §12 和 `docs/project-workspace-nodes.md`，未修改 task-60 所有的 npm 包资源清单。

## 最终运行结果

日志均在 `artifacts/task59/`。下列命令实际执行，最终退出码均为 0；较早失败日志保留。

| 命令/检查 | 结果 | 日志 |
| --- | --- | --- |
| `npm run typecheck` | PASS | typecheck-delivery.log |
| `npm run build` | PASS，包含内嵌页面脚本解析 | build-delivery.log |
| `npm run test:unit` | 223/223 | unit-conclusive.log |
| `npm run smoke` | 93/93 | smoke-delivery.log |
| `npm run smoke:mcp` | 28/28 | mcp-delivery.log |
| `npm run smoke:perm` | 74/74 | perm-smoke-delivery.log |
| `node scripts/workspace-permissions-e2e.mjs` | 15/15；11 次实际本地 worker 执行、563 次 mock 节点请求、activeSessions=0 | permissions-delivery.log |
| `node scripts/project-identity-e2e.mjs` | 10/10 | identity-delivery.log |
| `node scripts/project-execution-e2e.mjs` | 8/8 | execution-delivery.log |
| `node scripts/project-workspace-e2e.mjs` | PASS | workspace-delivery.log |
| `node --test --test-concurrency=1 scripts/workspace-remote-test.mjs scripts/workspace-access-test.mjs scripts/project-console-ui-test.mjs` | 29/29（25 helper/访问 + 4 UI） | worker-ui-verified.log |
| `node scripts/project-node-ui-test.mjs` | 19/19 | project-ui.log |
| `node scripts/workspace-files-ui-test.mjs` | 3/3 | upload-ui.log |
| `WORKBUDDY_ALLOW_PRIVATE_DIRECT=1 node scripts/attachment-ai-token-e2e.mjs` | PASS，串行隔离 | p2p-delivery.log |
| `node scripts/workspace-inject-e2e.mjs` | PASS，串行隔离 | inject-delivery.log |
| `node scripts/orch-upstream-file-e2e.mjs` | PASS | upstream-delivery.log |

运行环境 Node v26.7.0 / npm 11.19.0。已有 MaxListenersExceededWarning 仍可见，未因此放宽断言。19 项项目 UI 和 3 项上传 UI 是 emitted-JS/DOM fixture，4 项 UI 属函数/布局回归，均不等于浏览器交互验收。

## 失败、修复与复验记录

1. 授权 mock 初次用固定下载次数断言，扩展场景后不成立，改为请求前后快照；macOS 临时目录扫描偶遇无关 sibling 删除的 ENOENT，在 mock lstat 中跳过。产品拒绝未知元数据的策略没有放宽。
2. 单测曾有 TS7022 类型推断错误，显式标注 ensureSession 测试结果类型后通过；完整记录在早期 unit/typecheck 日志。
3. P2P 首跑因隔离 loopback SSRF 被拒，之后使用仅该进程的 WORKBUDDY_ALLOW_PRIVATE_DIRECT=1。曾误将两个共享 18096 端口的旧脚本并行运行，日志不作验收；最终全部串行执行。
4. P2P 隔离后 init/parts/register/download 已成功，后续任务详情为空、消息未执行、relay 404。核对发现服务令牌已通过外层鉴权，但 taskForView 将无登录身份的服务请求拒绝。修复与文件策略一致，并在授权集成补 REST 服务下载和无凭据 401；最终旧 P2P 脚本通过。它的警示场景任务为 failed，验证的是非 draft 提示，不证明真实模型正常完成。
5. 旧 ws-inject fixture 两个成员原本使用相同 direct URL，却期待跨节点 HTTP 提示；改为两个独立节点，并对同节点直发验证本地指引和不重复下发凭据，没有恢复错误远程绕行。
6. 新聊天工具测试首次假定存储保留预设 agent ID；WorkStore 实际生成新 ID，改用返回 ID 后用例通过。保留 unit-delivery.log。
7. 下一次完整单测在已有 backlog 重启用例失败：同步 flush 与尚在执行的异步写入共享 .tmp，任务未读回。仅修正测试的正常关闭时序，有限等待 writing=false 后 flush；未在本条改写存储实现。保留 unit-delivery-rerun.log，最终 unit-conclusive.log 为 223/223。该同步/异步 flush 边界仍作为已知限制，不称为已修产品问题。

## 依赖、真实证据和限制

- task-57、task-58 当前文件均 Done，原依赖不变。task-57 已有真实双节点主/子 CAS、命令与独立哈希核验，记录见 `docs/task-57-acceptance.md`；task-58 已有浏览器证据见其独立报告。本轮没有重跑真实节点、模型或浏览器，不把历史证据计入本轮 15 个授权场景。
- 本轮文件节点是本地 HTTP mock，运行实际 Node worker 并读回真实临时文件，临时会话最终为 0；不会证明线上模型必定执行命令，也不是密码学执行证明。
- 当前 admin 可穿透项目，服务/AI API 令牌尚不绑定用户；这两类保留节点范围能力。普通用户只有项目 scope，项目 owner 也不能得到节点 P2P key。不要把“持服务令牌者”解释为受成员 ACL 限制的普通用户。
- 路径检查需要可信且完整的目录元数据。root/祖先为 symlink（包括 macOS /var）拒绝；配置 canonical /private/var。预检和原生文件操作不原子，敌对目录替换仍有 TOCTOU；硬链接或未登记的物理节点别名也不由词法项目身份自动发现。
- worker 协作锁只协调使用协议的写者，不能阻止编辑器、终端或其他进程；任意模型命令仍有节点账号能力。mkdir/delete 未升级为版本 CAS。
- 项目 worker 单次写入上限 8 MiB；multipart 按文件顺序保存，返回 partial，不提供整批回滚。普通控制台当前支持安全创建/错误显示，没有图形化 expectedSha256 编辑界面。HTTP 下载没有新增版本头，可用工具返回的哈希更新。
- 已有同步/异步 store flush 的共享临时文件竞态未在本条改产品；重启验收等待正常异步保存完成，不能证明突然退出时持久化完全无竞态。
- npm pack 未包含 scripts/workspace-remote.mjs 的已知资源缺口由 task-60 修复/隔离安装验收；仓库 build 通过不等于 npm 安装包已可用。

模型侧文件工具定义 JSON 用 cl100k_base 代理计数为 758→817（+59），见 `artifacts/task59/tool-tokens.json`。不是部署模型 tokenizer 的完整首轮提示词消耗；没有声称实测模型 token 降低。

本轮保留原 backlog 历史、已有未提交代码和失败证据；没有修改正式服务、重连公网隧道、手工更改平台终态、派发后续任务或重复实现。
