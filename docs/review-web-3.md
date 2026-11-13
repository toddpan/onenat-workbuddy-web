# review-web-3 · WEB-3 群 UI 调用面审查报告

- 审查人：expert ｜ 任务板：task-3 (WEB-3, rev3) ｜ 契约：docs/groups-web-sync-plan-2026-11-11.md §4
- 审查对象：src/web-ui.ts 群段（:17157-17785，含群列表/群聊天/空转折叠/开轮/结束轮/历史轮/@点名/群设置/建群向导）＋ Android 基线 GroupChat.kt（:56-107,177-250）与 GroupRoom.kt isIdleRelayText（:94-137）逐字对账
- 审查范围声明：代码语义层；视觉/交互走查由 ui-designer 并行（docs/ui-review-web-groups.md）。
- **结论：⛔ 1 项（构建问题，lead 已发现并转 programmer 热修，本报告注明不重复展开）；⚠️ 6 项；其余全部 ✅。**

---

## 结论速览

| # | 级别 | 条目 | 位置 |
|---|---|---|---|
| W3-0 | ⛔→✅ | 尾部 `boot();/</script>` 重复致构建拦截——**由 lead 发现并转 programmer 热修，已修复，BUILD 绿（lead 确认 2026-11-11）** | src/web-ui.ts 尾部（原 :17779-17782） |
| W3-1 | ⚠️ | 折叠组未保留原文：数据层带 turns、渲染层丢弃，「展开」仅改样式无原文，与 Android「展开可见原文」有差距 | src/web-ui.ts:17187,17398,17411-17416 |
| W3-2 | ⚠️→修理中 | **已裁定（lead，契约 §4:86 回写）**：对齐 Android 基线——重复折叠判定代码保留、调用侧停用，启用记遗留池做双端一致增强；待 programmer 修复后复核 | src/web-ui.ts:17196（调用侧改为不传 priorBodies） |
| W3-3 | ⚠️ | 归一化 @名 剔除比 Android 少一遍大小写不敏感词边界变体 → 英文成员名场景本应折叠的消息不折叠 | src/web-ui.ts:17169 vs GroupRoom.kt:117-118 |
| W3-4 | ⚠️ | 开新轮「create 成功 → PUT channelRef 失败」产生孤儿频道窗口（任务已建、群不知晓、重试重复建轮）；建议补偿路径 | src/web-ui.ts:17451-17456 |
| W3-5 | ⚠️→修理中 | **已裁定（lead，契约 §2:69 回写）**：section 服务端容差保留（渲染未分组，对齐 Android 宽松语义）+ 新建入口必须先 POST /api/group-sections 再落群；待 programmer 修复后复核 | src/web-ui.ts:17770,17645 |
| W3-6 | ⚠️→归档 | roundNo 竞态（弱）——**lead 裁定知情归档**（Android 同款语义，仅显示瑕疵，不修） | src/web-ui.ts:17442,17447 |

## ⛔ W3-0 · 尾部结构重复（已修复闭环）

src/web-ui.ts 尾部曾出现 `boot(); → </script> → boot(); → </script>` 重复（群代码插入点落在既有尾部结构之后）。**构建问题由 lead 发现并转 programmer 热修（2 行删除）；lead 已确认热修完成、构建绿**——本条闭环，语义层对账结论不受影响。

## ⚠️ 详情

