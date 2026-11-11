# review-and-5 · AND-5 Android 群管理接口化审查报告

- 审查人：expert ｜ 任务板：task-5 (AND-5) ｜ 契约：docs/groups-web-sync-plan-2026-11-11.md §6 ｜ 对账基线：review-web-1.md 预研备忘 A1-A6
- 审查对象：GroupRepository.kt（新增 127 行）、Api.kt 群 11 方法（:1252-1305）、GroupStore.kt（写穿三方法 + 纯函数 2 个）、调用点五文件（CreateGroupWizard/GroupSettings/GroupChat/AdminScreens/DshNodes）、GroupStoreTest +2 用例
- **结论：⛔ 0 项；⚠️ 5 项（均非阻塞）；DshNodes 零改动判定确认正确；TaskMonitorService 合同外用法裁定建议保留现状。AND-5 复核通过。**

---

## 结论速览

| # | 级别 | 条目 | 位置 |
|---|---|---|---|
| AND-1 | ⚠️ | Android 开新轮 channelRef 写回失败无补偿（Web 侧 W3-4 已修 cancel 回滚，双端行为不一致，重试会重复建轮） | GroupChat.kt:213-217 |
| AND-2 | ⚠️ | 全量 upsert 携带本地 unreadCount/lastReadSeq，离线缓存源场景可能回退服务端单调位点——建议 Web 服务端 upsert 对 lastReadSeq 取 max 防御（根本解，双端联合） | Api.kt:1263-1264 + router 群 POST/PUT |
| AND-3 | ⚠️ | 归档时 cancel 频道 runCatching 静默：cancel 失败仍归档 → 运行中频道成孤儿（取舍可接受，建议留痕） | GroupSettings.kt:112-115 |
| AND-4 | ⚠️ | replaceRounds 读-写竞态窗口（旧快照覆盖刚写入的轮）——瞬态自愈，知情接受 | GroupStore.kt:117-121 |
| AND-5 | ⚠️ | GroupChat 开新轮注释声称「群元数据未落库提示」但实际 catch 文案是「发送失败」（该文案在向导侧），注释与实现不一致 | GroupChat.kt:214 vs 226-228 |

## ✅ 对账通过项（按预研基线 A1-A6 + lead 两条细则）

### A1/A2 · Api 层惯例（11 方法全走 biz/arr）
- 全部 11 方法走 biz()（src/.../Api.kt:1255-1305）：401 续登重放、!ok 抛 ApiException(code,status,error)、无响应体抛 RuntimeException——群方法零旁路 ✓
- 数组读全走 arr() + optString + filter/distinct 读侧兜底（groups :1255-1258、groupSections :1271-1274、groupRounds :1291-1294）✅
- upsertGroup 返回服务端权威对象（:1263-1264 parseGroupRoom(data)——createdBy/createdAt 以服务端为准，契约 §1）✅；addGroupSection 返回 added 供调用方判定（:1277-1279，optBoolean 缺省 true 对旧服务端宽容）✅

### A4 · 分层红线（GroupRepository.kt 全文核）
- **写口七连全 server-first**：upsert（repo:66-70）/delete（:73-76）/addSection（:79-83）/renameSection（:86-89，409 SECTION_CONFLICT 原样上抛）/removeSection（:92-95）/addRound（:98-102）/markRead（:108-113）——**先 Api 成功、后 store 镜像**，异常原样上抛绝不静默降级 ✅
- **读口四连接口优先失败回退**：groups（:34-40，失败 groupFallbackRooms(null, 本地)）/get（:43-47）/sections（:50-54）/rounds（:57-61），成功写穿缓存；**「服务器明确返回空 ≠ 失败」语义落地**（空列表照写穿，群全删/新号首登不顶替本地）✅
- **本地保留四项直通不迁移**（:115-126）：chiefAgentId/defaultDshRef/myNodes/updateUnreadLocal 直通 GroupStore 原方法，键不动、isChief 语义与 scope 隔离不变 ✅
- 分层语义成文质量高：GroupRepository.kt:5-26 KDoc 即审查对照表（含 A4 引用与调度契约「Dispatchers.IO 使用」对齐 GroupStore 既有约定）✅

### lead 两条细则
- **markGroupRead 双层单调**：仓库层本地先 coerce——入参钳非负且与本地 lastReadSeq 取 max（repo:110）→ Api 层再钳非负（Api.kt:1304）→ 服务端 max 单调兜底（裁定②语义）——三层防御 ✅；本地缓存落后场景由服务端 max 兜底、群不存在场景服务端 404 原样上抛不镜像本地 ✅
- **addGroupRound 双层空 taskId 守卫**：repo:99 check + Api.kt:1298 check（lead 细则「服务端 400 严格口径，客户端不白发」）✅

