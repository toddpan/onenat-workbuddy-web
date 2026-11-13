# review-web-4 · SKILL-4 群文档与工具登记审查报告

- 审查人：expert ｜ 任务板：task-4 (SKILL-4) ｜ 契约：docs/groups-web-sync-plan-2026-11-11.md §5
- 审查对象：skills/onenat-workbuddy/skills/groups.md（新增 76 行）、skills/onenat-workbuddy/SKILL.md（三处登记）、skills/workbuddy-mcp/SKILL.md（登记 + AI 令牌加粗）、skills/onenat-workbuddy/scripts/wb.mjs（HELP +1 行）、skills/workbuddy-mcp/scripts/wbmcp.sh（群零改动）
- **结论：⛔ 0 项；⚠️ 3 项（1 项为契约措辞与实现的口径差、1 项示例补缺、1 项在途改动归属知情）；wb.mjs 裁定点终审：认可。**

---

## 结论速览

| # | 级别 | 条目 | 位置 |
|---|---|---|---|
| W4-1 | ⚠️→✅ | 契约 §5 措辞已由 lead 修订（groups.md 以 MCP 为主，REST 属控制台/Android 契约面）——本条闭环，groups.md 现状即合规 | 契约 §5:93（修订确认） |
| W4-2 | ⚠️→✅ | 群行已补最小示例 workbuddy_group_manage {"action":"list"}——本条闭环（第二轮复核 2026-11-11） | skills/workbuddy-mcp/SKILL.md:98 |
| W4-3 | ⚠️ | tasks.md +9 行（preflight/稳定 ID 段）与 wbmcp.sh +188/-47 行均为在途改动（内容与群无关），非 task-4 写入；请 lead 按 W2-1 模式知情确认归属 | skills/onenat-workbuddy/skills/tasks.md、skills/workbuddy-mcp/scripts/wbmcp.sh |

## ✅ 对账通过项

### 1. groups.md（核心交付，逐节核）
- **身份边界置顶与契约 §3:75 一致**（groups.md:5-7）：全部 12 action 返回 AI_TOKEN_DENIED；wb.mjs / wbmcp.sh / 持 wbk- 令牌的 HTTP 工具通道不可用；只读旁观走 task_status / task_chat（channelRef 即任务 id）。令牌前缀 wbk- 经实现核实正确（src/auth.ts:163 `'wbk-' + randomBytes(24)`）✅
- **12 action 用法**（:11-26）与工具实现逐 action 对齐（含 compact:"true" 用法、update 部分合并语义注释）✅
- **幂等语义逐条**（:28-36）与契约 §1 + Android 基线对账全过：upsert 保位覆盖/追加末尾 + 服务端权威三字段；delete 幂等 + 级联清轮（无孤儿键）；add_section 重名 {added:false} + 空名 INVALID_PARAM；rename SECTION_CONFLICT（**含新旧同名**，与裁定④一致）+ 级联迁移顺序不变；remove 有效名幂等 + 级联置空串；add_round 去重保序 + **群不存在不落键**（裁定②口径）；mark_read max 单调 + 归零 + 非负整数 ✅
- **字段口径**（:38-43）：name 空=拼接、adminAgentId 空=无管理员、mode 双值默认 admin、channelRef 空=空闲、activeProjectId ∈ projectIds 归一化、notice ≤2000、notifyLevel 三值默认 mention、permissionOverride 空=沿用、数组去重保序、时间戳服务端维护——与契约 §1 逐字对齐 ✅
- **compact 字段集（W2-2 落实）**（:45-47）：九字段 id/name/section/archived/unreadCount/lastReadSeq/memberAgentIds/channelRef/activeProjectId 与实现（src/tool-ops.ts:996）**逐字一致**；省略字段列全 8 项（notice/adminAgentId/mode/projectIds/permissionOverride/notifyLevel/createdAt/updatedAt，9+8=17 与 GroupRoom 全字段闭合）＋「省略非丢失、用 get 取全量」防误判警示 ✅
- **channelRef 三步与编排关系**（:49-59）：①task_manage create（orchestrate + 轮开启上下文 message）→ ②group_manage update 写回 channelRef → ③task_manage send 用户正文一次（防双发）——与契约 §4/UI 实现（web-ui.ts:17445-17460）语义一致 ✅；结束轮三步 + 轮号口径「历史轮数 + 2 起算」与 groupRoundCreateBody 一致（:61）✅
- **典型流程**（建群→开轮→@点名→结束轮→回看）与**错误速查**（AI_TOKEN_DENIED / UNAUTHORIZED / NOT_FOUND 跨用户防枚举 / SECTION_CONFLICT / INVALID_PARAM / STORE_UNHEALTHY / STORE_WRITE_FAILED）与实现错误面一一对应（:63-76）✅

