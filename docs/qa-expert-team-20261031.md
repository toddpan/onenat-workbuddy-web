# 在线体验与设计评审 —— 任务中 @专家 / @专家团（v2026.10.31）

- 日期：2026-10-31（21:00–22:40）
- 环境：阿里云线上 https://natpass.yikaihui.com/onenat-workbuddy/（v2026.10.31，9/9 DSH 节点在线）
- 方式：AI 令牌工具通道发真实任务（真实 LLM）+ Chrome 真实浏览器 UI 走查（wb-qa 会话）+ 代码级评审
- 测试节点：公司笔记本-DSH:31789（0c93ebda，即本机 Mac）；测试任务（4 个，含 1 个误建草稿）已全部 DELETE 清理，专家库零改动

## 一、结论速览

| 场景 | 结果 | 关键数据 |
|---|---|---|
| @单个专家（代码审查员，只读评审） | ✅ success | 规划 72.6s + 专家 109s + 主智能体核验 90s ≈ **200s**，coverage complete 2/2 |
| @专家团（技术方案评审团，3 专家并行评审） | ⚠️ partial_success **1/3** | 规划 100.7s；安全评审 253.8s 首增量（贴线过关），另 2 名 `turn stalled: no session events for 300s` 失败 |
| 手输 `@调研专家`（不带 #id） | ❌ 假同名歧义拒绝 | name==nameEn 专家被误判「多个同名角色」→ 静默降级主会话直发 |

流程主干（@ 弹层选人 → 发送 → 计划卡泳道 → 成员日志/会话/重试 → 覆盖度汇总）**功能闭环完整**，编排计划卡、专家动态实例化、coverage、团队合同快照（plan.scope）都按设计工作。但存在 **1 个 P0 执行链路 bug（并行 stall 无重试）**、**1 个 P0 交互陷阱（假同名歧义 + 静默降级）**，以及一批明显的体验/设计问题，详列如下。

---

## 二、实测记录

### 场景 A：@单个专家 ✅

`create(nodeRef=0c93ebda, message="@代码审查员 请对下面这段设计做一次只读代码评审…")`

- 提及解析：`mentionedExpertIds=[engineering-code-reviewer]` → 账本登记伪成员 `__expert__:engineering-code-reviewer`（新前缀），mode 升级 orchestrate。
- 规划：scope=`{kind:'members', memberIds:[伪id]}`，拆 2 个子任务（专家「执行设计只读评审」→ 主智能体 `__node__`「核验并汇总最终评审报告」，sequential）。
- 执行：专家在任务节点动态实例化（会话 permission=danger-full-access），产出 2375 字符；主智能体核验 90.2s 后产出最终报告。
- 汇总：coverage complete 2/2；finalConclusion 结构完整（问题清单→最小修改建议→总体结论）。
- 观察：**「核验并汇总」子任务与最终 summarize 阶段职责重复**——一份简单评审被做了三次 LLM 加工（评审、核验重写、再汇总），用户等待 200s 才看到首个结果。

### 场景 B：@专家团 ⚠️（本次评审最有价值的失败）

`create(nodeRef=0c93ebda, message="@技术方案评审团 请对下面这个方案做一次只读评审…")`

- 团队固化：`teamId=team-builtin-technical`，成员账本重置为 3 名专家伪成员，`plan.scope={kind:'team', memberIds:[3], team:<快照>}` ✓（合同快照设计生效）。
- 规划 100.7s → 3 子任务 **parallel**，同节点并发 3 个远端会话（同一模型 glm-5.3-flash）：
  - `security-appsec-engineer`：**253.8s 首增量**，产出 6335 字符 ✅（距 300s 停滞阈值仅 46s）
  - `engineering-software-architect` / `testing-reality-checker`：**300s 零事件**，被远端停滞看门狗收流 → failed ❌
- 汇总行为良好：如实标注「本次评审覆盖不完整，不能给出整体放行结论」「不编造失败成员结论」，coverage partial 1/3 且 missing 带归因。

**根因（已代码定位，双层叠加）**：

