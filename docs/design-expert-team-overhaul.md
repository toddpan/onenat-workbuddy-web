# 专家 / 专家团彻底重构方案（Overhaul Design）

- 日期：2026-10-31
- 前置：`docs/qa-expert-team-20261031.md`（线上实测 + 设计评审，问题清单 E1-E12 / D1-D8）
- 定位：**不接受兜底**。本文给出的不是补丁清单，而是五项根抽象（Root Abstractions），每一项都从机制上消灭一类问题，而不是缓解一次故障。凡属节点侧能力缺失（dsh-web-service），一律列为正式依赖项要求实现，不在 workbuddy 层绕行。

---

## 0. 设计原则（为什么这是彻底解）

| 原则 | 含义 | 消灭的问题类别 |
|---|---|---|
| **P1 生命周期与传输解耦** | 失败判定权从 SSE 流收回执行层：回合是作业（Turn Job），流只是观察通道 | 停滞误杀、断流丢结果、无重试 |
| **P2 提及即实体引用** | 消息中的 @ 在落库时固化为无歧义的结构化 token，解析基于单一实体注册表 | 假同名、#id 噪音、静默降级、弹层无分组 |
| **P3 单一上下文构造器** | chat 直发 / 编排派工 / 定时任务共用同一 TaskContext 构造路径 | 项目指令丢失、两套注入漂移 |
| **P4 意图显式状态机** | 每一轮的编排语义由显式 intent 决定，优先级固定、口径唯一 | teamFirstTurn 压制 @、coverage 口径漂移、单专家三跳 |
| **P5 能力声明与强制** | 权限/并发/模型/归属都是声明的属性并被系统强制执行，不靠提示词自觉 | danger-full-access 过宽、并行无预算、无归属隔离、删除抹史 |

当前所有 P0/P1 问题的共同根因：**workbuddy 把「执行」「提及」「上下文」「意图」「能力」五件事都散落在路径分支里，没有实体化**。本方案把五件事各收敛为一个一等公民。

---

## 1. Turn Job：回合即作业（根因 A：300s 停滞误杀）

### 1.1 为什么现有修法都是兜底

- 透传 `stallTimeoutMs` 并调大到 10min → 只是把误杀线后移，慢模型/弱网仍会撞线；
- stall 后自动重试一次 → 重发 prompt 会造成远端双跑（原回合可能还活着）；
- 并发上限 2 → 只是降低撞线概率，单发慢模型照样会被 300s 杀死。

这三条的共同缺陷：**「300s 没收到事件」这个传输层观测，被当成了执行层终态**。只要这个语义存在，任何参数都是在选「误杀率」和「挂死率」之间的点。

### 1.2 目标设计

**回合作业模型**（workbuddy `engine` + `remote-client`）：

```ts
interface TurnJob {
  id: string                    // 幂等键：`${subtaskId}:${turnSeq}`（重试/重挂不产生新键）
  taskId: string
  sessionId: string
  state: 'queued' | 'dispatching' | 'observing' | 'reconciling'
      | 'done' | 'failed' | 'cancelled'
  phase?: 'queued' | 'started' | 'generating' | 'tooling' | 'finalizing'   // 来自远端事件
  startedAt: number
  firstEventAt?: number
  endAt?: number
  error?: { kind: 'remote_turn_error' | 'node_unreachable' | 'cancelled', message: string }
}
```

**关键规则**：