- **W3-1 折叠组无原文**：buildGroupChatLines 数据层在折叠行对象里携带了 turns 原文（src/web-ui.ts:17187 `turns: idleBuf.map(...)`），但渲染 HTML 只输出摘要行「…互发了 N 条无新内容消息」（:17398），点击展开仅把 whiteSpace 从 nowrap 改 normal 并改 title（:17411-17416）——**展开后仍看不到原文**，与 Android「只折叠不拦截（展开可见原文）」（GroupChat.kt:82-83；IdleCollapsed 数据类携带 turns 供 Compose 展开渲染，:78,90）语义有差距；title 提示「原文回看走任务中心」是有意简化但名不副实。建议：展开时用 line.turns 渲染原文列表（数据已在，改动局部）。
- ~~**W3-2**~~ → **已裁定（契约 §4:86）**：对齐 Android——调用侧停用重复折叠判定（代码保留），启用记遗留池。修复 = web-ui.ts:17196 调用改为不传 priorBodies（或传空数组）。原分析：Android 聊天页调用 `isIdleRelayText(text, memberNames)` **未传第三参 priorBodies**（GroupChat.kt:102，缺省 emptyList → isIdleRelayText 的 ≥8 码点重复分支实际不触发，GroupRoom.kt:133-136 仅词表生效）；Web 传入 idleBuf 归一化体（src/web-ui.ts:17196）→ 重复折叠分支**启用**。效果：与近期消息重复（≥8 码点包含）的较长消息，Web 会折叠、Android 不会。契约 §4.3 只说「词表照抄…连续 ≥2 条折叠」未裁定重复分支是否启用。请 lead 定夺：a) 对齐 Android 关闭重复分支；b) 契约补注「重复判定启用」保留 Web 现状（功能上更贴「无新内容」意图）。两侧词表本身逐字一致，无争议。
- **W3-3 @名 归一化弱化**：Android normalizeRelayBody 对每个成员名跑两遍剔除——先 `@名\b`（IGNORE_CASE + 词边界正则，Regex.escape 防元字符）再 `@名` 字面（GroupRoom.kt:117-118）；Web 只保留字面第二遍（src/web-ui.ts:17169 split/join，注释说明规避正则元字符）。净差异：英文名大小写变体（成员名 "Bot"、消息里 "@bot"）Android 剔除、Web 保留 → 归一化后残留 @标记 → 词表正则不命中 → 本应折叠的消息不折叠。中文成员名（主流场景）无差异。建议：split/join 前补一遍大小写不敏感的字面剔除（小写比对循环即可，无需正则）。
- **W3-4 孤儿频道窗口**：groupSend 中 POST /tasks 建新轮成功（src/web-ui.ts:17451-17453，此时平台任务已建立、成员已收到开启消息）→ PUT channelRef:newId（:17455）若网络失败 → throw → room.channelRef 仍空、rounds 不含 newId → 群状态与平台事实脱节，用户重试 send 会**再建一轮**（重复任务）。Android 同窗口但写本地 SharedPreferences 几乎不失败，Web PUT 走网络失败概率实际存在。建议：catch 分支识别「create 已成功而 PUT 失败」态——就地重试一次 PUT，失败则 toast 明示已建任务 id 并引导任务中心。对照：轮转段与结束轮段的 PUT 失败**可自愈**（cancel 幂等 + rounds 去重幂等，重试即恢复，:17439-17441、:17487-17489），无需改动。
- ~~**W3-5**~~ → **已裁定（契约 §2:69）**：服务端容差保留 + 新建入口（建群向导/群设置 __new__）必须先 POST /api/group-sections（重名幂等 added:false）再落群。修复范围 = 两处提交路径前置分组创建。原分析：建群向导第三步「＋新分组…」（src/web-ui.ts:17763,17770）与群设置 __new__（:17634,17645）把新分组名直接作为群 section 提交 POST/PUT /groups，**未先 POST /api/group-sections 创建分组实体** → GET /api/group-sections 与群设置分组管理列表不含该名（只在群上挂着游离 section）。列表渲染有兜底（:17269 把 rooms 中游离 section 补进分组头），但与 Android「渲染端对不存在分组按未分组处理」（GroupStore.kt:227 注释）语义相反，且分组管理界面无法管理该分组（重命名/删除级联不覆盖它）。建议：提交前检测新名 ∉ sections 则先 POST /group-sections（重名幂等 {added:false} 无副作用）；或由 lead 裁定服务端 POST/PUT /groups 级联 addSection（需改契约）。
- **W3-6 roundNo 竞态（弱）**：轮转后 loadGroupRounds() 异步不 await（:17442、:17458），紧接开新轮读 groupState.rounds.length（:17447）可能取到旧值 → 标题「第 N 轮」偏小或重复。Android 同款异步（GroupChat.kt:201）语义一致，仅显示编号瑕疵，无功能损害。知情接受；如需消除可在轮转分支内同步 +1。

## ✅ 对账通过项（按 lead 五项关注点 + 契约 §4 展开）

