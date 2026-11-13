# review-web-1 · WEB-1 群实体存储层 + REST API 审查报告

- 审查人：expert ｜ 任务板：task-6 (REV-6) ｜ 契约唯一事实源：docs/groups-web-sync-plan-2026-11-11.md（§1 实体/幂等、§2 REST）
- 审查对象：src/groups.ts（新增）＋ src/router.ts 群 REST 端点 ＋ src/groups.test.ts
- 对账基准：Android `app/src/main/java/com/sooncore/workbuddy/GroupStore.kt`（契约 §1 幂等语义逐条对账基准）
- **状态：预研阶段** —— task-6 被 task-2/task-5 阻塞尚未解锁；本文当前仅含「预研备忘」（解锁前基线发现），正式逐条对账在解锁后补记，并按 ⛔/⚠️/✅ + 文件:行号 重排。
- **2026-11-11 lead 批复**：预研②③ + P7 四点已裁定并回写契约（§1:39 落盘、§2:65 存在性 404、§2:67 分组空白名、§3:75 AI_TOKEN_DENIED）；相关条目已标注「已裁定」，正式审查按新契约裁定。

---

## 预研备忘（2026-11-11，解锁前基线预研）

> 下列条目是对**既有 Web 代码惯例**与 **Android 幂等基准**的预读结论，用于正式审查时快速裁定实现是否违规。行号以当前工作树为准。

### P1 ⛔ 预判 → **已裁定（lead 2026-11-11，契约 §1:39 已回写）** · 照抄 ssh-store 的「load 失败置空」违反契约 §1
- 既有样板：src/ssh-store.ts:33-36 —— `load()` catch 后 `this.resources = []`；src/ssh-store.ts:63-74 —— `upsert` 随后 `save()` 全量覆盖。组合效果：**JSON 损坏后任意一次成功写入 = 用户全部数据被空库覆盖**。
- Android 基线明令禁止该行为：GroupStore.kt:31-33 注释「不违反『load 失败不得触发 save 清数据』」；实现为 indexCorrupted unhealthy 标记（GroupStore.kt:51、272-285）＋ 首写前自愈重建（GroupStore.kt:67、287-290）。
- 契约 §1 要求「逐条对齐 Android GroupStore」（groups-web-sync-plan-2026-11-11.md:40）。groups.ts 若照抄 ssh-store 的 load/save，正式审查记 ⛔。要求：损坏 → 拒绝覆盖写（或自愈），绝不静默清库。
- **裁定**（契约 §1:39 新文本）：「仿 ssh-store」只取 0600 + fs-perms 惯例；落盘必须 tmp+rename 原子写；load 失败 / JSON 损坏时拒绝覆盖写——「保护现场，读出空表但写口不得清掉原文件」，违反即 ⛔。

### P2 ⛔ 预判 → **已裁定（同 P1，契约 §1:39）** · 落盘必须原子写（tmp+rename），不是 ssh-store 的裸 writeFileSync
- store.ts 已有正规样板：src/store.ts:240-243 注释「写盘中途崩溃/断电不会留下截断的 store.json（旧版直接 writeFileSync 会）」；同步 flush 样板 src/store.ts:294-296，异步样板 261-264。
- ssh-store.ts:43 是裸 `writeFileSync`（半写窗口）。契约 §1 说「仿 src/ssh-store.ts 落盘」应取其 **0600 + fs-perms 惯例**（ssh-store.ts:22-23、42-43；fs-perms.ts:12-13），写盘方式应取 store.ts 的 tmp+rename。
- 群是双端唯一事实源（契约 §0、§6：Android 写口「接口成功才回写本地缓存」），单文件半写会同时丢全部群。正式审查若发现裸写记 ⛔。
- **裁定**：契约 §1:39 已明确「落盘必须走 tmp+rename 原子写（src/store.ts 惯例）」——裸 writeFileSync 直接 ⛔，无需再权衡。

### P3 ⚠️→⛔ 预判 · 写盘失败不得静默吞掉
- 既有惯例均吞错仅 console.error：src/ssh-store.ts:39-47、src/expert-store.ts:55-62、src/store.ts:266-268/297-299。
- 群场景后果升级：REST 已向客户端（含 Android）返回 ok:true，但盘上没写 → 进程重启数据回滚，Android 本地缓存与 Web 盘上态背离，且 Android 端不会感知。至少要求：REST 响应必须反映落盘真实结果（写失败返回 500 或 ok:false）。正式审查按实现裁定 ⛔ 或强 ⚠️。