1. **终态只能由三种东西产生**：远端回合的显式 `turn_end`（成功/业务失败）、节点不可达（连接层失败）、用户/系统取消。**SSE 断流、停滞、超时一律不是终态**，只触发 `observing → reconciling` 迁移。
2. **reconciling = 以远端会话为唯一事实源**：轮询 `GET /sessions/:id` 状态 + `history` 按回合起点对账（复用现有 `reconstructTurnFromHistory`）。远端仍在跑就继续等；远端显式 error 且零产出才判 failed。现有的「SSE 静默 10min → 转轮询对账」已经走在这条路上，本方案把它从**降级路径**升格为**唯一路径**：streamPrompt 的任何异常出口都汇入 reconciling，不再有「直接 return error」的旁路（消灭 `sse.remoteError && !sse.content` 快败分支）。
3. **幂等重放**：prompt 请求体携带 `idempotencyKey`（dsh-web-service 正式依赖项 D-1）：远端以键登记回合，同键重复提交返回**进行中的同一回合**而不是双跑。这样「重试」= 同键重新 attach（重建 SSE 或转轮询），语义干净。
4. **停滞看门狗降格**（dsh-web-service 正式依赖项 D-2）：prompt-stream 的 stall 看门狗触发时不再发致命 `error` 帧，改为发 `phase: 'stalled'` 通知帧并保持流开启（或由客户端主动断流入 reconciling）；同时补发阶段事件 `queued / started / first_token`，让「排队等待上游」对 workbuddy 可见。300s 数值保留，但语义从「判死」变为「建议切换观察通道」。
5. **并发预算**（消灭「并行无预算」）：

```ts
// orchestrator 新增
interface NodeCapacity { mappingId: string; maxConcurrentTurns: number; inflight: number }
```

`executeDag` 改为**带许可的调度循环**：ready 批内按目标节点获取许可（默认 2，可在节点能力档案/设置页配置），无许可的子任务保持 pending。团队轮成员数 > 预算时自动分段派发，UI 计划卡如实显示「分段并行」。这比「全局限并发」正确：瓶颈在节点而不在任务。

### 1.3 为什么这是彻底解

失败语义被重新定义：**不存在「停滞 = 失败」这个状态**。慢模型、弱网、端口漂移都只是观察通道切换；任务要么真实完成、要么真实业务失败、要么被取消。300s 问题这一类别整体消失，而不是被更大的数字掩盖。

---

## 2. Mention Registry：提及即实体引用（根因 B：假同名 / #id / 静默降级 / 弹层混乱）

### 2.1 为什么现有修法是兜底

- 词条按 id 去重 → 修掉假同名这一个 bug，但「@名称」仍是脆弱的文本匹配，下一个重名/别名场景还会出问题；
- 歧义时终止路由 → 用户被卡死，没有前进路径；
- 弹层少插 #id → 治标，同名时还得靠用户手敲。

### 2.2 目标设计

**2.2.1 单一实体注册表**（`src/mention-registry.ts`，新模块）：

```ts
interface MentionEntity {
  type: 'agent' | 'team' | 'project' | 'expert' | 'resource'
  id: string                    // 稳定 id（专家用 expertId，非伪 id）
  displayNames: string[]        // name + nameEn + 别名，构建时去重
  meta: { divisionZh?; nodeLabel?; memberCount?; disabled?: boolean }
}
class MentionRegistry {
  snapshot(): MentionEntity[]                    // 惰性构建，实体增删改时 invalidate
  resolve(text: string): MentionResolution       // 唯一解析入口（extractMentions 改为委托）
  candidates(q?: string, types?: string[], limit=50): { groups, total }
}
```

词典构建、@ 扫描、候选弹层接口**三处共用同一注册表**——弹层看到什么，引擎就能解析什么，永不漂移（今天「候选 387 条 vs 引擎自有词典」是两套代码）。

**2.2.2 规范提及 token**：落库的 turn.text 中，提及统一固化为一等 token：

```
@[expert:engineering-code-reviewer|代码审查员]
```

- 前端选人即插入规范 token，**渲染为 chip**（显示名），#id 后缀从用户视野消失；
- 纯文本 `@名称` 仍是合法输入（兼容手打/语音/API），解析命中后引擎在**存储层**将其改写为规范 token（用户原文保留在 `rawText` 字段）；
- `@名称#id` 旧语法永久兼容读取。