### A5 · 纯函数 JVM 可测
- groupCacheSyncPlan / groupFallbackRooms 顶层 internal 纯函数（GroupStore.kt:20-30）+ GroupStoreTest +2 用例（:131-153）：服务器序全量 upsert 与多余删除（含 deleteIds 清轮键防孤儿断言）、回退语义四态（失败→本地 / 空→本地 / 成功→服务器 / **服务器空 ≠ 失败以服务器为准**）✅；既有用例零改动（声明核对：GroupStoreTest 原 128 行用例未动）✅

### 写穿方法（GroupStore.kt:99-121）
- replaceRooms：groupCacheSyncPlan → 索引按 upsertIds 保位/追加 + deleteIds 删除，内容键批量写 + 删除群连带清轮键（防孤儿）✅；索引损坏（readIds 空表）时以服务器全量重建 = 正确自愈，且 indexCorrupted 自愈链不受影响（后续独立 upsert rebuild 读到的已是服务器权威内容键）✅
- replaceSections / replaceRounds：简单写穿（rounds 侧滤空去重对齐读侧口径）✅

### 调用点五文件
- **CreateGroupWizard**（:182-200）：repo.upsert server-first；失败 catch 文案含「已创建任务 X：群元数据未落库，请勿重复建群」（含任务 id 引导，防重复建群）✅
- **GroupSettings**（:88-167）：save/archive/restore/deleteRoom 全部 server-first + 「服务端未确认，本地未改」错误面；**失败不更新 current / 不退出侧板 / 归档失败不置归档态**（saved/fail 双轨模式）✅
- **GroupChat**（:147-268）：reloadRounds 读口回退（:149-150）；轮询已读 runCatching（:167，写口失败静默 3s 重试合理）；终态转轮/开轮写回/结束轮全走 repo 且失败进既有 catch 错误面（:195-204,213-217,240-245）；**switchProject 补 try/catch + err/errKey**（:253-268，修复此前服务端失败崩协程）✅
- **AdminScreens**：addSection server-first（:598-612，失败走既有「创建失败」分支）；reloadGroupData groups/sections 走 repo 读口、**chiefAgentId 用 GroupStore 本地键直通**（:727-729，isChief 红线不动）；updateUnread 走 updateUnreadLocal 叠加层（:736）；回退刷新 repo.groups（:741）✅
- **DshNodes 零改动判定确认**：grep 全文件——GroupStore 用法仅 myNodes/defaultDshRef/addMyNode/removeMyNode/setDefaultDshRef（:77-316），全部属契约 §6「本地保留项」，无群元数据读写——**programmer 判定正确，零改动合理** ✅

### 红线自查核验
- Android 工作树 git status 仅 8 个 app/src 文件（GroupRepository.kt 新增 + 7 修改）——设计文档/GLOSSARY/存储键未触碰 ✅；isChief 本地键直通（AdminScreens:729）✅；WbNavigation.scope 隔离不变（GroupStore 构造未动）✅；icons-extended 未引入（imports 核查）✅；测试 179/179 双绿（programmer 报告）✅

## ⚠️ 详情

- **AND-1（开新轮无补偿，与 Web 行为不一致）**：GroupChat 开新轮 createTaskFull 成功（:210-212，任务已建立、成员已收开启消息）→ repo.upsert(channelRef=newId) 失败（:213-217 网络抖动）→ catch 错误面，但**任务无回滚、服务端/本地 channelRef 均未指向它** → 用户重试 send 会再建一轮（重复编排任务）。Web 侧同款窗口已在 W3-4 修复（cancel 回滚 + 错误文案），**双端行为不一致**。建议：Android 对齐 Web 补偿（upsert 失败即 Api.cancel(newId)，二次失败静默）或至少错误文案携带 newId 引导任务中心。级别中低（需 create 成功而紧随写口失败的网络抖动窗口）。
- **AND-2（全量 upsert 携带计数的位点回退风险，双端联合）**：Android repo.upsert 发送 groupRoomToJson(room) 全量字段，含本地 unreadCount/lastReadSeq。常规路径 repo.get 先拉服务端权威对象再 copy（:199,216,244,259）不会回退；但 **get 失败回退本地缓存对象 + upsert 恰好成功的网络抖动交叉**（或 GroupSettings current 源于离线缓存后保存）会把 stale lastReadSeq 覆盖服务端，违反「markRead 单调不回退」的精神（契约 §1:32 只约束 /read 端点，upsert 端点无防御）。Web UI 侧 patch 不带计数字段，无此风险。建议**根本解在 Web 服务端**：router 群 POST/PUT 落库时 lastReadSeq = max(现值, 入参)（unreadCount 照收不破坏「本地覆盖上报」合法场景）——一并消除 Android/未来客户端的整类回退；或 Android upsert body 剥离计数字段。请 lead 定夺（推荐服务端防御，改 router + 补测试）。
- **AND-3（归档 cancel 静默）**：GroupSettings.archive 对当前频道 cancel 用 runCatching 吞错（:112-113）——cancel 失败（如任务运行中网络抖动）仍继续 addRound + 归档 → 运行中频道成孤儿（群已归档不指向它，任务继续产生消息）。X-a「归档优先」取舍可接受（任务可能本就终态），建议 cancel 失败时 log 留痕或归档成功 toast 附注「频道任务可能仍在运行，可到任务中心手动停止」。
- **AND-4（replaceRounds 竞态窗口）**：rounds() 读快照在途时 addRound 完成写入服务端 → 旧快照响应回来 replaceRounds 覆盖 → 本地暂缺刚加的轮；下次 reloadRounds 自愈，GroupChat 主流程 addRound 后主动 reload（:203,247）✓。瞬态知情接受。
- **AND-5（注释与文案不一致，弱）**：GroupChat.kt:214 注释「失败会在 send 错误面报『群元数据未落库』提示」——该文案实际在 CreateGroupWizard；GroupChat catch 是 friendlyPermError(e,「发送失败」)（:226-228）。ApiException 会透传服务端 error 文本（信息不丢），仅注释表述过度。顺手修正注释或对齐文案即可。