### P4 · 多用户 scope 结构（越权审查主战场）
- 契约：单文件 `$DSH_HOME/dsh-orchestrator-groups.json`（groups-web-sync-plan-2026-11-11.md:39）＋「每用户隔离，跨用户不可见、不可改，v1 无共享群」（:38）。=> 文件内部必须带 owner 维度分桶/过滤，照 Android「rooms 数组＋room:<id> 键」直译而不带 owner = 全员混桶越权。
- 既有 canViewResource 共享模型（src/perm.ts:177-188）**不适用**于群（群无归属人/项目共享语义），不要复用。
- 审查时逐端点确认：list/get/upsert/delete/sections/rounds/markRead 全部以 session.userId 过滤与归属；createdBy 服务端权威写入、客户端值被覆盖（契约 :28；REST 先例 src/router.ts:5052-5056「归属人由服务端权威写入，不接受客户端传入」）。

### P5 ⛔ 预判 → **已裁定（lead 2026-11-11，契约 §3:75 已回写）** · AI 令牌通道（session=undefined）调用群工具的身份语义
- 链路：src/server.ts:641-658 AI 令牌可过门禁访问工具通道；src/server.ts:685/696 —— 无登录会话时 `session=undefined` 且 `aiTokenOnly=true`。
- 群按 userId scope，AI 令牌拿不到 userId：undefined scope 若落「共享空桶」= 任意持令牌调用方互见互改，越权。先例：SSH get/exec 对 aiTokenOnly 显式拒绝（src/tool-ops.ts:921-924）。
- 正式审查裁定：群工具对 aiTokenOnly 请求应显式拒绝（推荐，先例一致）或由 lead 在契约补「AI 令牌 = 服务级共享桶」语义。静默混桶记 ⛔。
- **裁定**（契约 §3:75 新文本）：aiTokenOnly 调用 workbuddy_group_manage **一律拒绝**，错误码 `AI_TOKEN_DENIED` + nextAction 提示改用登录身份；不做服务级共享桶。审查对账：全部 12 个 action（含 list/get 等只读）都要拒绝，且拒绝要发生在参数校验之前或至少不被绕过。

### P6 → **已裁定（lead 2026-11-11，契约 §2:65 已回写）** · Android 基线内部不一致：addRound 不校验群存在 vs markRead 静默 no-op
- GroupStore.kt:169-178 `addRound` 只查 taskId blank，**不查群存在**（本地场景孤儿轮键由 delete 级联清，GroupStore.kt:83）；GroupStore.kt:181-184 `markRead` 是 `get(roomId) ?: return` **静默 no-op**。
- Web 端 POST /api/groups/:id/rounds 与 POST /api/groups/:id/read 对不存在 id 的行为契约未写（groups-web-sync-plan-2026-11-11.md:60-61）。照抄 Android = 写口落孤儿轮键（Web 单文件下持久留存，仅 delete 时清）＋ markRead 静默 200；REST 一致性 = 与 GET /api/groups/:id 的 404（契约 :52）对齐。
- 审查立场：两写口彼此必须一致、且与 §1「对齐 Android」不冲突的解读优先取 **404**（Web 是多用户服务端，不能接受匿名 id 落数据）；分歧记 ⛔，最终语义由 lead 在契约补注。
- **裁定**（契约 §2:65 新文本）：对不存在的群 id，GET/PUT/DELETE /api/groups/:id、GET/POST /api/groups/:id/rounds、POST /api/groups/:id/read **一律 404 NOT_FOUND**，不留孤儿键——正式覆盖 Android addRound 基线不一致。审查时注意 404 不得泄露他人群存在性：跨用户 id 也必须 404（同一码，不区分「不存在」与「不是你的」，见 P4）。