### ① 空转折叠（词表/归一化/豁免/连续≥2）
- 词表**逐字一致**：GROUP_IDLE_ACK / GROUP_IDLE_STATUS（src/web-ui.ts:17162-17163）与 GroupRoom.kt IDLE_ACK_WORDS / IDLE_STATUS_WORDS（:94-104）逐 token 相同；正则结构（词表单元 + 分隔符字符类 `[\s，,、。.!！~～：:；;]+` 幂连缀）、IGNORE_CASE、45 上限（:17165 = IDLE_TEXT_MAX）全部一致；45/8 长度判定两侧同为 UTF-16 code unit 口径，行为一致 ✅
- 四类豁免齐全（src/web-ui.ts:17194）：tools 非空 / streaming / 「[附件」或「[跨节点下载」/ @成员名 ✅；连续 ≥2 才折叠（flush :17187）、只折叠不拦截（发送与后续消息不受限）✅；speakers 去重展示 ✅
- 归一化（@全员剔除 + 压空白/标点 + 小写）字符类与 Android 逐字一致（:17170 vs GroupRoom.kt:120-121）；@名 剔除弱化见 W3-3 ✅（主体一致）

### ② 开新一轮无双发
- groupRoundCreateBody 语义逐字对齐：开启语「新一轮讨论已开启（第 N 轮）。」+【上轮结论】≤400 码点（:17448 vs GroupChat.kt:62-66）；mode=orchestrate + memberAgentIds 副本 + title=群名（第 N 轮）+ projectId 条件携带（:17449-17450 vs :67-73）；roundNo = rounds.length + 2（:17447 vs :206）✅
- **用户文本单次发送**：create body message 只装轮上下文（:17448-17450 不含用户文本）→ 平台建任务后 POST /tasks/:id/messages 投递用户文本**一次**（:17460）✅；单飞防重入 sending/creatingRound/busy 三闸（:17423）✅

### ③ 结束本轮时序与失败路径
- 时序：cancel（:17487）→ POST rounds（:17488）→ PUT channelRef:''（:17489）→ 本地置空——**cancel 失败 throw，channelRef 不误清**（:17493 只置错误行）✅；轮转段同构（:17439-17441）✅；二次确认弹窗（:17476-17479）✅
- 轮转/结束轮的 PUT 失败自愈性：cancel 幂等 + rounds 去重幂等，重试即恢复 ✅（开新轮段例外见 W3-4）

### ④ 弹窗规范与错误行
- 静态色值：群段（:17157-17785）grep `#hex/rgb()/rgba()` **零命中**，全部 var(--dsw-* / --pri / --warn / --tx2 / --tx3 / --err) 令牌（徽标 :17290、历史横幅 :17346、折叠行 :17398、头像 :17404 等逐处核对）✅
- 错误行去重：groupSetErr 以 key=类型:taskId + 10s 时间窗去重（:17211-17214；键形态 send:/task:/end:/archived/history），重试成功 groupClearErr 清除（:17463）——契约 §4.5 口径 ✅
- 弹窗规范：删除群二次确认（:17654-17665）、危险操作红色警示文案 ✅；esc() HTML 转义覆盖用户可控字段（群名/成员名/公告/taskId/分组名，抽查 :17266,17274,17293-17294,17347,17538-17554,17655）✅

### ⑤ REST 字段与契约 §2 一致性
- 列表：GET /groups + GET /group-sections（:17220-17221）；未读徽标 = turnsCount-lastReadSeq 钳 0，fallback unreadCount（:17227-17231，契约 §4.1）✅
- 已读：历史轮不计（historyId 非空不 POST，:17324）；条件触发（seq>lastReadSeq || unreadCount>0，:17326）；POST /read {lastReadSeq} 响应回写 room（:17327）；3s 轮询并发由服务端 max 单调兜底 ✅
- 轮转/历史：GET/POST /groups/:id/rounds（:17314,17439,17488）；历史轮只读（拒发 :17426、只读横幅 :17346-17347、footnote 提示 :17375）✅
- channelRef：轮转清空 PUT ''（:17440）、开轮回写 PUT newId（:17455）——string|"" 形态合法 ✅
- 群设置 patch 全字段（:17635-17647）：name:''（留空=渲染期拼接 ✓）、notice 前置 2000 码点校验（:17630）、mode/notifyLevel select 枚举固定（:17559-17560）、adminAgentId ∈ memberAgentIds 前置校验（:17632）、activeProjectId ∈ projectIds 前置校验（:17764 向导 / chip 切换 :17367）+ 服务端归一化双保险、archived 布尔 ✅
- 分组管理：POST {name} 重名幂等 toast（:17590-17592）、DELETE encodeURIComponent（:17597）、PUT {to} SECTION_CONFLICT 文案映射（:17615-17616）✅
- 轮询：3s setInterval（:17308 对齐 Android delay(3000)）、open 先 stop 防双 timer（:17307）、close 停表（:17310-17311）✅

## 待办与流转

- ~~⛔ W3-0 热修~~ → 已完成闭环（lead 确认 BUILD 绿）。
- **修复清单已派 programmer（lead 2026-11-11）：W3-1 / W3-2（按裁定停用调用侧）/ W3-4 / W3-5（按裁定前置建分组）/ W4-2**，完成后本报告追加复核记录；W3-6 知情归档。
- W3-2 请 lead 定夺折叠重复分支口径（对齐 Android 关闭 vs 契约补注保留）；W3-1/W3-3/W3-5 建议 programmer 修复（局部改动）；W3-4 建议补偿路径；W3-6 知情接受。
- W3-5 若选服务端级联方案需 lead 改契约（§2 POST/PUT /groups 级联 addSection）。
- 视觉/交互面由 ui-designer 走查（docs/ui-review-web-groups.md），本报告不覆盖。
- task-6 解锁后本报告并入 REV-6 汇总。
---

## 复核记录 · WEB-3 第二轮（2026-11-11，六项修复逐项验证 → 5 过 1 返工）

| 原条目 | 修复验证 | 结论 |
|---|---|---|
| W3-1 折叠行原文 | 摘要行 + gx-detail 隐藏区结构（src/web-ui.ts:17407）：detail = line.turns 逐条 esc(agentName)：esc(text)（:17406）；点击切换 display 与 ▸/▾（:17420-17428）；「折叠不拦截继续发言。」脚注。轮询重渲染重建 DOM 不丢数据 | ✅ 通过 |
| W3-3 @名归一化 | 第一段正则变体已加（src/web-ui.ts:17167-17173 try/catch 退化 + 第二段 split-join 保留），**但转义字符类拼写错误致转义功能失效（见下）**，未达「与 Android 双段清除逐字对齐」验收声明 | ⚠️ **返工** |
| W3-4 孤儿补偿 | PUT channelRef 包 try/catch（src/web-ui.ts:17469-17474）：失败即 cancel 刚建任务（二次失败静默留任务中心）+ 抛「频道绑定失败（已回滚新建任务）」——重试不再留无主频道。弱备注：cancel 二次失败时文案仍称「已回滚」，与事实有偏差（任务实际留存任务中心），知情可接受 | ✅ 通过（含弱备注） |
| W3-5 先建分组 | 群设置保存（src/web-ui.ts:17654-17658）与向导创建（:17794-17796）两处：section 非空即先 POST /api/group-sections（重名幂等 added:false 放行）再落群；groups.ts 未动（容差为服务端既有行为，契约 §2:69 两点齐备） | ✅ 通过 |
| W3-2 重复判定停用 | 调用侧不传 priorBodies（src/web-ui.ts:17203），判定代码原样保留于 groupIsIdleRelayText（:17179-17188，传参即生效），注释标注契约裁定与遗留池（:17202） | ✅ 通过 |
| W4-2 mcp 示例 | workbuddy-mcp/SKILL.md:98 群行补最小示例 {"action":"list"} | ✅ 通过（归档于 review-web-4.md） |

三绿复核：typecheck 0 错 / test:unit 370/370 / build EXIT=0（programmer 报告，lead 侧可独立复跑）。

### ⚠️ W3-3 返工项 · 转义正则字符类失效（node 实测证据）

src/web-ui.ts:17167 GROUP_NAME_ESC_RE 拼出的正则源为 `[.*+?^${}()|[]\\]` —— 字符类在 `|[` 后被**未转义的 ]** 提前终止（类实际 = `.*+?^${}()|[`，余下的 \\ 与 ] 落在类外被当作字面序列）。node 实测（当前实现）：

