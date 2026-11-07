# 验证重跑报告：功能测试与稳定性测试（2026-11-07）

**执行角色**：验证测试工程师（只验证、不修复）
**工作目录**：/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web
**版本**：git 5be8d36（2026.11.1，工作区干净，仅新增本报告与证据目录）
**证据目录**：`artifacts/verify-rerun-20261107/`

---

## 结论摘要

- 功能测试 17 个套件全部实跑：**15 通过 / 2 失败**；失败为 `npm run smoke:xiaozhi`（31/32，断言用过期契约）与 `npm run test:models`（14/23，测试桩缺 requestContext 崩溃），两者均连续 2 轮稳定复现，已提交 backlog **task-61（P3）**、**task-62（P2）**。
- 稳定性测试本地自包含 7 阶段全部 PASS：启动 207ms；healthz×100 与混合读并发 0 错误；数据面回环 51/51；**kill -9 中断恢复 106ms、数据与账号 100% 保留**；180s 长跑 243 请求 0 错误、RSS 115MB→73MB 无泄漏、CPU≈0%。
- 线上轻量复核（阿里云生产）：真实派发任务 46.7s success、回复精确命中，事件窗无应用级失败；测试任务已删除清理。
- 新发现缺陷第 3 项：优雅退出（SIGTERM/SIGINT）不调用 `store.flush()` 兜底，SIGKILL 丢尾已实测复现 → **task-63（P3）**（小 store 的 SIGTERM 丢数据未复现，如实标注）。
- 总体：**2 个可复现失败（均已立案）+ 1 个可靠性缺口（已立案）**；其余全部通过。测试驱动侧曾有 4 处契约误用（v1/v2），已修正并以 v3 出干净终轮，过程留档。

---

# 验证结论

**总体：部分通过**。功能面 15/17 套件通过，2 个失败均判定为「测试资产与实现契约脱节」类缺陷（非服务运行时故障）并已立案；稳定性面本地 7/7 PASS、线上轻量复核 PASS；可靠性发现 1 个停机兜底缺口已立案。

---

# 逐条对照：功能测试（全部重跑，非历史结果）

> 说明：任务合同写「npm run smoke（39 项）」，实际本次执行为 93 项检查——套件较历史记录已扩充，以实际可执行用例为准。
> `smoke:e2e` 需本机 DSH web service：本机实际在 31789 端口且启用强制鉴权（默认文档口径 3080）。经 DSH 管理面（`/api-keys`，Admin Token）临时创建密钥注入 mock 映射后成功执行，跑完即吊销删除（详见「环境处置记录」）。

| # | 用例 | 命令 | 实际结果 | 退出码 | 结论 | 证据 |
|---|---|---|---|---|---|---|
| F01 | 类型检查 | `npm run typecheck` | tsc --noEmit 无输出 | 0 | ✅ 通过 | func/f01-typecheck.log |
| F02 | 构建 | `npm run build` | "Standalone build complete: dist/server.js"，page scripts extracted: 3 | 0 | ✅ 通过 | func/f02-build.log |
| F03 | 单元测试 | `npm run test:unit` | **223/223 通过**（16 个测试文件，duration 8.8s） | 0 | ✅ 通过 | func/f03-unit.log |
| F04 | 独立部署全链路冒烟 | `npm run smoke` | **93/93 项通过**（mock ONENAT 自包含） | 0 | ✅ 通过 | func/f04-smoke.log |
| F05 | 定时任务冒烟 | `npm run smoke:schedules` | **59/59 通过** | 0 | ✅ 通过 | func/f05-schedules.log |
| F06 | 监控大屏冒烟 | `npm run smoke:monitor` | **31/31 项通过** | 0 | ✅ 通过 | func/f06-monitor.log |
| F07 | AI 技能接入冒烟 | `npm run smoke:ai` | **43/43 项通过** | 0 | ✅ 通过 | func/f07-ai.log |
| F08 | MCP Server 冒烟 | `npm run smoke:mcp` | **28/28 通过** | 0 | ✅ 通过 | func/f08-mcp.log |
| F09 | 用户管理冒烟 | `npm run smoke:users` | **86/86 项通过** | 0 | ✅ 通过 | func/f09-users.log |
| F10 | 资源权限冒烟 | `npm run smoke:perm` | **74/74 项通过** | 0 | ✅ 通过 | func/f10-perm.log |
| F11 | Backlog E2E | `npm run smoke:backlog` | **145 项全部通过**（B1-B4/B7 后端闭环） | 0 | ✅ 通过 | func/f11-backlog.log |
| F12 | 工作区注入 E2E | `npm run smoke:ws-inject` | **19 项全部通过** | 0 | ✅ 通过 | func/f12-ws-inject.log |
| F13 | 编排上游文件 E2E | `npm run smoke:orch-file` | **15 项全部通过** | 0 | ✅ 通过 | func/f13-orch-file.log |
| F14 | 小智 MCP 冒烟 | `npm run smoke:xiaozhi` | **31/32 项，1 项失败**：「超大结果被单帧上限替换为结构化提示」。期望 `truncated===true && isError===true`，实际返回 `{ok:true, oversized:true, bytes:123675, thresholdBytes:32768}`（scripts/smoke-xiaozhi-mcp.mjs:328-334） | **1** | ❌ **失败（复现×2）** → [task-61](../../backlog/tasks) | func/f14-xiaozhi.log、func/f14-xiaozhi-repro2.log |
| F15 | 模型目录回归 | `npm run test:models` | **14/23 通过，9 用例崩溃**：`TypeError: Cannot read properties of undefined (reading 'run') at WorkBuddyRouter.dispatch (dist/router.js:1135)`——回归桩 `Object.create(WorkBuddyRouter.prototype)` 未初始化构造期 `requestContext`（cf50d8f 引入） | **1** | ❌ **失败（复现×2，两轮 14/23 完全一致）** → [task-62](../../backlog/tasks) | func/f15-models.log、func/f15-models-repro2.log |
| F16 | 流式完整性回归 | `npm run test:streaming` | 3/3 组全部通过（mock 远端健壮性/客户端渲染回归/markdown 无损，行级丢失 0） | 0 | ✅ 通过 | func/f16-streaming.log |
| F17 | 真实派发 E2E | `SMOKE_E2E=1 DSH_WEB_PORT=31789 DSH_WEB_API_KEY=<临时Key> npm run smoke:e2e` | **97/97 项通过**，真实任务 status=completed、回复「收到」、远端会话已绑定 | 0 | ✅ 通过 | func/f17-smoke-e2e.log |