1. **超时参数失配（真 bug）**：workbuddy `streamPrompt` 只传 `timeoutMs`（`src/remote-client.ts:1331`），而 dsh-web-service 的 prompt-stream 端点读的是 **`stallTimeoutMs`**（dsh-web-service `src/streaming.ts:53`，缺省 300000）——workbuddy 设置的 1,800,000ms 在流式路径**完全无效**，停滞阈值恒为远端默认 300s。
2. **并行无并发预算**：`executeDag` 对同一批 ready 子任务 `Promise.all` 全并发（`src/engine.ts:2645`），3 个专家会话挤同一节点同一上游，首 token 延迟从单发 109s 恶化到 250s+，必然撞 300s 线。
3. **失败无自动重试**：`sse.remoteError && !sse.content` 直接快速失败（`src/engine.ts:3467` 一带）；「首轮无产出→按调度模型回退重试」的自愈分支条件是 `agent.provider || agent.model`（engine.ts ~2830），**专家伪成员两者皆空，自愈永不生效**；用户只能逐个点子任务「重试」，无一键重派失败成员。

### 场景 C：手输 `@调研专家`（无 #id）❌

- `expert-researcher` 等内置「团队角色」的 `name` 与 `nameEn` 同为中文（如「调研专家」），`extractMentions` 建词典时对 `[name, nameEn]` 各注册一次，同一专家被 push 进同一词条两次 → `Array.isArray(entry.data)` → 判为「同名多专家」拒绝召唤（`src/engine.ts:393-395`）。
- 系统提示「已拒绝召唤；请改用 @名称#id」后**不终止路由**，消息继续按「无 @」走主会话直发——实测该节点 LLM 上游恰有异常，任务 failed，用户看到的是一条无关的「节点上游异常」告警，**完全看不出是 @ 写法问题**。
- 影响面：内置 7 位团队角色专家（调研/需求/实现/验证/评审/修复/集成汇总）手输 @ 全部中招；用户自建专家 nameEn 缺省为空不受影响。

---

## 三、体验问题清单（UI 走查，按影响排序）

| # | 级别 | 问题 | 证据 |
|---|---|---|---|
| E1 | 高 | **专家团管理埋在 19,726px 深处**：专家管理页 = 328 行专家表 + 团队区同一滚动面板（panel scrollHeight 20,917px），「新建专家团」按钮与团队列表在页面最底部，页头文案「下方可组建专家团」形同虚设 | DOM 实测 team-list absTop=19726 |
| E2 | 高 | **@ 弹层 387 条扁平列表**：项目(22)→团队(5)→智能体(19)→资源→专家(328) 一次性渲染（2322 个 DOM 节点），无分组标题/类型筛选/计数/虚拟滚动；专家永远沉底，裸 @ 首屏全是项目 | `/api/mentions/candidates` 147KB、741ms；387 items |
| E3 | 高 | **弹层文案不提专家/专家团**：标题「提及项目、智能体或资源 (@)」、输入框占位「@ 项目 / 智能体 / 资源」——两大核心能力零露出，新用户不知道能 @ 专家 | web-ui.ts:2387 |
| E4 | 中 | **专家插入带 `#engineering-code-reviewer` 机器 id**：UI 选专家固定追加 `#id`（`@代码审查员#engineering-code-reviewer `），消息正文被技术噪音污染；但 328 位专家实测 0 真重名，#id 绝大多数场景无必要 | insertMention web-ui.ts:8404-8411 |
| E5 | 中 | **专家/团队管理对 AI 通道完全缺失**：工具通道 14 个工具无 team_manage；AI 令牌开放面不含 /api/experts、/api/teams、/api/mentions/candidates → AI 助手能 @团队 却不能列举/创建/启停团队（SKILL 文档宣称支持 @专家团名，但 AI 无从得知团队名） | tool-ops.ts 14 工具；server.ts:690 白名单 |
| E6 | 中 | **团队卡「发任务」直接落地空草稿**：点击即 POST /tasks 创建 draft 任务并跳转，输入框无团队上下文提示（仅 toast 一闪），用户放弃即留空任务污染列表（本次实测误建 1 个已清理） | web-ui.ts:11006-11013 |
| E7 | 中 | **计划卡把专家成员标成「场外成员」**：专家实际动态实例化在任务节点执行，标签却是「场外成员」（子智能体语义），纯误导 | web-ui.ts:6819 |
| E8 | 中 | **覆盖度无结构化 UI**：coverage 只以 `📋 成员覆盖度: 部分覆盖（1/3）` 文本出现在汇总里；计划卡泳道不显示覆盖状态，失败成员无「一键重派」 | engine.ts:2575-2587 |
| E9 | 中 | **新建专家团默认停用**：`parseTeamInput` enabled 缺省 false，UI 保存后无「未启用不可 @」提示；停用团在 @ 词典与候选里双过滤，@ 团队名会被当普通文本静默直发 | expert-teams.ts:225；web-ui.ts:11136 |
| E10 | 低 | 定时任务表单 @ 联想只认 agent/资源两类样式，专家/团队/项目被渲染成「资源」；每键入一次全量重拉 candidates | web-ui.ts:11627-11630, 11665 |
| E11 | 低 | 专家详情「查看」渲染成可编辑表单样式（禁用输入框 + 仅「取消」按钮），无「复制为我的专家」「实例化为子智能体」入口——`POST /api/experts/:id/instantiate` 后端已有但**前端零调用** | router.ts:2354；web-ui.ts grep 无 instantiate |
| E12 | 低 | 单专家简单任务延迟翻倍：规划 72.6s + 核验子任务 90s，而「核验」与最终 summarize 职责重复 | 场景 A 时间线 |