- `a.b` → 转义后仍 `a.b`（. 未转义）→ 构造 `@a.b\b`：`@aXb` 会**误命中删除**
- `c+d` → `@c+d\b`：`@cd` **漏删**、`@cccdb` 误命中
- `name[1]` → `@name[1]\b` 中 [1] 变字符类：命中 `@name1`、**漏删目标 `@name[1]`**
- `(x` 类不配对名 → RegExp 构造抛错 → try/catch 退化 split-join（兜底有效，不崩溃）

即第一段清除对常见元字符名实际失效、语义错位（误删/漏删并存）；仅不配对名走了兜底。try/catch 保证无崩溃、无回归，影响面限于折叠判定输入归一化（子智能体名罕用元字符），级别维持 ⚠️，但「逐字对齐 Android 双段清除」的验收声明不成立，须返工。

**返工写法（已 node 验证）**：`new RegExp('[.*+?^' + '$' + '{}()|[' + '\\]' + '\\\\' + ']', 'g')` —— 正则源 = `[.*+?^${}()|[\]\\]`（类含转义的 ] 与 \）。验证结果：`a.b`→`a\.b`（自命中且 `@a.bx` 不误命中）、`c+d`→`c\+d`、`name[1]`→`name\[1\]`（字面命中目标、不再误配 `@name1`）、`x\y`→`x\\y`，全部正确转义。