### P7 → **已裁定（lead 2026-11-11，契约 §2:67 已回写）** · 分组端点空名 / o==n 边角
- Android 基线：GroupStore.kt:202-211 addSection trim 后空名返回 false（no-op 幂等，非错误）；GroupStore.kt:214-225 renameSection o/n 空或 o==n 返回 false。
- Web POST /api/group-sections `{name:""}`、PUT `{to:""}`：契约 §2 校验段的「trim 后空串归 ''」是群字段 section 的归一化（groups-web-sync-plan-2026-11-11.md:63），不是分组端点行为。空名建议 400 INVALID_PARAM（对齐 src/tool-errors.ts:20 分类惯例）；o==n 且旧名存在按「新名已存在」409 自然对齐。
- removeSection 空名 Android 为整体 no-op（GroupStore.kt:229-236）；Web 路由 :name 非空约束下自然 404/405，无害边角。
- **裁定**（契约 §2:67 新文本）：POST /api/group-sections 与 PUT /api/group-sections/:name 名字 trim 后为空 → 400 INVALID_PARAM；DELETE 空白名 → 400；**DELETE 不存在的有效名 → 幂等 200**（级联语义照 §1）。审查补充对账点：MCP 工具层 add_section/rename_section/remove_section 的空白名行为应与 REST 同口径（400 INVALID_PARAM），remove_section 不存在的有效名幂等（§3 action 语义对齐 §1）。

### P8 · markRead/updateUnread 数值边界与并发原子性（WEB-1 重点）
- 单调语义：lastReadSeq = max(current, 入参)（GroupStore.kt:183；契约 :44）。负数入参 Android coerce 后取 current（安全 no-op）。
- unreadCount：Android 为派生值钳 0（GroupStore.kt:187-191）；契约 :31 允许「客户端本地覆盖上报」=> PUT /:id 直接带 unreadCount 合法，但负值应钳 0 或 400（Android parse optInt 可收负，GroupRoom.kt:85）。
- 并发：Android markRead 走读-改-写 upsert（GroupStore.kt:183），靠 synchronized 串行保证原子（GroupStore.kt:30,66）。Web Node 单线程下，markRead 必须**同步完成读-改-写、中间无 await 间隙**；若实现拆成异步两步，并发 markRead（旧 seq 后到）会回退 lastReadSeq 违反单调 → ⛔。
- lastReadSeq/unreadCount 建议非负整数校验（契约 §2 校验清单未列，审查时按实现补 ⚠️）。

### P9 · 幂等语义直译对账表（正式审查逐条打勾）
| 契约条款 | Android 基线 | 对账点 |
|---|---|---|
| upsert 同 id 保位覆盖、新 id 追加末尾（:41） | GroupStore.kt:12-13 upsertIds；:65-74 | list 保索引序；**索引与内容同一原子写**（:70-73）→ Web 单文件天然一体 |
| delete 不存在静默幂等 + 清 rounds 孤儿键（:42） | GroupStore.kt:16-17 deleteIds；:78-85 三键一体 | Web delete 必须同时清轮表 |
| add 分组重名幂等 → {ok:true,data:{added:false}}（:43） | GroupStore.kt:202-211 | Web 返回形状对齐；空名见 P7 |
| rename 409 SECTION_CONFLICT + 级联迁移（:43） | GroupStore.kt:214-225 | 迁移 = 逐群改 section，**索引序不变**；409 仅「旧名不存在或新名已存在」 |
| remove 分组幂等 + 级联置 ""（:43） | GroupStore.kt:229-236（置 null） | Android null ≡ Web ""（GroupRoom.kt:58 序列化约定） |
| rounds add 同 taskId 去重保序（:44） | GroupStore.kt:163-178（读侧 distinct、写侧 contains 幂等） | Web 读侧也应 distinct 兜底 |
| markRead 单调 + unreadCount 归零（:44） | GroupStore.kt:181-184 | 见 P8 并发与不存在语义 |