---

## 四、设计评审：不合理点与优化方案

### D1【P0·执行链路】停滞看门狗失配 + 并行无预算 + 失败无重试（场景 B 根因）

**现状**：专家团 = N 个纯人格专家**全部实例化在同一个任务节点**、同一模型并发开跑；停滞阈值被远端硬编码 300s（workbuddy 传参失配）；stall 类失败既不自动重试也不降级串行。

**优化方案**：
1. `remote-client.ts streamPrompt` 补传 `stallTimeoutMs`（建议 `max(remoteTimeoutMs/3, 600_000)`，或按成员数放大：`300s + 150s × (members-1)`）——dsh-web-service 侧已支持该入参，一行改动；
2. `executeDag` 增加每节点并发预算（建议默认 2，`ready` 批内分批 `Promise.all`），团队轮可读团队人数自适应；
3. stall/超时/网络类错误自动重试 1 次（错峰重发），仍失败再标 failed；把「模型回退自愈」条件从 `agent.provider||agent.model` 放宽到**专家伪成员也可回退调度模型**；
4. 计划卡失败泳道加「↻ 重派全部失败成员」（顺序化逐个重试，结束时只做一次 summarize）。

### D2【P0·交互陷阱】假同名歧义 + 拒绝后静默降级（场景 C 根因）

**优化方案**：
1. `extractMentions` 词条按专家 **id 去重**（`experts.push` 前查重），name==nameEn 不再产生假同名；
2. `mentionedExpertAmbiguous` 命中时**不要落入无 @ 直发分支**：追加系统提示后应终止本轮或要求澄清（「请用 @名称#id 或从弹层选择」），至少在系统轮给出可操作指引并标注「本轮未派发给任何专家」；
3. UI 弹层继续带 #id（保底精确），但 D2-1 落地后可改为**仅同名时带 #id**（见 E4）。

### D3【P1·信息架构】专家与专家团的管理面重构

**现状**：328 行表 + 团队区同页深埋（E1）；专家详情无任何转化动作（E11）。

**优化方案**：
1. 专家管理页改 **Tab 结构**：「专家库（可搜索分页表格）」/「专家团（卡片列表）」，团队 Tab 默认展示内置 5 团 + 自定义团；
2. 专家行操作补齐三件套：**👁 查看 / 🎓 复制为子智能体（调 instantiate 端点，选节点+工作目录）/ 🚀 用此专家发任务**（预填 `@名称` 跳工作台草稿）；
3. 团队卡成员 chip 点击弹出「成员合同预览」（duty + instructions + 将注入的五段回传），让用户发任务前知道每人会干什么——当前合同只存在于提示词里，UI 不可见。

### D4【P1·发现性】@ 弹层与文案（E2/E3/E4/E10）