### 结论

- ⛔ 维持 0（W3-0 已闭环）；六项修复 **5 通过 + 1 返工**（W3-3，⚠️ 级不阻塞 ⛔ 门禁，但须返工复核后方可完全闭环）。

---

## 复核记录 · WEB-3 第三轮（2026-11-11，W3-3 返工闭环 → 全部通过）

**验证方法升级**：不再只看 TS 源层（三层转义易错），直接从 **build 产物** dist/.page-check-console.js:14182 提取页面真实 JS 行（两/四层形态），node eval 构造正则并跑用例——验证的是产品运行时行为本身。

| 验证项 | 结果 |
|---|---|
| 正则源逐字一致性 | 产物构造 regex source = `[.*+?^${}()|[\]\\]`，与 expert 验证写法期望源**逐字一致**（JSON.stringify 对比 true） | ✅ |
| 元字符转义 | `a.b`→`a\.b`、`c+d`→`c\+d`、`a]b`→`a\]b`、`x\y`→`x\\y`、`成员A_1` 原样——全部正确 | ✅ |
| 误删回归 | `@a.bx` 不命中（旧缺陷已消除）、`@a]bx` 不命中、`@x\yx` 不命中、`@成员A_1x` 不命中 | ✅ |
| `\b` 词边界语义 | `(x)`/`name[1]` 以非词字符 `)`/`]` 结尾：后接非词字符（空格）无边界→自命中 false；后接词字符→命中。**与 Android `@名\b`（GroupRoom.kt:117 Regex.escape+\b）语义逐字一致，双端行为对齐** | ✅ |
| 兜底路径 | 转义正确实现下不配对名（如 `(x`）构造不再抛错（`\(` 已转义即合法）——try/catch 兜底对元字符名不再触发、保留防御价值 | ✅ |
| 三绿 | typecheck 0 / test:unit 370/370 / build EXIT=0（programmer 复验） | ✅ |

**复核过程诚实记录**：expert 首版验证脚本曾两次误判（①`(x)`/`name[1]` 自命中 false——实为 `\b` 对非词字符结尾名的固有语义，Android 同款，非缺陷；②「不配对名未抛错判异常」——转义正确后构造本就不抛错，该用例仅适用于未转义的旧实现）。修正预期后判定 **PASS**；programmer 的 8 项 node 自证与产物级验证结论一致。

**结论：W3-3 返工闭环，WEB-3 六项修复全部通过，review-web-3.md 完全闭环（⛔0 / ⚠️0 未决）。**

---

## 复核记录 · WEB-3 收尾批次（2026-11-11，ui-designer 走查修复项 G-W-P0-1 / P1-2/4/6/7/8 闭环）

| 走查条目 | 修复验证 | 结论 |
|---|---|---|
| ⛔ G-W-P0-1 新分组静默清空 | openGroupSettings 下拉 options 并入 room.section 游离值（src/web-ui.ts:17570-17571 unshift 回显）防保存静默清空；与 W3-5 组合：存量游离值回显可选 + 新流先建分组不产生游离值 + 保存幂等补建（applyGroupSettingsPatch W3-5 逻辑把存量游离值补建为正式分组，分组管理从此可见可管理）——**存量+增量+补建三重闭环** | ✅ 闭环 |
| ⚠️ P1-6/7 归档/移除成员确认 | 合并单次「确认保存破坏性变更」弹窗（:17649-17662）：reasons 检测归档方向（patch.archived && !room.archived）与移除成员（差集列出成员名），skipConfirm 二段式确认后才落库 | ✅ 闭环 |
| ⚠️ P1-8 破坏性确认键色 | openModal 按钮渲染消费 danger 标志（style="color:var(--err)"），确认删除/确认保存均为破坏色 | ✅ 闭环 |
| ⚠️ P1-2 建群成员门槛 | 向导收紧 ≥2（:17795「请至少选择两位成员」）；**门槛权威口径裁定见下** | ✅ 闭环（含裁定） |
| ⚠️ P1-4 三档名/静默 hint | 档名 GLOSSARY 化落地：群列表行（:17301）与设置下拉（:17582）均「全部提醒/仅@我/静默」✅；**静默档 hint 子项未落地**（gs-notify 无 hint 文本）——弱项随 ui-designer 复查；另 GS_NOTIFY 死变量残留旧文案（:17547，无引用不可达，建议顺手删除） | ✅ 主体闭环（hint 小尾巴） |