### P10 · 字段归一化对齐 Android JSON 编解码
- Android 序列化 null→""（GroupRoom.kt:52,55,57,58,64）、解析 ""→null（:71,76,80,81,88）；契约 Web 实体统一 string|""（groups-web-sync-plan-2026-11-11.md:22-33）。Web 应把 null/缺失归一化为 ""，**不得向 Android 下发 null 字段**。
- mode/notifyLevel 缺省补默认 admin/mention（GroupRoom.kt:72,84；契约 :23,30），**显式非法枚举 400**（契约 :63）——缺省 ≠ 非法，审查时区分。
- notice>2000 拒绝（GroupDefaults.NOTICE_MAX=2000，GroupRoom.kt:42；契约 :20,63）。
- memberAgentIds/projectIds 去重保序：契约 :63 要求 Web 服务端归一化。注意 Android parse 只滤 blank **不去重**（GroupRoom.kt:73-79）——Web 比 Android 严是对的（以契约为准），审查确认去重保序实现。
- createdAt/updatedAt 服务端维护（契约 :34）；更新时保 createdAt、刷 updatedAt（REST 先例 src/ssh-store.ts:65-71）。upsert 已存在群时 createdBy 保持原值不被客户端覆盖（对齐 src/router.ts:5052-5056 注释语义）。

### P11 · REST 包络与错误码惯例
- 包络 {ok:true,data} / {ok:false,error}（契约 :46）；404 NOT_FOUND（:52）；409 SECTION_CONFLICT（:43）。样板：src/router.ts:5038-5130（list 过滤 :5040、对象级 404 :5069-5071、写面 403 :5083-5085、audit :5087）。
- Android 消费侧（供 review-and-5 引用）：Api.kt biz() !ok → ApiException(code,status,error)（Api.kt:103-122）；404/409 的 code 可被 GroupRepository 识别分派文案。
- MCP 侧（供 review-web-2 引用）：错误须过 normalizeToolResult（src/tool-errors.ts:43-77，产 category/recovery/retryable；读类自动 retryable=true :65，写类强制 false 防重放）＋ 人话 nextAction 提示（既有风格 src/tool-ops.ts:415,458,541）。契约 :70「错误返回带 nextAction」与 recovery 结构并存是既有惯例，两套都要有。