**2.2.3 歧义 = 交互卡，不是错误也不是降级**：解析出现多候选时，返回结构化 `mention_resolution` 系统轮（候选卡片，点选即把 token 补全重发）；API/工具调用方收到结构化错误 `MENTION_AMBIGUOUS{candidates}`（HTTP 422 语义），**任何路径都不再落入「无 @ 直发」**（消灭静默降级这一类别）。

**2.2.4 弹层协议重做**：`GET /api/mentions/candidates?q&types&limit` 走注册表，首屏分组（项目/专家团/智能体/专家，各带计数，各取前 8）≈ 8KB；专家详情（职责摘要）按需拉取。前端虚拟滚动 + 类型过滤 token（`@专家:` `@团:`）。**弹层标题/占位文案从协议生成**，新增实体类型自动带上，不再出现「文案没提专家」。

### 2.3 为什么这是彻底解

歧义只可能发生在「用户正在打字」的瞬间，且以候选卡当场解决；一旦成为 token，系统内流转的提及永远无歧义、无后缀噪音。「同名」「别名」「文案漏更新」三个问题类别同时消失。

---

## 3. 统一 TaskContext 构造器（根因 C：项目指令不进编排 / 注入漂移）

### 3.1 目标设计

`src/task-context.ts` 新模块，**唯一**的成员上下文组装路径：

```ts
buildMemberPromptContext(task: WorkTask, member: ResolvedMember): {
  roleSection        // persona（子智能体 persona / expertPersona）
  instructionSection // 项目指令 exec.instruction ← 今天编排路径缺失的那段
  workspaceSection   // 工作目录 / 跨机指引
  skillsSection      // /技能 手势（composer 产物）
  connectorSection   // SSH 连接器 / 资源绑定
  permissionSection  // 生效权限档位（见 §6）
  interactionSection // 值守模式守卫
}
```

- `runChatTurn`（直发）与 `runSubtask`（编排/直派/定时）都调用它，**禁止各自拼 parts**；
- 单测锁定：同一 mock task 下，两条路径生成的段集合逐段断言一致（防回归复现今天的漂移）；
- 合同段（团队 `[专家团协作]`、上游产出、任务合同）仍由调用方按语义追加——上下文（who/where/what-rules）与合同（本轮任务）分离。

### 3.2 为什么这是彻底解

「项目任务一编排就丢项目指令」不是补一个 `parts.push(exec.instruction)` 能解决的——那是下次新增段时再漂移一次的邀请。收敛为单一构造器后，**「某类执行路径缺某类上下文」在结构上不可能发生**。

---

## 4. 轮级意图状态机（根因 D：teamFirstTurn 压制 @ / coverage 口径漂移 / 单专家三跳）

### 4.1 目标设计

```ts
type TurnIntent =
  | { kind: 'direct' }                                          // 主会话直发
  | { kind: 'delegate'; memberIds: string[] }                   // 单成员聚焦（含单专家）
  | { kind: 'orchestrate'; memberIds: string[] }                // 多成员编排
  | { kind: 'team'; teamId: string; roster: MemberRef[] }       // 团队合同轮

resolveTurnIntent(task, mentions, opts): TurnIntent   // 优先级固定，唯一实现
```

**优先级（写死，注释进代码）**：
1. 显式 @ 成员/专家（非团队）→ delegate / orchestrate；
2. 显式 @ 团队 → team；
3. 任务携带 teamId **且本句无任何提及且是首句** → team（保住「团队卡发任务 → 首句按合同」语义，同时不再吃掉显式 @）；
4. 默认 direct。

**coverage 跟随 intent**（单一口径函数）：
- team 轮 = 团队名册全员；orchestrate/delegate 轮 = 本轮 intent 名册（**剔除 `__node__`**，主智能体自留不计入「成员覆盖」）；
- gap 结构化：`{ reason: 'unassigned' | 'failed' | 'skipped', error? }`，前端徽标渲染三种缺口；
- **单专家不再强制三跳**：delegate 意图下规划器花名册只有被 @ 成员，`validatePlanDraft` 规则 2（主智能体必须自留）收窄为**仅 orchestrate 且子任务 >1 时生效**；delegate 轮 = 1 个子任务 + summarize 承担汇总。2026-10-13 拍板「主智能体不空转」的初衷由 orchestrate 轮保留，单成员场景的 90s 核验跳被消灭。