### P1-2 门槛权威口径裁定（lead 提请，结论入 REV-6）

**Android 实测基线 = ≥1**：CreateGroupWizard.kt:145 `if (selected.isEmpty()) { msg = "请至少选择一位成员"; ... }`——isEmpty 即 ≥1；CreateGroupWizardTest 无门槛用例佐证。ui-designer 引用的「Android 基线 ≥2」实为 **spec §4.3-⑥ 文档口径**（「群聊至少需要两名成员」）——上游文档与 Android 实现自身不一致（Android 是偏离方）。
**裁定：Web 收紧为 ≥2 可接受。** 理由：①群协作语义本质至少两名成员；②Web 收紧后反而贴合 spec §4.3-⑥ 文档口径；③运行时文案明示（「请至少选择两位成员」），用户可感知；④跨端数据兼容——Android 建的单人群在 Web 可正常查看/管理（≥2 仅收紧建群入口，不影响存量）。附注记遗留池：上游「spec §4.3-⑥ vs Android 实现」不一致由 lead/Android 侧择机对齐（Android 补校验或 spec 修订），非本次范围。

### 破坏性动作覆盖盘点（lead 问题④）

- 归档 ✅（P1-6 合并确认：reasons 含「终止成员当前回合，频道任务取消，历史轮保留只读」语义）、移除成员 ✅（P1-7 合并确认：差集列名）、删除群 ✅（独立确认 + danger 键 + 「不可恢复」红字 + 任务保留语义）、结束本轮 ✅（独立确认）——**四动作无漏网**。
- 第五处候选「删除分组」：级联影响 = 引用群变未分组（可逆：重新选分组即可），低危且 Android removeSection 同款无确认——不确认可接受（走查报告 L187 亦仅「建议顺带」非正式条目），知情归档。
- 恢复（取消归档）方向无确认：与 Android restore 无确认**双端一致**（spec「恢复同」超前于双端实现），可接受记备注——同一 upstream 文档债模式（spec 超前），与 P1-2 一并归入遗留池「spec 文档对齐」条目。

三绿复核：typecheck 0 / test:unit 371/371（含 AND-2 新用例）/ build EXIT=0；Android 179 tests 0 failures。

**结论：收尾批次全部通过，WEB-3 + AND-5 报告完全闭环（⛔0 / ⚠️0 未决，仅 P1-4 hint 小尾巴与归档备注）。REV-6 汇总就绪。**

### 补记 · P1-4 静默 hint 闭环（2026-11-11，programmer 清尾复核）

- 静默档 hint 落地（src/web-ui.ts:17582，gs-notify 下拉下方）：文本与 Android GroupSettings.kt:329 **逐字一致**（「静默档 ask_user 只保留首页红点，不响铃不进通知栏。」）——P1-4 全子项闭环。
- GS_NOTIFY 死变量已删（grep 零残留）。
- 三绿复验：typecheck 0 / test:unit 371/371 / build EXIT=0。**WEB-3 报告至此无任何未决项。**

---

## ⛔ G-W-P1-6/7-R1 · 复验发现：破坏性确认门销毁表单 → 确认后全字段清零（数据丢失级）