**优化方案**：
1. 弹层加**分组标题 + 计数**（项目 22 / 专家团 5 / 智能体 19 / 专家 328…），支持 `@专家:` `@团:` 等类型前缀过滤（或 Tab 切换）；
2. 渲染上限 50 条 + 「输入关键字继续搜索」占位（虚拟滚动可选）；查询改为**前缀匹配优先 + 计数徽标**，detail 不再参与匹配（消除「工程」命中 99 条的噪音）；
3. 标题/占位文案补齐：「提及项目、专家、专家团、智能体或资源 (@)」；
4. 专家插入 `#id` 仅在**同名冲突时**追加（读 candidates 里同名数），常规插入干净的 `@名称`；
5. 定时任务表单复用主弹层的分组渲染（消除 E10 样式错乱）。

### D5【P1·语义一致性】编排与团队的边界语义

**现状**：三处口径不一致：
1. **项目指令不进编排**：`exec.instruction` 只注入 chat 直发 sysPrefix（engine.ts:1680），runSubtask 的 parts 无项目指令——**项目任务一旦 @专家/@团队（必然走编排），成员拿不到项目规范**（工作目录有、指令没有）；
2. **团队首句与 @ 成员冲突**：团队草稿任务首条消息即使显式 @ 单个成员，`teamFirstTurn`（engine.ts:1052）仍强制团队轮，coverage 按全员 3 人算 → 另 2 人被误报「未分配子任务」；
3. **coverage 口径漂移**：普通轮 memberKeys=实际参与者（含 `__node__`，单专家任务显示「2/2」虚胖）；团队轮=名册全员（未分配即缺口），且「未分配」与「失败」共用 missing.error 文案。

**优化方案**：
1. runSubtask 在 chat/编排两路径统一注入 `[项目指令]` 段（与 sysPrefix 同源，`exec.instruction`）；
2. `teamFirstTurn` 收窄：首条消息若带显式 @（成员/专家），按**聚焦轮**处理（scope=members），仅无 @ 时才按团队合同；团队合同提示语相应改「未指定成员时按全团编排」；
3. coverage 结构化：missing 拆 `reason: 'unassigned'|'failed'|'skipped'`；普通轮剔除 `__node__` 或单独显示「执行步骤 2/2 · 成员覆盖 1/1」双口径；前端在计划卡头部渲染 coverage 徽标（E8 一并解决）。

### D6【P1·能力面】AI/自动化通道补齐团队管理（E5）

**优化方案**：
1. 新增第 15 个工具 `workbuddy_team_manage`（list/get/upsert/delete/toggle，内置团只读守卫复用 router 逻辑），同步进 SKILL 子技能（skills/experts.md 或新增 teams.md）；
2. `isAiTokenAllowedPath` 放行 `GET /api/teams`、`GET /api/experts`（只读）与 `/api/mentions/candidates`（或提供 `workbuddy_mention_candidates` 工具）——AI 发任务前能自己查「有哪些团/哪些专家」，而不是靠猜名字；
3. 工具 `expert_manage list` 已分页，REST `/api/experts` 全量 165KB 建议同样补 `limit/offset` 并给前端换成分页拉取。

### D7【P2·安全与治理】

1. **专家默认权限过大**：`DEFAULT_PERMISSION='danger-full-access'`（engine.ts:28），纯提示词的「只读评审」角色实际拥有节点完全访问权，只靠提示词自律。建议：专家/团队任务默认收窄到 workspace-write 或提供团队级 `permission` 字段（内置评审团可标 `read-only`），执行前 UI 展示将下发的权限档位；
2. **用户专家无归属隔离**：`user-experts.json` 全局共享（expert-store.ts），多用户环境任何人可改/删他人专家，且被团队引用的专家删除后团队到发任务时才报错。建议：user 专家加 `owner`，团队保存/列表时预检成员可用性并标黄；删除被引用专家前提示引用方；
3. **团队删除抹历史**：`store.deleteTeam` 摘除历史任务 teamId（store.ts:463-466），团队徽标与追溯丢失（plan.scope 快照仍在，但 task 级语义断了）。建议改软删（archived 标记）或仅对新任务生效；
4. **团队编辑无版本**：POST 整体替换、无 revision；当前靠 plan.scope 快照保护在途任务，建议给团队加 `revision` 并在团队卡显示「最近修改」，避免多人协作互踩。

### D8【P2·成本与体验细节】

