# review-web-2 · WEB-2 MCP 工具 workbuddy_group_manage 审查报告

- 审查人：expert ｜ 任务板：task-2 (WEB-2, rev4) ｜ 契约：docs/groups-web-sync-plan-2026-11-11.md §3（含 §3:75 AI 令牌裁定、§3:78 单实例装配裁定）
- 审查对象：src/tool-contracts.ts（群契约登记）、src/tool-policy.ts（风险档 + AI 令牌拒绝）、src/tool-ops.ts（groupManage 工具 + 中央 wrapper）、src/server.ts（单例装配）、capabilities 派生验证、三份测试增量
- 审查基线：review-web-1.md 预研备忘 P5/P11/P12/P13 + 契约裁定增量表 + lead 追加两对账点（GroupStore 实例化点 grep、server.ts 装配范围）
- **结论：⛔ 0 项；⚠️ 3 项（均非阻塞，1 项转 task-4）；三条已知取舍全部裁定接受。WEB-2 复核通过。**

---

## 结论速览

| # | 级别 | 条目 | 位置 |
|---|---|---|---|
| W2-1 | ⚠️ | server.ts 装配行数与声明不符（实际 import+单例+两处注入 4 处 + 顺手补传 serverVersion）；工作树 diff 另混有在途 readOnly 令牌功能，非本次写入但需 lead 知情确认归属 | src/server.ts:212,286,304 |
| W2-2 | ⚠️ | list compact 返回字段集为硬编码子集，契约未定义；SKILL（task-4）需写明，防 AI 调用方误判缺字段为数据丢失 | src/tool-ops.ts:994-997 |
| W2-3 | ⚠️ | createdBy 在工具通道缺 username 时回退 userId（取舍③，已接受）；建议后续为 ToolPolicyContext.session 增补可选 username 字段，使契约 §1「登录用户名」在全部通道无降级 | src/tool-ops.ts:986-987 |

无 ⛔。

## ✅ 对账通过项