- **登记依据**：ui-designer 复验发现（lead 2026-11-11 转入）；expert 独立核实机理属实且范围更大——不只成员清零，是**除 archived 外全字段清零**。
- **丢数全链路（现行代码）**：openModal 确认弹窗替换 #modal-body **销毁群设置表单 DOM**（src/web-ui.ts:17656）→ 确认回调 `saveGroupSettings(room, true)`（:17659）二次调用 → `collectGroupSettingsPatch(room)` 重读 DOM（:17665-17689）：gs-member/gs-proj checkbox 不存在 → memberIds=[]/projectIds=[]；gs-name/gs-notice/gs-admin/gs-section/gs-perm 不存在 → val() 全空串（仅 archived 因 `el ? ... : room.archived` 兜底幸免，:17689）→ **patch = 全空**（且 removed = 原成员全集 → 若 skipConfirm 路径走确认门会列出「移除成员：全员」，但 :17659 skipConfirm=true 直接跳过拦截）→ applyGroupSettingsPatch PUT 落库 → **服务端群名/公告/管理员/成员/项目/分组全被清空**。
- **根因**：二段式确认（第一段 collect、第二段重 collect）依赖同一份 DOM 存活——openModal 模态复用 #modal-body 与表单互斥。
- **修复方向（lead 已转 programmer：开门前快照、确认回调禁 DOM 重读）**：第一段 collect 的 patch 闭包捕获（或模块级 pendingPatch 暂存），确认回调直接 `applyGroupSettingsPatch(room, patch)`，**严禁**在确认回调内再次 collect；取消路径闭包置空。附带回归测试建议：模拟确认后 patch 深等第一段快照（memberIds/notice 不变）。
- **复核方法教训（expert 自省，入 REV-6）**：第一轮 P1-6/7 复核验证了 reasons 判定逻辑与二段式流程正确性，**未追踪「确认后执行路径」的输入来源**（DOM 生命周期）——确认类 UI 修复的复核必须覆盖确认回调的数据来源链。
- **状态**：⛔ 未决（programmer 热修中）；热修 + ui-designer 复验通过后本条出闭环记录，REV-6 解锁随之。

---

## 闭环记录 · ⛔ G-W-P1-6/7-R1 热修（2026-11-11，代码级 + 产物级双验证 → 闭环）

| 验证项 | 结果 |
|---|---|
| 快照唯一 DOM 读取点 | saveGroupSettings(room) 开门内 `var patch = collectGroupSettingsPatch(room)`（src/web-ui.ts:17648），注释明示「此处是唯一 DOM 读取点」；gs-member/gs-notice/gs-name 运行时读取仅存在于 collect 函数内（:17669-17678），其余命中均为表单 HTML 构造/计数事件 | ✅ |
| 确认回调禁重读 | 确认按钮 = `applyGroupSettingsPatch(room, patch)` 直用闭包快照（:17660），二次 collect 路径不存在 | ✅ |
| skipConfirm/force 零残留 | 源与产物 grep 均零命中（`saveGroupSettings(room, true)` 0 处；KDoc「force 路径已删除」约束固化在产物 :17647-17649） | ✅ |
| reasons 判定 | 保留于快照上（归档方向 + 移除成员差集列名），确认门语义不变 | ✅ |
| AND-2 无交互 | 快照 patch.unreadCount 照收口径不变；服务端 max 仅钳 lastReadSeq，互不干扰 | ✅ |
| 三绿 | typecheck 0 / test:unit 371/371 / build EXIT=0（programmer 复验） | ✅ |

**验证方法说明**：本条为纯 DOM 生命周期修复，node:test 无 DOM 框架无法单测——行为级验证由 ui-designer 复验承担（打开确认门→确认→patch 与第一段快照深等），expert 完成代码级 + **build 产物文本级**双验证（产物即页面运行时真实代码形态，R1 修复链路三要素——快照行/回调应用行/KDoc 约束——均在产物中确认）。登记条目中建议的「回归测试断言 patch 深等快照」在无 DOM 测试框架现状下以 ui-designer 复验替代，合理。

**结论：⛔ G-W-P1-6/7-R1 闭环。** REV-6 解锁剩余条件：ui-designer 五点终版走查（含本热修行为复验）。

---

## ⛔ G-W-P0-3 · 复验发现（预存在缺陷）：GROUP_IDLE_RE \s 双层转义丢失 + :17173 词边界退格化（连带审计）

- **登记依据**：ui-designer 运行时复验发现 + lead 扩大判断；expert 已完成**产物字节证据 + 语义还原对照实测**（双实锤，见下表）。
- **缺陷一（:17164 GROUP_IDLE_RE）**：TS 源模板串 \s → 页面字符串 \s（单层）→ 页面 JS 字符串无用转义丢反斜杠 → **正则分隔符类 = 字面字母 s**。产物字节证据：dist/.page-check-console.js 群段行含单层 \s（JSON.stringify 实锤）。**语义还原对照实测**：

| 样本 | 坏实现（产物现状） | 好实现（修后目标） |
|---|---|---|
| 「收到 待命」（混排空格） | **false 永不折叠** | true |
| 「ok done」（英文空格） | **false 永不折叠** | true |
| 「好的，收到」（中文标点） | true | true（不受影响） |
| 「好s」（**误折叠方向，lead 未上报**） | **true 误命中** | false |
| 「讨论 s 曲线」/「研究 standby 的话题」 | false | false |

  => 双向都坏：混排/英文空转**漏折叠**（违 §4.9）＋含 s 消息**误折叠**（如「好s」）。