1. 单专家「核验并汇总」子任务（E12）：规划器对单成员聚焦轮允许产出**单子任务**（跳过 `__node__` 自留），最终汇总保留——省一跳 90s；或 `__node__` 核验仅对「多成员/有依赖」轮启用；
2. 专家库元数据：328 位全部无 tags、索引无 role，标签列/标签搜索形同虚设——build-expert-assets 时从简介抽取关键词回填；@ 弹层专家 detail「专家 · 分区 · 在本任务节点执行」信息量低，建议换成一短语职责摘要；
3. 团队卡「发任务」改为**先弹轻量对话框**（目标 + 节点选择 + 成员确认），确认后才建任务；取消不留草稿（E6）；
4. `/api/mentions/candidates` 增加轻量模式（仅 id/name/type/kind，detail 按需），前端首次加载即用轻量模式——147KB/741ms 的全量载荷在移动端/弱网明显。

---

## 五、建议落地顺序

| 批次 | 内容 | 预估改动面 |
|---|---|---|
| 第一批（止血） | D1-1 stallTimeoutMs 透传、D1-3 stall 自动重试、D2-1 假同名去重、D2-2 歧义终止路由 | remote-client.ts / engine.ts，小 |
| 第二批（体验） | D3 Tab 重构 + 专家行三件套、D4 弹层分组与文案、E6 团队发任务对话框、E7/E8 计划卡标签与覆盖度徽标 | web-ui.ts 为主 |
| 第三批（能力） | D5 语义三修正、D6 team_manage 工具 + AI 令牌只读面、D7 权限档位与归属 | engine/router/tool-ops/server |

## 六、测试遗留状态

- 测试任务 4 个（单专家/专家团/歧义探测/团队空草稿）已全部 DELETE，专家库与团队零改动；
- 本轮发现的 stall 复现条件依赖节点上游负载（3 并发首 token >250s），若复测建议换 brain-DSH:3080 或降低成员数验证 D1 修复效果；
- 场景 B 的失败汇总质量值得保留为回归基准：「不编造失败成员结论 + coverage 归因」行为正确，修复 D1 后应复测汇总口径不变。

---

## 七、修复交付与线上验证（2026-11-01，v2026.11.1 已部署）

第二日按 §五 批次完成修复并部署线上（deploy-standalone.sh 增量 7 文件 + web-ui 两次追补，远端 package.json 版本同步 2026.11.1，healthz/MCP 验证通过；本地 typecheck ✅ / 单测 97/97 ✅ / 冒烟 70 项 ✅ / 构建 ✅，含 5 个新增回归单测与 3 处冒烟断言更新）。

### 已落地修复（对应本文 §三/§四 编号）

| 项 | 修复 | 落点 |
|---|---|---|
| D1-a | `streamPrompt` 透传 `stallTimeoutMs`（=remoteTimeoutMs 30min；参数失配根除） | remote-client.ts |
| D1-b | stall 类远端 error 不再快败 → 转轮询对账等远端终态（Turn Job 语义核心） | engine.ts dispatchWithFallback |
| D1-c | `executeDag` 每节点并发预算（默认 2，`WB_NODE_MAX_CONCURRENT_TURNS` 可调） | engine.ts |
| D2-a | 专家词条按 id 去重（name==nameEn 假同名根除） | engine.ts extractMentions |
| D2-b | 歧义阻断路由：本轮标 failed + 可操作指引，**不再静默降级直发** | engine.ts processUserMessage 入口 |
| D5-1 | 编排子任务注入项目指令（与 chat 同源）+ 注入日志可观测 | engine.ts runSubtask |
| D5-2 | `teamFirstTurn` 让位显式 @（提及解析前置，含 @项目/@团队/@成员） | engine.ts sendUserMessage |
| D5-3 | coverage 剔除 `__node__` + 缺口 reason 三分类（unassigned/failed/skipped） | orchestrator.ts / types.ts |
| D5-4 | 单成员聚焦轮恰好 1 子任务（规划提示词 + 引擎裁剪双保险），省 90s 核验跳 | orchestrator.ts / engine.ts |
| E1 | 专家团区块前置（原埋在 328 行表下 ~2 万 px），页改版「专家与专家团」 | web-ui.ts |
| E2 | @ 弹层分组浏览（五分组+计数+截断提示，空查询渲染 387→32 条）+ 查询上限 60 | web-ui.ts |
| E3 | 弹层标题/占位/空态文案补「专家、专家团」 | web-ui.ts |
| E4 | 专家 `#id` 仅同名冲突时插入 | web-ui.ts（主弹层+定时任务） |
| E5 | 第 15 个工具 `workbuddy_team_manage`（list/get/upsert/delete/toggle+内置守卫）+ AI 令牌 GET 只读面（teams/experts/candidates） | tool-ops.ts / server.ts |
| E6 | 团队卡「发任务」改对话框：目标必填+成员预览+节点显示，确认才建任务（空草稿消灭） | web-ui.ts |
| E7 | 计划卡专家成员标签「专家 · 任务节点动态实例化执行」（原误导「场外成员」） | web-ui.ts |
| E8 | 计划卡覆盖度徽标（含缺口 tooltip） | web-ui.ts |
| E9 | 新建专家团默认启用（服务端+前端） | expert-teams.ts / web-ui.ts |
| E10 | 定时任务 @ 联想按提及类型渲染（专家/团队/项目不再伪装资源） | web-ui.ts |
| E11 | 专家行「🚀 任务」预填 @名称 + 查看弹窗「📋 复制为我的专家」（copy-on-write 一键） | web-ui.ts |