### 三处登记同步（P12 硬需求，缺一即全 deny）
- **tool-contracts.ts**：groupRoom 对象契约（:51-56，字段名与契约 §1/Android GroupRoom JSON 逐字一致；mode/notifyLevel choice、计数字段 integer(0)、数组字段）；12 actions actionContract（:87-93，含 lastReadSeq: integer(0) 与 REST 非负整数口径一致）；运行时分支校验（:252-259：roomId×6 分支、create 需 room、update 需 room 对象、add/remove_section 需 name、rename 需 old+to、add_round 需 taskId、mark_read 需 lastReadSeq）✅
- **tool-policy.ts**：rules 风险档 12 action 照契约 §3 逐字对齐（:38：list/get/sections/rounds=read；create/update/*_section/add_round/mark_read=write；delete=write,destructive）；fail-closed 保证未登记 action 一律 deny（:78-80 既有机制）✅
- **tool-ops.ts**：WorkBuddyToolDef 注册（:960-1064）；WORKBUDDY_TOOL_NAMES 自动含新工具；defs.length===18 断言（src/tool-contracts.test.ts:40）✅
- **capabilities 派生验证**（契约 §3「若需同步登记」实为验证点）：capabilitySnapshot 从 defs+policy 自动生成（src/capabilities.ts:11），group_manage 的 actions/risks 无需手改，已由测试覆盖 ✅

### AI 令牌拒绝（裁定③/⑤ · 三层防御 + 先身份后校验）
- **policy 层**：aiTokenOnly → group_manage 全 12 action（含只读）deny（src/tool-policy.ts:88；测试 src/tool-policy.test.ts:135「denied on all 12 actions (no shared bucket)」，含 admin 角色混入不放行与 readOnly 档用例）✅
- **wrapper 层**：denyAiToken 声明位（src/tool-ops.ts:171-172）+ 拦截先于 validateToolArgs（:1940-1943 在 :1944 之前）——「先身份后校验」有直接测试证明：空参数 + aiTokenOnly → AI_TOKEN_DENIED 而非 INVALID_PARAM（src/tool-ops.test.ts:540-543）✅
- **工具层双保险**：直达 execute 也拒绝（src/tool-ops.ts:977-981），防未来 wrapper 变更绕过 ✅
- **身份边界（P13/裁定⑤）**：身份只取通道 ctx.session.userId，工具参数混入 session/userId 不生效（src/tool-ops.test.ts:545「身份只取通道，不取工具参数」）✅
- **无登录会话 → UNAUTHORIZED 401 不落共享桶**（src/tool-ops.ts:984-985；src/tool-ops.test.ts:546-547），与 REST groupUser()（router.ts:5046-5050）双通道同口径（P5）✅

### 单实例装配（裁定 A · lead 追加对账点①②）
- **对账点①**：全仓 `new GroupStore` 仅 src/server.ts:212（生产单例）与测试（src/groups.test.ts、src/tool-ops.test.ts:533）；router.ts:169 懒建兜底已拆除改为 throw 断言（「GroupStore 未装配：server.ts 必须注入单例实例」）；tool-ops deps.groupsStore 可选仅测试兜底（src/tool-ops.ts:183-184 注释明确禁止懒建）——**通过** ✅
- **对账点②**：task-2 实际装配变更 = import（server.ts:39）+ 单例（:212）+ router 第 16 参（:286）+ defs deps（:304）共 4 处；另有顺手补传 `serverVersion: pkgVersion()`（:304，deps 接口既有可选字段首次传值，capabilities 快照 serverVersion 由 'unknown' 变真实版本）——见 W2-1。契约 §3:78 裁定原文（server.ts 建一次双路注入、禁模块级单例注册表）与实现一致 ✅

### 工具语义与错误风格（P11）
- 12 action 语义与 REST 同源同库（同一 groupsStore 单例，src/tool-ops.ts:959 注释禁止旁路直改 JSON）：create 缺 id randomUUID（:1007-1009）、update 部分合并走 normalizeGroupRoom mergeBase（:1015）、delete 幂等 {deleted:false}（:1019，与 REST 契约 §2:65 修订后口径一致）、rounds/add_round/mark_read 群不存在先 notFound（:1032,1037,1042）、mark_read 非负整数 400（:1043-1044）、rename_section 409（存储层 SECTION_CONFLICT 经 :1053 映射）✅
- 失败路径全部过 normalizeToolResult（:983,985,989,1044,1061）→ category/recovery 结构化恢复；nextAction 人话提示分场景（SECTION_CONFLICT/STORE_UNHEALTHY/STORE_WRITE_FAILED/INTERNAL_ERROR 各自提示，:1054-1060）——契约 §3「错误返回带 nextAction」与 recovery 两套并存，P11 既有惯例 ✅
- NOT_FOUND 附「用 list 查看当前登录用户可见的群（每用户隔离，跨用户不可见）」（:989）——与 REST 跨用户 404 防枚举口径一致，不泄露他人群存在性 ✅

### 测试覆盖
tool-policy.test（风险档全枚举 + aiTokenOnly 全 12 拒绝 + admin 混入 + readOnly 档）、tool-ops.test（先身份后校验证明 / UNAUTHORIZED / CRUD+幂等+单调+409 nextAction+NOT_FOUND+compact 全链路）、tool-contracts.test（18 工具 + 分支必填校验）。typecheck 0 错、test:unit 370/370 绿（lead 独立复跑）✅

## ⚠️ 详情

- **W2-1（server.ts 范围与归属）→ 已裁定（lead 2026-11-11 确认）**：git 只读 diff 显示 server.ts +33/-10，其中 task-2 群装配仅 4 处（见上）；其余为 **WORKBUDDY_READONLY_TOKEN 只读令牌功能块**（timingSafeEqual/isReadOnlyToken/readOnly 通道门禁/工具通道 ctx 注入 readOnly 等）。**归属裁定：在途历史改动，非 task-2 写入**——lead 证据：本会话首次 git status（2026-11-11 08:43，任何队员开工前）已列出 M src/server.ts；与 expert 复核时点证据（第一轮读 server.ts:641-658/685/696 时该块已存在）相互印证，契约 §7「在途未提交改动」适用。无问题，task-2 通过。附注：后续任务声明变更范围建议以「本次新增行」为口径，避免与全树 diff 混淆。
- **W2-2（compact 字段集未入契约）**：list compact=true 返回硬编码子集（id/name/section/archived/unreadCount/lastReadSeq/memberAgentIds/channelRef/activeProjectId，省略 notice/permissionOverride/createdBy/时间戳/投影字段，src/tool-ops.ts:994-997）。契约 §3:72 只写 `compact`（list）未定义字段集。AI 调用方可能把省略误判为数据丢失。处置：**转 task-4**——skills/groups.md 需写明 compact 返回字段集与非 compact 全量口径。
- **W2-3（createdBy 降级口径）**：见取舍③裁定。非阻塞。

## 已知取舍裁定（programmer 提请三条，全部接受）

1. **AI_TOKEN_DENIED 的 category 归类**：normalizeToolResult 对带 status:403 的错误经 errorCategory 实际归类 **PERMISSION_DENIED**（src/tool-errors.ts:23 `status === 403` 分支，与 SSH PERMISSION_DENIED 先例同构）——比「category=code 自身」的预期更优；recovery=stop（不可自动重试，拒绝是永久性）正确。**接受**。
2. **wrapper 层 AI_TOKEN_DENIED 原样返回未过 normalize**：与 denyAiTokenSsh 先例（src/tool-ops.ts:94-97）完全同构，错误文本自含 nextAction 人话（「请在控制台登录后操作」）；normalize 也不会给永久性拒绝置 retryable，不损失结构信息。**接受**（一致性优先）。
3. **工具通道 createdBy 回退 userId**：PermSession 类型仅 userId/role（src/tool-policy.ts:6），HTTP/MCP 通道运行时 session 实际携带 username 并被取用（src/tool-ops.ts:986-987），仅类型声明缺字段；主流 REST 控制台 createdBy=登录用户名满足契约 §1。回退为可接受降级。**接受**，改进建议见 W2-3。

## 待办与流转

- ~~W2-1 请 lead 确认归属~~ → **已确认：在途历史改动，非 task-2 写入（lead 2026-11-11）**，闭环。
- W2-2 转 task-4：skills/groups.md 写明 compact 字段集。
- ~~W2-3 低优先改进~~ → lead 裁定**记入遗留池**（ToolPolicyContext.session.username 增补，本迭代不做）。
- task-6 解锁后本报告并入 REV-6 汇总。