**coverage 结构化上浮**：`/api/tasks/:id` 返回 coverage 对象；计划卡头部渲染徽标（complete/partial/failed + 缺口明细）；缺口行带「重派」按钮，团队轮提供「重派全部失败成员」（顺序化执行，结束只做一次 summarize）。

### 4.2 为什么这是彻底解

今天「单 @ 直派退役为规划分工」「团队首句桥接」「coverage 双口径」是三次独立演化叠加的分支逻辑；状态机把轮级语义收敛为**一个可枚举、可断言的决策表**。每条优先级都有单测锁定，新增意图只能扩展枚举，不能再悄悄改写路由。

---

## 5. 协作者域 IA 重构（根因 E：19726px / 三处定位混乱 / 空草稿）

### 5.1 目标设计

**5.1.1「协作者中心」**：专家管理页重构为三 Tab（沿用既有 switchView 机制）：

```
协作者中心
├─ 🤖 子智能体（既有列表，不动）
├─ 🧠 专家库（分页表格：分区筛选 / 搜索 / 来源徽标）
│   行操作：👁 查看 · 🎓 实例化为子智能体 · 🚀 用此专家发任务 · ➕ 加入团队
└─ 🧩 专家团（卡片列表，**默认 Tab 与专家库平级，不再垫底**）
```

- 「实例化为子智能体」即调通现有 `POST /api/experts/:id/instantiate`（打开抽屉预填人格 + 选节点 + 选工作目录）——后端已有，补 UI 即可；
- 「用此专家发任务」= 前端草稿预填规范 token `@[expert:id|名]` 跳工作台，**不 POST 任务**；
- 专家详情（查看）改为只读排版（非禁用表单），附「复制为我的专家」（copy-on-write 一键）。

**5.1.2 团队任务对话框**：团队卡「发任务」不再直接 POST /tasks，弹出轻量对话框：

```
目标（textarea，必填）
执行节点（沿用执行位置选择器；纯专家团必选）
成员确认（chip 列表 + 每人 duty 一句话 + 「预览合同」折叠区展示将注入的合同全文）
[取消] [发起编排]
```

确认才创建任务并携带首句 → 天然无空草稿（草稿类问题类别消失）。用户放弃=零副作用。

**5.1.3 新建团队默认启用**：`parseTeamInput` enabled 缺省改 true（或表单显式勾选 + 保存后 toast 带状态徽标）。停用是高级操作，不该是默认态。

### 5.2 为什么这是彻底解

「专家团找不到」「空草稿堆积」「实例化入口缺失」都是「管理面结构与实体模型不匹配」的症状。实体模型已经是三层（agent/expert/team），管理面收敛为同构三 Tab + 每实体完整动作集后，不会随功能增长再长出第四个藏功能的角落。

---

## 6. 能力声明与强制（根因 F：danger-full-access / 无归属 / 删团抹史 / 人格漂移）

### 6.1 权限档位成为一等属性

```ts
// types.ts
type PermissionLevel = 'readonly' | 'workspace-write' | 'full'
Agent.permission?: PermissionLevel
ExpertProfile.maxPermission?: PermissionLevel      // 专家档案声明上限（roster 评审类默认 readonly）
Team.permission?: PermissionLevel                  // 团队级上限
Task.permission?: PermissionLevel                  // 任务级
effective = min(task, member, memberPersona.max)   // 取最严
```