### 2. onenat-workbuddy/SKILL.md（契约 §5:82 三处登记）
- 核心概念加「协作群（Group）」（概念段）；路由表加一行 → skills/groups.md；工具速查加 workbuddy_group_manage（含 12 action 清单 + AI 令牌拒绝加粗）✅；「同一 16 个工具」→「同一 17 个工具」✅
- **范围说明**：diff 中另有 service-contract frontmatter、capabilities 优先叙述、WORKBUDDY_READONLY_TOKEN 只读体验段——为 server.ts 在途 readOnly 功能（W2-1 同源）的文档配套，非 task-2/4 群范围写入，与群对账无冲突 ✅

### 3. workbuddy-mcp/SKILL.md（契约 §5:84）
- 工具清单 16→17，group_manage 行含 12 action 与 **AI 令牌全拒加粗** + channelRef 即任务 id 的只读旁观指引 ✅

### 4. 脚本（契约 §5:85）
- wb.mjs：仅 HELP +1 行纯增量（群边界说明 + 控制台出路），无命令新增 ✅（终审见下）
- wbmcp.sh：diff 与群零关联（grep 'group' 命中 0），工具枚举为动态、群无需登记 ✅

## wb.mjs 裁定点终审（lead 第 4 条：零改动 + HELP 引导，是否认可）

**裁定：认可 programmer 处理（不加 group case + HELP 一行），不要求补 case。** 依据链：
1. **wb.mjs 非动态枚举**：每工具硬编码子命令（skills/onenat-workbuddy/scripts/wb.mjs:150-271 cmd 分发），契约 §5「若工具枚举为动态则零改动」不适用，字面上落入「仅允许纯增量登记」分支——争议点在此。
2. **加 case 必为死命令（事实成立）**：wb.mjs 鉴权用 WORKBUDDY_TOKEN = AI 令牌（wb.mjs:67「控制台设置→AI APIKEY 生成」），调用 /api/tools/:name 时 sessionUser 为空 → server.ts:685 aiTokenOnly=true → wrapper 先身份后校验拒绝（src/tool-ops.ts:1940-1943）→ **任何群命令 100% 返回 AI_TOKEN_DENIED**，无例外路径。
3. **「纯增量登记」的立法本意是让调用方知情**——HELP 行已完成知情且给出可行动出路（「群管理请用 Web 控制台群页签」），比一个必失败的命令更诚实；保留的 tools 命令（动态列服务端全部工具）仍会列出 group_manage（列表可见、调用被拒、HELP 解释原因）——知情链完整。
4. 若 lead 坚持字面加 case，唯一非误导形态是「显式拒绝命令」（打印边界说明而非转发调用）——较 HELP 行冗余，不建议。
- **建议**（可选）：契约 §5 补注一句先例口径「工具对脚本通道调用方不可用时，以 HELP/文档边界说明替代命令登记」，消除后续同类争议。

## ⚠️ 详情

- ~~**W4-1**~~ → **已裁定（lead 2026-11-11，契约 §5:93 已回写）**：groups.md 定位修订为「以 MCP 通道用法为主」，REST 属控制台/Android 契约面（§2）、不在 AI 开放面——groups.md 现状即合规，无需补 REST 节，本条闭环。
- **W4-2（mcp SKILL 缺示例）**：契约 §5:84「工具目录登记 + 示例」——群行只有表格登记。建议补一句最小示例（如 `call workbuddy_group_manage '{"action":"list","compact":"true"}'（仅控制台会话通道可用）`）或显式指向 onenat-workbuddy/skills/groups.md。
- ~~**W4-3**~~ → **已裁定（lead 2026-11-11）**：M tasks.md 与 M wbmcp.sh 均在本会话起点 git status（08:43，开工前）已列出——在途改动非本次写入，按 W2-1 模式归档，闭环。

## 待办与流转

- ~~W4-1~~ 已闭环（契约 §5:93 修订）；~~W4-3~~ 已归档（在途改动确认）。
- ~~W4-2~~ → **已修复并复核通过（第二轮，2026-11-11）**：SKILL.md:98 群行补最小示例。SKILL-4 全部对账项闭环，task-4 可 complete。
- wb.mjs 裁定已终审认可；先例口径已由 lead 补入契约 §5（工具对脚本通道不可用时以 HELP/文档边界说明替代命令登记）。无代码动作。
- task-6 解锁后本报告并入 REV-6 汇总。