### P12 · WEB-2 三处同步硬需求（预判，正式审查在 review-web-2.md 展开）
- tool-contracts.ts contracts 登记：src/tool-contracts.ts:65-88（actionContract 定义 :64）——**缺登记 toolInputSchema 抛 Unknown tool**（:100）。
- tool-policy.ts rules 登记：src/tool-policy.ts:27-46，**fail-closed**（:76-78「adding an action to a contract alone cannot authorize it」）——缺登记 = 全 action deny 且 capabilities 里 actions=[]。
- tool-ops.ts getTools 注册：src/tool-ops.ts:223+ 样板。
- capabilities.ts 无需手改：自动从 defs+policy 派生（src/capabilities.ts:11）。契约 :70「若 capabilities.ts 有工具清单需同步登记」实为验证点。
- 风险档（契约 :69）：list/get/sections/rounds=read；create/update/*_section/add_round/mark_read=write；delete=write+destructive。对照 src/tool-policy.ts:36 先例。

### P13 · REST 与 MCP 双通道 per-user 口径一致性
- REST 侧身份：this.session（router dispatch 注入）；MCP/HTTP 工具侧：ctx.session 同源于 server.ts:685/696 的 requestSession——两通道天然同源。
- 审查确认：工具实现必须用 ctx.session.userId，**调用方身份绝不可来自工具参数**（src/tool-policy.ts:67-71 注释「Caller context must come from the authenticated channel, never tool arguments」）；REST 侧同理不接受 body 里的 createdBy/ownerUserId 透传（见 P4）。

### A 组 · Android 预研备忘（正式审查移入 review-and-5.md）
- A1 biz() 容错惯例：Api.kt:103-122（401 静默续登重放一次；无响应体抛 RuntimeException；!ok 抛 ApiException(code,status,error)）；POST 无 body 发空 JSON 对象（Api.kt:79-81）。群新方法必须全走 biz()，不得自拼 call()。
- A2 数组解析：arr() 兼容（Api.kt:124-132）；群列表/分组/轮表 data 即数组，arr() 直接可用；不要学 endpoints 专用 hack。
- A3 错误面：ApiException 携带 code/status（Api.kt:1255-1259）；404 NOT_FOUND / 409 SECTION_CONFLICT 应被 GroupRepository 识别为独立文案（先例 WbErrors.workspaceErrorText），不得统一吞成「操作失败」。
- A4 分层红线（契约 :90-91）：写口 server-first **成功才回写本地**；读口接口优先、失败回退本地缓存（离线可看不可管）。「网络失败时的乐观本地写」语义必须显式写清并审查——重点：服务器 409/404/400 不得静默降级成本地成功。
- A5 纯函数保持 JVM 可测（契约 :93；GroupStoreTest.kt:110-127 已锁 upsertIds/deleteIds 幂等）——分层改造不得把纯函数搬进 Android Framework 依赖。
- A6 本地叠加层（契约 :91）：unread/lastReadSeq 本地字段与 Web markRead（归零 unreadCount）双写口径差需在 Repository 层明确——本地 turnsCount 派生（GroupStore.kt:187-191）与服务器 lastReadSeq 基准一致性。

### P9 补充 · 裁定并入后的对账表增量行

| 新契约条款 | 对账点 | 违反判定 |
|---|---|---|
| §1:39 tmp+rename 原子写 | groups.ts save 路径（同步/异步均须） | 裸 writeFileSync → ⛔ |
| §1:39 load 失败拒绝覆盖写 | 损坏后任何写口不得清掉原文件（读出空表可，落盘覆盖不可） | 静默清库 → ⛔ |
| §2:65 不存在群 id 一律 404 | rounds/read/put/delete/get 六端点一致；跨用户 id 同样 404 不泄露存在性 | 孤儿键/静默 200 → ⛔ |
| §2:67 分组空白名 400 | add_section/rename_section/remove_section(MCP) 同口径 | 200 no-op 或 404 → ⚠️/⛔ |
| §2:67 DELETE 不存在有效名幂等 200 | 与 §1:43「remove 不存在幂等」一致 | 404 → ⚠️ |
| §3:75 aiTokenOnly 一律 AI_TOKEN_DENIED | 12 个 action 全覆盖；nextAction 提示改用登录身份 | 混桶/部分放行 → ⛔ |

---

---

## 正式审查 · WEB-1（2026-11-11，对 task-1 交付的逐条对账）

审查对象：src/groups.ts（新增 426 行）、src/router.ts:5044-5195（群 REST 12 端点）+ router.ts:71,156,168-170（注入）、src/types.ts:818-863（GroupRoom）、src/groups.test.ts（385 行 / 16 项）、package.json:52（test:unit 登记）。
审查基线：本文件预研备忘 P1-P13/A1-A6 + 裁定增量表 + lead 补充两视角（跨用户 404 防枚举、unhealthy 拒绝语义统一）。

### 结论速览

| # | 级别 | 条目 | 位置 |
|---|---|---|---|
| W1-1 | ⛔ | load 结构级字段损坏被静默兜底，后续写口会用残缺数据覆盖原文件（违反裁定「损坏拒绝覆盖写」） | src/groups.ts:218-231 |
| W1-2 | ⚠️ | persist 失败抛错后内存态不回滚：写口已改内存，落盘失败后同进程 GET 读到「幽灵数据」 | src/groups.ts:298-306,414-425 |
| W1-3 | ⚠️ | archived 用 Boolean() 宽转换："false" 字符串 → true（方向性错误，Android optBoolean 是正确方向） | src/groups.ts:137 |
| W1-4 | ⚠️ | 契约 §2:65 文字与 §1:42 冲突（DELETE 不存在群：404 还是幂等 200）；实现取幂等 200 正确，需 lead 修契约措辞 | src/router.ts:5113-5118 ｜ 契约 §2:65 vs §1:42 |
| W1-5 | ⚠️ | POST rounds 的 taskId 空白/非字符串 → 200 {added:false}，与 markRead 的 400 严格口径不一致 | src/router.ts:5173-5177、src/groups.ts:400-401 |
| W1-6 | ⚠️ | groupFail 把非 GroupStoreError 的意外异常压成 400 INVALID_PARAM（应 500，防未来回归误导客户端） | src/router.ts:5052-5057 |

⛔ 共 1 项；⚠️ 共 5 项。✅ 见下节逐条对账（全部通过项）。

### ⛔ W1-1 · load 结构级损坏静默兜底 → 覆盖清库（必须修复）

- 现状：groups.ts:220 `users` 字段非法（数字/数组）→ 条件不满足**直接跳过**、unhealthy=false；groups.ts:222 scope 条目非对象 → `continue`；groups.ts:224 `rooms` 非数组 → `[]`；groups.ts:227-228 sections/rounds 非法 → sanitize 静默置空。上述情形 load 全部返回 healthy，随后**任意一次成功写口 persist() 会以残缺内存态整体覆盖原文件** → 对应用户（或全部用户）数据被静默清除。
- 违反：契约 §1:39 裁定「load 失败 / JSON 损坏时**拒绝覆盖写**（保护现场）」——「合法 JSON 但结构损坏」属于损坏范畴，当前实现只防住了「JSON.parse 失败」这一种（groups.ts:233-236，测试已锁 groups.test.ts:216-229）。Android 基线对应物：索引损坏即置 unhealthy（GroupStore.kt:281-284），单条记录损坏才逐条跳过（GroupStore.kt:56-60）。
- 修复建议（~5 行）：groups.ts:220 `users` 非对象 → markUnhealthy；:222 scope 非对象 → markUnhealthy（至少跳过该桶且置 unhealthy）；:224 `rooms` 非数组 → markUnhealthy。单条群记录损坏维持 coerceGroupRoom 逐条兜底（groups.ts:148-150，对齐 Android，保留）；sections/rounds 字段非法建议同样置 unhealthy（一致性；最低限度也应 console.error 留痕）。
- 触发条件：合法 JSON 但结构损坏（手工编辑 / 外部工具改写 / 未来格式漂移），概率低但后果 = 裁定明令防止的静默清库。

### ⚠️ 详情

- **W1-2**：upsert（groups.ts:298-306）、markRead（:414-425）等写口均为「先改内存 → persist()」，persist 抛 STORE_WRITE_FAILED 时内存保留新值而盘上未写。REST 已如实 500（router.ts:5055，测试 groups.test.ts:372-385 ✅），但同进程后续 GET 读到未落盘数据，进程重启即消失。建议任选：a) persist 失败即置 unhealthy（盘上态未知 → 拒绝后续写，最贴「保护现场」精神）；b) 维持现状但在 groups.ts 头注释声明「写失败后内存态视为未确认」。
- **W1-3**：groups.ts:137 `Boolean(raw.archived)` —— JSON body 发字符串 `"false"` → `Boolean("false") === true`，把「取消归档」意图变成「归档」，方向性错误。Android optBoolean("archived", false)（GroupRoom.kt:83）对字符串按 Boolean.parseBoolean 解析，方向正确。MCP 工具通道 room 为自由 json 参数（tool-contracts 不校验对象内部字段），字符串可直达此处。建议：只认 `true` / `'true'`（或仅 boolean 类型，其余回退 base/默认）。
- **W1-4**：实现 DELETE /api/groups/:id 不存在 → 200 `{deleted:false}`（router.ts:5113-5118），依据契约 §1:42「delete：不存在静默幂等」+ Android deleteIds（GroupStore.kt:16-17）——**实现正确**；但裁定② 回写后的 §2:65 文字把 DELETE 一并列入「一律 404」清单，与 §1:42 形成契约内部矛盾。请 lead 修订 §2:65（把 DELETE /api/groups/:id 移出 404 清单，注明「DELETE 幂等 200、级联清轮」）。实现侧无需改。
- **W1-5**：router.ts:5173-5177 POST rounds 把 taskId 校验完全交给存储层（groups.ts:400-401 trim 后空 → `{added:false}` 200）；而同文件 markRead 对 lastReadSeq 严格 400（router.ts:5188-5191）。两个子资源写口松紧不一，且 MCP add_round 通道按工具惯例空 taskId 应 INVALID_PARAM。建议 REST 层：taskId 非字符串或 trim 后空 → 400 INVALID_PARAM（与裁定④分组空白名同风格）；存储层幂等兜底保留。
- **W1-6**：router.ts:5054-5055 `e instanceof GroupStoreError ? e.code : 'INVALID_PARAM'` —— 非 GroupStoreError 的意外异常（编程错误）统一 400，客户端会把服务端 bug 当参数错误排查。建议 fallback 分支改 500（EXECUTION_FAILED 类）。当前代码路径 normalize/upsert 只抛 GroupStoreError，属防御性修正。

### ✅ 对账通过项（按预研备忘编号）

- **P1a 损坏拒写保现场**：markUnhealthy 置空内存不触盘（groups.ts:239-243）；assertWritable 先于任何内存变更（groups.ts:271-275）；persist 双保险（:255-258）；原文件字节级保现场有测试锁定（groups.test.ts:226,382）✅
- **P2 原子写**：tmp+rename（groups.ts:262-264）+ 0600（writeFileSync mode，:263；启动 hardenFile，:192）；无 .tmp 残留与权限断言（groups.test.ts:206-212）✅
- **P3 落盘失败如实反馈**：STORE_WRITE_FAILED → REST 500（groups.ts:265-267 → router.ts:5055；groups.test.ts:377-380）✅
- **P4 每用户分桶**：users[userId] 三桶结构（groups.ts:9-10,153-160,277-284）；9 个存储方法全部 userId 前置；跨用户不可见/不可改/同名 id 隔离有测试（groups.test.ts:181-198,361-365）✅
- **P5/裁定③ 无身份拒绝**：groupUser() 只取 session.userId，无身份 401 UNAUTHORIZED（router.ts:5046-5050），12 端点全部前置（如 :5059-5060,5065-5066,5087-5088,5122-5123,5128-5129,5140-5141,5165-5166,5182-5183）；不落共享桶有测试（groups.test.ts:366-368）✅
- **裁定② 存在性 404**：GET/PUT :id（router.ts:5092,5098）、GET/POST rounds（:5169,5174）、POST read（:5185）统一 NOT_FOUND；**跨用户 id 同样 404 不泄露存在性**（lead 补充视角①，groups.test.ts:364 防枚举断言）✅
- **裁定④ 分组输入校验**：add/rename 空白名 400（groups.ts:332-333,347-349）、remove 空白名 400（:370-371）、remove 不存在有效名幂等（:372-373）；REST/测试对齐（router.ts:5130-5161；groups.test.ts:138-139,150,155,330-331）✅
- **P8 已读单调与原子**：markRead 同步读-改-写、无 await 间隙（groups.ts:414-425）；Math.max 单调 + unreadCount 归零；REST 非负安全整数 400（router.ts:5188-5191；groups.test.ts:349-355）——「严格 400 严于 Android 宽松 coerce」为合理取舍（REST 是平台边界，Android 客户端 markGroupRead 入参非负不触发）✅
- **P9 幂等全表**：upsert 同 id 保位/新 id 追加（groups.ts:301-303；groups.test.ts:104-116,311-316）；delete 幂等+级联清轮（:309-320；test:118-130）；addSection 重名 {added:false}（:335；test:136-137）；rename SECTION_CONFLICT（含新旧同名 :352-353）+ 级联迁移索引序不变（:355-359；test:144-149,324-338）；remove 级联置 ""（:378-383；test:152-154,337-338）；rounds 读侧去重保序（:392-395）+ 写侧群不存在不落键（:401；test:159-177）✅
- **P10 归一化**：缺省≠非法枚举（groups.ts:104-112「!s → def」；test:82-92）；notice 码点 ≤2000（:115-118；test:87-88）；数组去重保序（:59-68；test:94-101）；activeProjectId ∈ projectIds 归一化（:122-123；test:96-98）；name/section trim（:127,135）；null/缺失 → "" 绝不下发 null（asString :54-56；test:77-79）；createdBy/createdAt 服务端权威、PUT 保原值（router.ts:5073-5078,5101-5106；test:49-65,276-298）；unreadCount/lastReadSeq 钳 0（:71-74）✅
- **P11 包络与错误码**：{ok,data}/{ok:false,code,error}（router.ts:5056）；SECTION_CONFLICT→409 / STORE_*→500 / 其余 400（:5055）；401 UNAUTHORIZED（:5048）；DELETE 群 audit（:5116）✅
- **P13 身份边界**：调用方身份只取 session.userId；body 的 id/createdBy/createdAt 一律不采信（router.ts:5046-5050,5070-5077；PUT 用路径 id 权威 :5102）✅
- **unhealthy 拒绝语义统一**（programmer 取舍，裁定正确）：幂等写口（delete/removeSection/addRound 已存在去重）在 unhealthy 下同样 assertWritable 拒绝——unhealthy 时内存是空表，幂等「删除/追加」会假成功且失真，统一 500 提示人工检查（groups.ts:299,310,331,346,369,399,415；groups.test.ts:224-225）✅
- **POST 200 非 201**（programmer 取舍）：沿仓库既有惯例（POST /api/ssh-resources 同 200，router.ts:5058 参照）✅ 接受
- **注入方式**：构造尾可选 groupsStore + 懒建默认实例（router.ts:156,168-170），server.ts 零改动 ✅；写范围五文件未越界、零 git 操作 ✅
- **types.ts GroupRoom**：字段名与契约 §1/Android GroupRoom JSON 逐字一致（types.ts:825-860），可空字段统一 string|"" ✅

### 测试覆盖评价

16 项覆盖归一化（含缺省≠非法、merge、严格校验）、幂等 P9 全表、损坏保现场（存储层+HTTP 双路径）、lenient 读取、原子写/0600、每用户隔离、12 端点包络与 404/409/400/500/401、跨用户防枚举、无身份 401。缺口（不阻塞，随 ⛔/⚠️ 修复补）：结构级损坏场景（W1-1）无测试——修复时必须补「users 非对象 / rooms 非数组 → unhealthy 且原文件不被覆盖」用例。

### 待办与流转

- ~~⛔ W1-1 由 programmer 修复 + 补测试~~ → **已修复并复核通过（见下节），⛔ 清零**。
- ~~⚠️ W1-2/W1-3/W1-5/W1-6~~ → **已全部修复并复核通过**；~~W1-4 契约修订~~ → **lead 已修订 §2:65**（DELETE 移出 404 清单，例外条文明文）。

---

## 复核记录 · WEB-1 第二轮（2026-11-11，五条修复逐项验证 → ⛔ 清零）

| 原条目 | 修复验证 | 结论 |
|---|---|---|
| ⛔ W1-1 | load() 结构级损坏全量 markUnhealthy：users 非对象（src/groups.ts:228-231）、scope 条目非对象（:234-237）、rooms/sections/rounds 形态非法（:239-242）；单条记录 coerceGroupRoom 逐条兜底保留（:244，对齐 Android「索引损坏 unhealthy、单条损坏跳过」）。三形态测试（users:5 / rooms:'x' / scope 条目非法）断言 unhealthy + 写口 STORE_UNHEALTHY + 原文件字节不变（src/groups.test.ts:239-253） | ✅ 修复到位 |
| ⚠️ W1-2 | persist 失败 → `markUnhealthy(reason, keepMemory=true)`（src/groups.ts:283-287）：置 unhealthy 拒绝全部后续写口（assertWritable :292-296），内存态保留供读不回滚，注释声明语义（:256-257）。确定性写败测试用 EISDIR 注入（mkdir 占用 .tmp 落点，规避 ensurePrivateDir 重建目录；src/groups.test.ts:255-268） | ✅ 修复到位（采纳 a+b 混合，优于原建议） |
| ⚠️ W1-3 | asTriBool 只认 true/'true'/false/'false'，垃圾值回退调用方默认（src/groups.ts:77-81、:144）；测试覆盖 'false' 显式清除、'true' 生效、'yes'/1 回退（src/groups.test.ts:94-99） | ✅ 修复到位 |
| ⚠️ W1-5 | router POST :id/rounds 空 taskId → 400 INVALID_PARAM（src/router.ts:5176-5177）；存储层幂等兜底保留（groups.ts addRound）；与 markRead 非负整数 400（router.ts:5189-5192）口径对齐 | ✅ 修复到位 |
| ⚠️ W1-6 | groupFail 非 GroupStoreError → code INTERNAL_ERROR + 500（src/router.ts:5054-5055）；枚举码 SECTION_CONFLICT→409 / INVALID_PARAM→400 / 其余→500 | ✅ 修复到位 |
| ⚠️ W1-4 | lead 已修订契约 §2:65：GET/PUT :id、GET/POST rounds、POST read 一律 404；**例外：DELETE 不存在 → 幂等 200**（明文，与 §1 delete 幂等语义合并表述） | ✅ 契约闭环 |

**结论：⛔ 清零（1/1 修复），⚠️ 全部处置（5/5）。WEB-1 复核通过，task-1 维持 complete。**
回归保障：修复新增 4 组测试（结构损坏三形态 / EISDIR 写败 / archived 严格布尔 / REST 400 断言），全量 test:unit 370/370 绿（lead 独立复跑）。