未含（按方案为独立里程碑）：Mention Registry 完整版（规范 token/候选卡 UI）、TaskContext 全量构造器统一、TurnIntent 状态机抽离、权限档位/归属/软删（需 dsh-web-service D-3 readonly 档）、Turn Job 全量（需 D-1 幂等键/D-2 stall 降格与 phase 事件）。

### 线上验证矩阵（阿里云生产，AI 令牌 + Chrome 真实浏览器，全部通过）

| 验证 | 结果 | 证据 |
|---|---|---|
| 工具面 | ✅ 15 工具含 `workbuddy_team_manage` | GET /api/tools |
| AI 令牌只读面 | ✅ /api/teams、/api/experts、/api/mentions/candidates 均 200 | GET |
| ① 假同名 `@调研专家` | ✅ 直召唤入账本（昨日误拒）→ 任务 success | expertMembers=`__expert__:expert-researcher` |
| ② 单专家单跳 | ✅ **恰好 1 子任务**（核验跳消失）coverage 1/1 | plan.subtasks |
| ③ @技术方案评审团 3 成员 | ✅ **3/3 completed，coverage 3/3，0 停滞**（昨日 1/3 双停滞）；并发预算 2 生效（2+1 两波） | 首增量 169.6s/114.7s/196.9s（昨日 253.8s/300s×2） |
| ④ team_manage 闭环 | ✅ list→upsert(默认启用)→toggle 停/启→delete→内置只读拒绝 | 工具调用 |
| ⑤ 项目指令注入 | ✅ 子任务日志「已随子任务注入项目指令（816 字）」，成员回复引用指令内容 | 任务日志+汇总 |
| UI 弹层 | ✅ 分组头（项目·22/专家团·5/…/专家·328）+截断提示；渲染 387→32；新文案 | DOM 实测+截图 |
| UI 团队对话框 | ✅ 目标预填/成员 chips/节点名显示；确认才建任务（无空草稿） | 弹窗实测+截图 |
| UI 专家页 | ✅ 团队区前置（177px vs 19726px） | DOM order |
| UI 计划卡 | ✅ 「覆盖 3/3」徽标 + 团队徽标 + 专家标签三处 | 计划卡实测 |
| UI 端到端 | ✅ 对话框发起→任务以目标为标题→success | task-492e7d7c（已清理） |

测试任务 5 个全部 DELETE，团队/专家库零残留（team_manage 临时团已删）。

### 环境备注（与本次改动无关，待处置）

1. **公司笔记本-DSH:31789（0c93ebda）映射 key 失效**：目录在线但派发 401（昨日同映射可用；natpass 端口 36898→37165 漂移后节点侧凭证不匹配）。本次验证全部切换 brain/KB136 节点完成。处置方向：恢复本机 dsh-web-service 与 ONENAT 映射 credentials 的一致性（或等端口再漂移自愈）。
2. store.test 归档用例存在偶发时序 flake（归档文件防抖落盘读取早写），重跑即过，与本次改动无关。