- **缺陷二（:17173 词边界，lead 扩大判断实锤）**：页面行第三段字面量 \b → 页面字符串值 = **退格符 U+0008**（b 是 JS 合法转义），非词边界。实测：剔除「谢谢 @Bot ，收到」中 @Bot → **false**（退格符在正常文本中永不出现 → 第一段正则变体**构造成功但完全失效**），全靠第二段 split-join 字面清除兜底掩盖。越界 @BotX false 属「失效下的碰巧正确」——**expert W3-3 验证盲区实锤**：当时自测脚本用正确词边界构造（测试替身），验证的是「若词边界正确则行为正确」的循环命题，且产物级只 eval 了 GROUP_NAME_ESC_RE 一行、:17173 行仅文本 grep 未 eval——**判据缺「正应命中」正例 + 验证载体未逐行落地**，与 R1 的 DOM 生命周期盲区同源。
- **审计清单（群区 3 处正则）**：①GROUP_IDLE_RE（:17164）坏 ✅上表；②:17173 词边界 坏 ✅本表；③:17170 @全员字面量正则无转义层数问题，实测 @所有人 命中正常，无恙。W3-3 的 GROUP_NAME_ESC_RE 产物 source 此前已验证正确（不受本缺陷影响）。

## 修复验收判据（programmer 产物运行时自证逐条，expert 闭环时复跑）

1. GROUP_IDLE_RE 产物 regex source 分隔符类必须含 \s（即 [\s，,、。.!！~～：:；;]，页面行字节必须双层 \\s；**禁止裸 s**）。
2. 正例逐条 true：「收到 待命」「ok done」「好的，收到」（可加换行样本覆盖 \s 的换行语义）。
3. 误命中回归逐条 false：「好s」「讨论 s 曲线」「研究 standby 的话题」。
4. :17173 页面行第三段字节必须双层 \\b；正例「谢谢 @Bot ，收到」第一段可剔除（真词边界）、越界「谢谢 @BotX ，收到」不剔除。
5. 三绿复验 + 本报告闭环复跑（expert 以同法对产物再验）。

- **状态**：⛔ 未决（programmer 群区正则全量审计修复中）；修复+自证后本条出闭环记录，REV-6 解锁随之。

---

## 闭环记录 · ⛔ G-W-P0-3 群区正则审计修复（2026-11-11，expert 产物级同法复跑 → 全 PASS 闭环）

**复跑方法**：与 programmer 自证同法（build 产物 dist 提取页面行整体 eval，零替身），判据 5 条逐项：

| 判据 | 结果 |
|---|---|
| 1. GROUP_IDLE_RE source 分隔符类 | "\\s，,、。.!！~～：:；;"——以 \s 开头（双层字节），**无裸 s** | ✅ |
| 2. 正例 | 「收到 待命」「ok done」「好的，收到」「收到，待命」「got it」「waiting for the next steps」**全部 true**（混排/英文空格/中文标点/换行与英单词语义全覆盖） | ✅ |
| 3. 误命中回归 | 「好s」「讨论 s 曲线」**全部 false**（坏实现下「好s」误折叠已消除） | ✅ |
| 4. 词边界第三段 | 页面值 codepoints **92,98**（\b 真词边界；坏实现为 8 退格） | ✅ |
| 5. 三绿 | typecheck 0 / test:unit 374/374（含 groups-confirm.test.ts 确认门回归 3 项）/ build EXIT=0 | ✅ |

**连带审计闭环**：:17173 同行 replace 第二参双层修复（页面字面量值 codepoints **92,36,38** = \$& 字面反斜杠+匹配，修前 36,38 = $& 匹配本身即转义失效）——escape(a.b)="a\\.b" 含字面反斜杠、自命中 true / 越界 false ✅；@全员字面量正则无恙（未动）✅；GROUP_NAME_ESC_RE 构造未动（作拼接先例）✅。

**复跑脚本插曲（诚实记录，方法论教训加条）**：expert 复跑脚本首版「return IDLE」变量名与产物定义（GROUP_IDLE_RE）错位，连续误报 IDLE undefined 触发三轮无关排查——**验证脚本自身的变量名/作用域也是需要被验证的对象**（dbg4 的 typeof probe 早已给出正确信号）。与 R1/P0-3 两条盲区并列入 REV-6 方法论教训第 3 条。

**结论：⛔ G-W-P0-3 闭环。** WEB-3 报告全部条目（R1 + P0-3 + 收尾批次）无未决项。