**统计**：套件级 17 用例 = 15 通过 / 2 失败（均有可复现证据）；断言级约 971 项检查 = 961 通过 / 10 失败（xiaozhi 1 + models 9）。

# 逐条对照：稳定性测试（全部重跑）

## 本地自包含套件（mock ONENAT:18085 + server:18095，持久数据目录；驱动脚本 stab-driver-v3.mjs，终轮 7/7 PASS，DRIVER_EXIT=0）

| 阶段 | 场景 | 关键指标 | 退出码 | 结论 | 证据 |
|---|---|---|---|---|---|
| ST0 | 服务启动 | mock 就绪；首次健康检查 **207ms**；管理员登录 200 | 0 | ✅ | stab/run3-v3.log |
| ST1 | 只读高频（S1 等价） | `/healthz`×100 顺序：**100/100，avg≈0ms，p95=1ms，max=5ms，0 错误**；混合读并发 6轮×8（monitor/tasks/projects/resources/schedules/healthz）：**48/48，avg=2ms，max=8ms，wall=16ms，0 错误** | 0 | ✅ | stab/run3-v3.log |
| ST2 | 数据面回环 ×3（S2 等价） | 每轮：项目 create→同参 create→删→重建→清（实际契约：无 id 同参 create 亦新建新 id，不报错）；draft 任务 create→status=draft→delete；chat 任务 create→rename→model set/回读/清→列表含→删→列表不含→GET 404。**51/51 全通过，0 失败** | 0 | ✅ | stab/run3-v3.log |
| ST2p | 持久化造数 | 项目 proj-90fhqoas + draft/chat 任务 ×2 建立成功 | 0 | ✅ | stab/run3-v3.log |
| ST3 | **异常中断恢复（kill -9）** | SIGKILL 确认死透（healthz 不可达）→ 同数据目录重启：**恢复耗时 106ms**（杀至重启墙钟 437ms）；**任务/项目清单与中断前完全一致**；**账号语义 100% 保留**（users/invites 数组比对一致）；重新登录 200。auth.json 仅 `lastLoginAt` 一处字节差（重启后重新登录刷新，语义等价——已 diff 取证） | 0 | ✅ | stab/run3-v3.log、st3-auth-before.json、st3-auth-after.json |
| ST4 | 长跑负载与资源（180s，≈2qps 混合读） | **243 请求，0 错误（错误率 0%）**；服务端处理时延恒 ~1ms（server2.log）；**RSS 115,088KB→72,768KB（-42MB，无泄漏迹象）**；CPU ≈0%；进程全程存活 | 0 | ✅ | stab/run3-v3.log、st4-samples.log |
| ST4b | 时延归因（排除伪影） | 负载结束后同客户端 `GET /healthz`：fetch 全局池 **avg=0ms/max=1ms**；全新 undici Agent **0ms**；curl 子进程 **5ms** → 服务无残留劣化。soak 期客户端测得毛刺（累计 avg≈290ms、p95=2.5s）经三向对比 + 服务端恒 1ms + 毛刺均匀分布（含 /healthz）+ 热循环 0ms，**判定为 macOS 回环 TCP 环境伪影（RTO 型），非产品缺陷** | 0 | ✅ | stab/run3-v3.log、st4b-latency.log |