- 执行前 `PUT /sessions/:id/permission` 原生下发（复用现机制）；**dsh-web-service 正式依赖项 D-3**：harness permissionPresets 增加 `readonly` 档（工作区只读挂载 + 禁写工具），节点不支持的版本在节点能力档案里标 `readonlySupported:false`，编排器对含 readonly 成员的团队在该节点**拒绝派发并给出可操作文案**（而不是悄悄用 full 跑）——「不支持就明说，不静默放行」正是本方案的原则；
- 内置 5 团 constraints「仅进行分析评审」同步固化为 `permission:'readonly'`，**从提示词自律升级为系统强制**；
- 发任务对话框与团队卡显示生效档位徽标。

### 6.2 归属、软删、引用完整性

```ts
// store 数据模型扩展（迁移见 §8）
UserExpert { owner: username, visibility: 'private' | 'shared', archived?: boolean }
ExpertTeam { owner: username, archived?: boolean, revision: number }
```

- 列表按 `visibility` 过滤（shared 全员可见，private 仅 owner）；@ 注册表同口径；
- **删除改归档**：`archiveExpert/archiveTeam` 置 archived，历史任务引用原样保留（消灭 deleteTeam 摘 teamId 的抹史语义）；真删仅允许无引用时执行，否则 409 + 引用清单（哪些团队/在途任务引用了它）；
- 团队 `revision` 随保存递增，任务 plan.scope 记录 `teamRevision`，UI 显示「按 v3 合同执行」，多人协作不再互踩也不可抵赖。

### 6.3 专家人格快照（任务可复现）

`plan.scope` 扩展：

```ts
scope.memberSnapshots?: Record<pseudoId, {
  persona: { role; systemPrompt; executionPrompt }
  revision: string        // buildExpertSource 同源 sha1
}>
```

所有动态专家成员（不止团队轮）在**规划落盘时**快照人格；runSubtask 优先读快照，缺失（存量任务）回退现状读档案。修改专家档案不再影响在途任务与重试——「同一次任务重跑得到同一个人格」成为不变量。团队合同快照（现状已有）与人格快照补齐后，**任务级复现性完整**。

### 6.4 为什么这是彻底解

「只读评审团拿满权限」「谁都能删共享专家」「改档案影响在途任务」都是「能力/归属/版本没有实体化」的表现。声明 → 最严者生效 → 原生强制 → 不支持则拒绝，四步闭环后不再依赖任何一方自觉。

---

## 7. AI / 自动化通道补齐（根因 G：AI 无团队管理 / 载荷过重）

1. **第 15 个工具 `workbuddy_team_manage`**：`list/get/upsert/delete/toggle`（内置团只读守卫复用 router 逻辑），SKILL 增补子技能 `skills/teams.md`；
2. **AI 令牌开放面分档**：只读面默认放行 `GET /api/teams`、`GET /api/experts`、`GET /api/mentions/candidates`（写面维持现状）——AI 发任务前能自查「有哪些团/哪些专家/每人职责」，@ 协作者从猜名字变为可决策；
3. candidates 走注册表轻量协议（§2.2.4），首屏 8KB 量级；`/api/experts` 补 `limit/offset` 与前端分页（328 行全量渲染同时消灭）。

---

## 8. 数据迁移与兼容（一次性、可回滚）

| 项 | 迁移 | 兼容读取 |
|---|---|---|
| user-experts.json / teams 加 owner/visibility/archived/revision | 启动时惰性迁移：无 owner → `admin` + `shared`，revision=1 | 旧字段缺失按默认值读 |
| 规范提及 token | 无需迁移：旧文本按旧解析兼容 | `@名称#id`、纯 `@名称` 永久支持 |
| plan.scope.memberSnapshots | 无需迁移 | 缺失回退读档案（现状语义） |
| TurnJob | 无需落库迁移（运行态对象；断电恢复沿用现有重启自愈） | — |
| permission 枚举 | 既有 `danger-full-access` 等字符串映射为 `full` | 旧值兼容读 |

迁移全部**前向兼容**（旧数据可读、新字段可缺省），无需停机脚本。