## TaskMonitorService.kt:48 合同外裁定（programmer 提请）

**裁定建议：保留现状（本地缓存 + 5min gate），切 repo.groups() 记遗留池。** 理由：①后台通知场景离线可用、零网络/电量成本；②本地缓存随任意 repo.groups() 读口写穿保持新鲜（用户打开过群页即新）；③gate 本身 5 分钟节流，数据滞后上限可控；④该路径不在契约 §6 调用点清单，改它反而扩大本次变更面。遗留池条目建议表述：「若通知准确性要求提升（如新群 gate 判定），后台路径可改为 gate 窗口内一次 repo.groups() 刷新 + 失败回退本地」。最终由 lead 确认归档。

## 待办与流转

- ⛔ 0：AND-5 复核通过，task-5 complete 成立。
- AND-2 请 lead 定夺（推荐 Web 服务端 lastReadSeq max 防御，可并入收尾批次）；AND-1/AND-3 建议随收尾批次；AND-4/AND-5 知情归档。
- TaskMonitor 裁定请 lead 确认归档。
- task-6 解锁后本报告并入 REV-6 汇总。
---

## 复核记录 · AND-5 收尾批次（2026-11-11，AND-1/2/3 三件闭环 → 全部通过）

| 原条目 | 修复验证 | 结论 |
|---|---|---|
| AND-1 开新轮补偿 | GroupChat.kt:215-223：repo.get(current.id) ?: current 兜底为底 → upsert(channelRef=newId) 失败即 runCatching{Api.cancel(newId)}（二次失败静默留任务中心）→ 抛 IllegalStateException 携 newId「已回滚新建任务 X，请重试勿重复建群」——与 Web W3-4 语义对齐（回滚+防重复建群），base 兜底保证写尝试必然发生 | ✅ 通过 |
| AND-2 位点回退根解 | **Web 服务端防御落地（lead 裁定，Android 零改动）**：normalizeGroupRoom 增 opts.prevLastReadSeq（src/groups.ts:93）→ 落库 lastReadSeq = max(入参解析值, prev 现值, mergeBase 现值)（src/groups.ts:150-153）；unreadCount 照收（:148 客户端覆盖上报口径不变）；四写口调用点全传现值（router POST :5078 / PUT :5107 / tool-ops create :1009 / update :1015）；单测 4 断言（POST 陈旧 5<42 不回退、PUT mergeBase 同验、前进 50 照收、新群入参生效，src/groups.test.ts:102-119）；skills/groups.md:37 口径行同步 | ✅ 通过 |
| AND-3 归档留痕 | GroupSettings.kt:116 runCatching{Api.cancel}.onFailure{Log.w(cid+原因)} 留痕不阻断；GroupChat:214 注释同步修正为实际行为（AND-5 弱项一并闭环） | ✅ 通过 |

**闭环完整性注记（双件互锁）**：AND-1 的 base = repo.get() ?: current 兜底在「get 回退本地缓存 + upsert 成功」窗口会携带 stale lastReadSeq——该窗口恰好被 AND-2 的服务端 max 钳制覆盖（Web 侧 groups.ts:150-153 与 router 传现值），两件修复互为防线，无残留回退路径。

**四调用点覆盖核查（lead 问题①）**：normalizeGroupRoom 全部调用点 = router:5073（POST）/router:5102（PUT）/tool-ops:1009（create）/tool-ops:1015（update）+ groups.ts:162（coerceGroupRoom，读取期 lenient **不落库**，无回退风险、无需 prev）——**写口 4/4 全覆盖，无第五处入口**。钳制边界：新群（prev/base 双缺）→ max(入参, 0) = 入参生效（asCount 已钳非负，无负回退）✅。

### TaskMonitorService.kt:48 裁定归档（lead 2026-11-11 确认）

保留现状（本地缓存 + 5min gate；离线通知友好/零流量/缓存随读口写穿新鲜），切 repo.groups() 记遗留池。AND-2 处置归档：Web 服务端 max 防御方案，Android 不改。

**结论：AND-5 全部对账项闭环（⛔0 / ⚠️0 未决），task-5 复核完全闭环。**