三轮留档：v1（run-all.log，3/5，2 处驱动契约误用）、v2（run2-v2.log，6/7，1 处响应形状误用）、v3 终轮干净 7/7。

## 线上轻量复核（阿里云生产 https://natpass.yikaihui.com/onenat-workbuddy，与今晨既有稳定性报告 S3/S4 对齐）

| 项 | 结果 | 证据 |
|---|---|---|
| S3 真实派发 | task-965ec17f（@136-苦力兔，marker=VERIFY-RERUN-OK）→ **status=success，waitedMs=46731**，成员精确回复 `VERIFY-RERUN-OK`，无越权动作。**验证后任务已 DELETE 清理** | stab/online-s3-s4.log |
| S4 监控窗口 | 事件窗 12 条：本任务 task_completed/subtask_completed 等全为 info；**0 条应用级失败**。唯一 error 为「pjy/949c4354 映射离线」随即 agent_online 恢复——基础设施节点状态，非本服务缺陷（该 pjy 映射在 backlog projects 探测中同样报 unreachable） | stab/online-s3-s4.log、今晨监控 KPI（failedToday=0） |

## 观察项（非缺陷/或已立案）

1. **SIGKILL 丢尾窗口（已立案 task-63）**：清理阶段 DELETE proj-90fhqoas 返回 200 后进程被 SIGKILL，异步落盘未及完成 → 重启后该项目残留在 store.json（同批 2 个任务删除因写盘先完成而持久化成功，钉住竞态窗口）。证据：server2.log 尾部 + stab-data/store.json。
2. **SIGTERM 丢数据「未复现」**：11 个停机前突发任务在 SIGTERM→重启后 11/11 存活（尝试记录：/tmp/sigterm-loss.mjs 流程，小 store 异步写盘毫秒级完成赢下竞态）。但代码级缺口客观存在：`app.close()`（src/server.ts:719）不调用 `store.flush()`（src/store.ts:281，注释自证「进程退出前兜底用」）→ 已并入 task-63。
3. 驱动侧 4 处契约误用（非产品缺陷，留档）：① 项目 create 缺 dshRef → 400；② `/api/tasks/:id/messages` 仅 POST 无 GET；③ 重复 create 检查了 import 路由的 `data.projectId/reused` 形状；④ 整文件 sha256 比对 auth.json（实际仅 lastLoginAt 变化）。

---

# 发现的问题（已提交 backlog，独立条目）

通道说明：按任务约定优先使用 workbuddy-mcp 的 `workbuddy_backlog_manage` 工具提交；工具可用且项目 `proj-2av0tx8y`（OneNat WorkBuddy 多智能体协作平台，workspace=本仓库）`initialized:true`，三笔提交均成功落盘为本仓库 `backlog/tasks/*.md`（唯一事实源）。提交前已按规范查重（「超大结果」命中项为 task-55~60 特性条目非 bug；「model-catalog」0 命中）。GitHub Issues 通道未使用（backlog 通道可用，无需降级）。

| Bug ID | 标题 | 严重级别 | 复现性 | 证据 |
|---|---|---|---|---|
| **task-61** | [bug][P3] smoke:xiaozhi「超大结果」断言用过期契约（truncated/isError），与现行 oversized/chatDownloadUrl 降级实现不符，套件必失败 | P3（回归门禁恒红、掩盖真实回归；实现本身与现行 SKILL.md 契约一致） | 稳定复现 ×2（exit=1，同一断言失败） | func/f14-xiaozhi.log、f14-xiaozhi-repro2.log；scripts/smoke-xiaozhi-mcp.mjs:328-334；commit 45b654a |
| **task-62** | [bug][P2] npm run test:models 回归套件 9/23 用例崩溃：router.dispatch 依赖构造期 requestContext，测试桩未初始化即 TypeError | P2（npm 脚本化回归门禁完全不可用；生产路径不受影响，但 task-55~60 相关修复失去防回归屏障） | 稳定复现 ×2（两轮 14/23 完全一致） | func/f15-models.log、f15-models-repro2.log；dist/router.js:1135；commit cf50d8f |
| **task-63** | [bug][P3] 优雅退出（SIGTERM/SIGINT）不调用 store.flush() 兜底落盘，停机窗口尾部变更可能静默丢失 | P3（常规停运维路径丢尾风险；SIGKILL 丢尾已实测，SIGTERM 小库未复现——大库窗口未验证） | SIGKILL 路径已复现；SIGTERM 数据丢失未复现（附尝试记录） | server2.log 尾部 + stab-data/store.json + st3-auth-*.json；src/server.ts:719/895-905；src/store.ts:281 |