---

## 9. 实施里程碑（按依赖排序）

| 里程碑 | 内容 | 依赖 | 主要触点 |
|---|---|---|---|
| **M1 执行可靠性** | TurnJob + reconciling 唯一路径 + 幂等键 + NodeCapacity 并发预算 | dsh-web-service D-1（幂等键）、D-2（stall 降格 + phase 事件） | remote-client / engine / dsh-web-service |
| **M2 提及协议** | MentionRegistry + 规范 token + 歧义卡 + 弹层协议重做 | 无 | engine / web-ui / router |
| **M3 语义统一** | TaskContext 构造器 + TurnIntent 状态机 + coverage 结构化 | M2（mentions 结构化后 intent 解析更干净） | engine / orchestrator / web-ui |
| **M4 协作者域 IA** | 三 Tab + 专家行四动作 + 团队任务对话框 + 默认启用 | M2（弹层组件复用） | web-ui / router |
| **M5 治理** | 权限档位 + 归属/软删/revision + persona 快照 | dsh-web-service D-3（readonly 档） | store / types / engine / web-ui |
| **M6 AI 通道** | team_manage 工具 + AI 令牌只读面 + candidates 轻量化 | M2 | tool-ops / server / router |

M1 与 dsh-web-service 是硬依赖关系：先发 D-1/D-2 节点能力（向前兼容，旧 workbuddy 不受影响），再上 workbuddy 侧消费；D-3 可与 M5 并行开发、灰度（按节点能力档案降级拒绝）。

## 10. 验收判据（「彻底解决」的定义）

| 类别 | 判据 |
|---|---|
| A 执行 | 3 专家并行于弱节点：**0 例 stalled 失败**（允许总时长变长，计划卡可见 queued/分段）；拔流/杀进程注入后任务仍达正确终态；同幂等键重试远端无双跑 |
| B 提及 | `@调研专家` 手输直达（无候选卡）；真同名场景出**候选卡**且无任何静默降级路径；消息渲染无 `#id` 后缀；弹层首屏五分组带计数 ≤10KB |
| C 上下文 | 同一 mock task，chat 直发与编排子任务的 TaskContext 段集合**逐段一致**（单测断言）；项目任务编排子任务 prompt 含项目指令 |
| D 意图 | 决策表四条优先级各有单测；团队草稿首句 @ 单人 → 聚焦轮且 coverage=参与者口径；单专家任务仅 1 个子任务 + summarize（总时长减 90s 量级） |
| E IA | 团队管理 ≤2 次点击可达；专家行「实例化/发任务」全通；团队卡取消发起不留任何任务记录 |
| F 治理 | 内置评审团任务远端会话 permission ≠ full；readonly 不支持的节点上含 readonly 成员的任务被**拒绝并说明**；删除被引用专家 → 409 + 引用清单；改专家档案后在途任务重试人格不变（revision 断言） |
| G 通道 | AI 令牌可列团队/专家并完成「@团队发任务」闭环；candidates 首屏 ≤10KB |

---

## 附：dsh-web-service 正式依赖项

| # | 需求 | 接口 | 兼容性 |
|---|---|---|---|
| D-1 | prompt 幂等键 | `POST /sessions/:id/prompt-stream` body 增 `idempotencyKey`，同键返回进行中回合 | 旧客户端不传 = 现状 |
| D-2 | 停滞降格 + 阶段事件 | stall 触发发 `phase:'stalled'` 通知帧（不再发致命 error）；补 `queued/started/first_token` 事件 | 旧客户端忽略未知事件帧 |
| D-3 | readonly 权限档 | permissionPresets 增 `readonly`（工作区只读挂载 + 写工具禁用）；`GET /ping`/能力接口暴露 `readonlySupported` | 不支持的节点维持现状，由 workbuddy 拒绝派发 |

三项均为**加法改动**，旧版 workbuddy / 旧版节点互不影响，可独立发版灰度。