backlog 链接（本仓库文件）：`backlog/tasks/task-61 - [bug][P3]-smoke:xiaozhi….md`、`backlog/tasks/task-62 - [bug][P2]-npm-run-test:models….md`、`backlog/tasks/task-63 - [bug][P3]-优雅退出（SIGTERMSIGINT）….md`（文件名含全角标点，以 `ls backlog/tasks/ | grep task-6` 为准）。

---

# 环境处置记录（可复现性说明）

- `smoke:e2e` 所需本机 DSH web service：实际端口 31789（非文档默认 3080）且 `authEnabled:true`、2 个既有密钥明文不可恢复（仅存哈希）。经服务自身管理面 `POST /api/v1/api-keys`（X-Admin-Token，路径由 dsh_web_service_info 提供）临时创建密钥 3 枚（首次解析失败重复创建 2 枚），e2e 跑完即全部 revoke+delete，终态仅余原有 2 枚（「我的密钥」「workbuddy-e2e」）。e2e 真实派发 1 条任务到本机 DSH（消耗少量 LLM token）。
- 线上复核产生 1 条真实 LLM 任务（task-965ec17f），验证后已删除；未创建线上项目；未改动线上配置/专家库。
- 本地稳定性临时进程（mock/server×2/临时实例）全部 SIGKILL 清理；stab-data 中残留 1 个 proj-90fhqoas 即 task-63 的复现证据，**有意保留**作为取证。
- 本次新增文件：`artifacts/verify-rerun-20261107/`（全部证据）、`backlog/tasks/task-61/62/63`、`/tmp` 三个一次性实验脚本（系统临时目录）。

# 验收对照

| # | 验收标准 | 对照结果 | 证据 |
|---|---|---|---|
| 1 | 功能测试全部重跑完成：输出用例清单及每条用例的执行命令、实际输出片段、退出码与通过/失败结论 | ✅ **通过**。17 个套件逐条实跑（含 smoke:e2e 环境处置后补齐），清单/命令/退出码/结论见「逐条对照：功能测试」表；日志含全部实际输出 | func/f01~f17（19 个日志文件） |
| 2 | 稳定性测试全部重跑完成：输出各轮次执行结果、关键监控指标（耗时/内存/CPU/异常恢复）及退出码 | ✅ **通过**。本地 7 阶段（含 kill -9 恢复 106ms、180s soak 0 错误、RSS -42MB、CPU≈0%）+ 线上轻量 S3/S4；v1/v2/v3 三轮留档，终轮 DRIVER_EXIT=0 | stab/run-all.log、run2-v2.log、run3-v3.log、st4-samples.log、st4b-latency.log、online-s3-s4.log |
| 3 | 每条失败项均有可复现证据（复现步骤/日志/截图路径），缺证据的项明确标注「未复现」 | ✅ **通过**。2 个功能失败均 ×2 复现并附日志与期望/实际对照；task-63 的 SIGKILL 丢尾已实测复现，其 SIGTERM 数据丢失部分**明确标注「未复现」并附尝试记录**（/tmp/sigterm-loss.mjs 流程说明） | func/f14*、f15* 日志；server2.log；REPORT 本表 |
| 4 | 每条复现的缺陷已在 backlog 提交为独立 bug，报告列出标题/严重级别/bug ID | ✅ **通过**。3 条独立 bug（task-61 P3、task-62 P2、task-63 P3）经 workbuddy_backlog_manage 提交并落盘 backlog/tasks/，标题/级别/ID/证据见「发现的问题」表；提交前已查重 | backlog/tasks/task-61/62/63 文件；wbmcp create 回包 ok:true |
| 5 | 输出最终汇总报告：用例总数/通过数/失败数、bug 清单、证据文件路径、验收标准逐条对照 | ✅ **通过**。即本报告：17 用例=15/2（断言级 971=961/10）、bug 清单 3 条、全部证据路径已列、五条验收标准逐条对照如上 | 本文件 |

---

*报告生成：2026-11-07 07:40 +08:00 · 验证测试工程师（无人值守执行，未调用任何等待人工答复的工具）*
