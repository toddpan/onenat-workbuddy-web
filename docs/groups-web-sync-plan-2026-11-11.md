# 群功能 Web 同步改造 · 接口契约与执行计划（2026-11-11）

> 维护人：coordinator(lead) ｜ 上游事实源：onenat-workbuddy-android 仓库 P0 群功能（docs/plan-groups-p0-board.md、GLOSSARY.md、docs/ui-review-spec.md）
> 本文档是**全队唯一契约事实源**：Web 群实体、REST、MCP 工具、SKILL、Android 改造全部以此为准。改动契约必须先改本文档并在任务板声明。

## 0. 背景与目标

Android P0 红线「无平台群实体，群元数据只存本机 SharedPreferences」本次**反转**：

1. 把 Android 已实现的群及功能（群列表/分组、建群向导、群聊天频道、群设置、空转折叠、讨论轮）**同步到 Web 端**；
2. 群管理（CRUD/分组/讨论轮/已读）改由 **Web 端 REST 接口承载**，Android 端改为提交接口（本地 SharedPreferences 降级为缓存与纯本地偏好）；
3. 更新 Web **MCP 工具通道**（新增 `workbuddy_group_manage`）与 **SKILL** 文档。

## 1. 群实体契约（字段名与 Android GroupRoom JSON 逐字一致）

```
GroupRoom {
  id: string                  // UUID；客户端可自带，缺省服务端生成
  name: string                // 空 = 成员名拼接（渲染期语义）
  notice: string              // ≤2000 字，超长 INVALID_PARAM
  adminAgentId: string|""     // "" = 无管理员
  mode: "admin"|"everyone"    // 默认 admin（新建群=管理员主持）
  memberAgentIds: string[]    // 保序去重
  channelRef: string|""       // 当前频道 = orchestrate taskId
  projectIds: string[]        // 绑定项目 0..N，保序去重
  activeProjectId: string|""  // 必须 ∈ projectIds，否则服务端归一化为 ""（不报错，对齐 Android 宽松解析）
  section: string|""          // 首页分组名；分组删除时服务端级联置 ""
  createdBy: string           // 登录用户名（服务端填充，客户端值被覆盖）；工具通道 PermSession 无 username 时回退 userId（稳定唯一标识，lead 裁定 2026-11-11）
  archived: boolean           // 默认 false
  notifyLevel: "all"|"mention"|"mute"  // 默认 mention
  unreadCount: number         // 默认 0；允许客户端本地覆盖上报
  lastReadSeq: number         // 默认 0；markRead 单调不回退
  permissionOverride: string|"" // "" = 关（沿用各成员权限档）；非空 = 群内统一权限档
  createdAt/updatedAt: number // 服务端维护（毫秒）
}
```

- 每用户隔离：按登录身份（session userId）scope，跨用户不可见、不可改。v1 无共享群。
- 持久化：落 `$DSH_HOME/dsh-orchestrator-groups.json`（**生产部署由 server.ts 装配覆盖为全站 dataDir 惯例路径 `groups.json`，与 ssh-resources 同目录——lead 裁定采纳 2026-11-11；构造器默认路径保留 §1 字面供测试/独立部署**）；「仿 ssh-store」**只取 0600 + fs-perms 惯例**。落盘必须走 **tmp+rename 原子写**（src/store.ts 惯例）；**load 失败 / JSON 损坏时拒绝覆盖写**（保护现场，读出空表但写口不得清掉原文件）——违反 Android 基线「load 失败不得触发 save 清数据」（GroupStore.kt:31-33）即 ⛔。新文件 `src/groups.ts` 导出 `GroupStore` 类（list/get/upsert/delete/sections…/rounds…/markRead）。
- 幂等语义（逐条对齐 Android GroupStore，expert 审查基线）：
  - upsert：同 id **保位覆盖**内容；新 id **追加末尾**（列表渲染顺序不抖动）。
  - delete：不存在静默幂等；同时清 `rounds:<id>` 孤儿键。
  - 分组 add：重名幂等 → `{ok:true, data:{added:false}}`；rename：旧名不存在或新名已存在 → 409 `SECTION_CONFLICT`，且**级联**迁移/清除 rooms.section（不留孤儿引用）；remove：不存在幂等，级联置 ""。
  - rounds add：同 taskId 去重保序；markRead：`lastReadSeq = max(current, 入参)` 且 unreadCount 归零。
  - **upsert/PUT 单调钳制（AND-2 裁定 2026-11-11 expert 复核）**：POST/PUT /api/groups 落库时 `lastReadSeq = max(现值, 入参)`（unreadCount 照收）——根除「读口回退本地缓存后 upsert 把 stale lastReadSeq 写回服务端」的整类回退，与 /read 单调语义（§1:32）对齐；补测试。

## 2. REST 契约（router.ts；响应包络与既有 /api/* 一致 `{ok:true,data}` / `{ok:false,error}`）

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | /api/groups | 当前用户全部群（保索引序） |
| POST | /api/groups | create/upsert（body=GroupRoom；缺 id 服务端生成） |
| GET | /api/groups/:id | 单群（404 NOT_FOUND） |
| PUT | /api/groups/:id | 部分字段更新（merge 后走 upsert 幂等语义） |
| DELETE | /api/groups/:id | 删除（幂等；级联清 rounds） |
| GET | /api/group-sections | 分组名列表（保序） |
| POST | /api/group-sections | 新增分组 {name} |
| PUT | /api/group-sections/:name | 重命名 {to}（级联迁移群引用；409 见上） |
| DELETE | /api/group-sections/:name | 删除分组（级联群.section 置 ""） |
| GET | /api/groups/:id/rounds | 历史轮 taskId 列表（保序） |
| POST | /api/groups/:id/rounds | 追加历史轮 {taskId}（去重幂等） |
| POST | /api/groups/:id/read | 已读落位 {lastReadSeq}（单调） |

校验：mode/notifyLevel 枚举校验（非法 400 INVALID_PARAM）；notice>2000 拒绝；name/section trim 后空串归 ""；memberAgentIds/projectIds 去重保序。

**子资源存在性（裁定 2026-11-11 expert 预研②；复核 W1-4 修订）**：对不存在的群 id，GET/PUT /api/groups/:id、GET/POST /api/groups/:id/rounds、POST /api/groups/:id/read **一律 404 NOT_FOUND**（不留孤儿键；对齐 GET 一致性，覆盖 Android addRound 会落孤儿键的基线不一致）。**例外：DELETE /api/groups/:id 不存在 → 幂等 200**（§1 delete 静默幂等语义，对齐 Android deleteIds；二者以本条为准）。

**分组端点输入校验（裁定 expert 预研 P7）**：POST /api/group-sections 与 PUT /api/group-sections/:name 的名字 trim 后为空 → 400 INVALID_PARAM；DELETE 空白名 → 400；DELETE 不存在的有效名 → 幂等 200（级联语义照 §1）。

**分组引用容差（复核 W3-5 裁定）**：GroupRoom.section 允许指向不存在的分组名（服务端容忍不拒，渲染按「未分组」，对齐 Android 宽松语义）；但**所有新建入口（建群向导/群设置「新建分组」）必须先 POST /api/group-sections（重名幂等 added:false）再落群**，保证正常流产生的引用不游离。

**写口严格口径统一（复核 W1-5 裁定）**：POST /api/groups/:id/rounds 的 taskId trim 后为空 → 400 INVALID_PARAM（与 markRead 400 严格口径一致；Android 侧 addTaskRound 需本地空值守卫后再发请求）。路由层意外异常一律 500，不得压缩为 400（W1-6）。

## 3. MCP 工具契约：`workbuddy_group_manage`

- actions：`list | get | create | update | delete | sections | add_section | rename_section | remove_section | rounds | add_round | mark_read`
- 字段：`roomId`（get/update/delete/rounds/add_round/mark_read）、`room`（create/update 的对象或部分字段）、`name`（add_section/remove_section）、`old`/`to`（rename_section）、`taskId`（add_round）、`lastReadSeq`（mark_read）、`compact`（list）
- 注册位置：`src/tool-ops.ts`（getTools 动态下发 → MCP/xiaozhi/HTTP `/api/tools/*` 自动同步）、`src/tool-contracts.ts`（actionContract）、`src/tool-policy.ts`（list/get/sections/rounds=['read']；create/update/*_section/add_round/mark_read=['write']；delete=['write','destructive']）。
- 错误返回带 `nextAction` 提示（对齐既有工具风格）。若 `src/capabilities.ts` 有工具清单需同步登记。
- **AI 令牌通道裁定（expert 预研③）**：`aiTokenOnly`（session=undefined）调用 `workbuddy_group_manage` 一律拒绝（`AI_TOKEN_DENIED`，nextAction 提示改用登录身份）——群是按登录用户隔离的私有数据，**不做服务级共享桶**（先例 tool-ops.ts:921-924 SSH get/exec）。拒绝必须覆盖全部 12 个 action（含 list/get 只读）且发生在参数校验之前（先身份后校验）。
- **单实例装配裁定（programmer task-2 发现，lead 批复 A 方案）**：`GroupStore` 为内存缓存型存储，**全进程只允许一个实例**——`server.ts` 建一次（`const groupsStore = new GroupStore()`），同时注入 `WorkBuddyRouter` 构造器与 `createWorkBuddyToolDefs` deps（对齐 sshStore 第 7 参先例）；router/tool-ops 不得各自懒建 `new GroupStore()`（双实例内存快照互写同一 JSON 会丢数据）；`deps.groupsStore` 可选依赖仅作测试兜底，生产必须走 server.ts 注入。禁止模块级单例注册表（第二条实例化路径）。

## 4. Web UI 范围（web-ui.ts；对照 Android 屏幕逐屏同步）

1. **群列表**（新导航入口「群」）：按 section 分组渲染、未读徽标（对比任务 turnsCount 与 lastReadSeq，§4.8）、归档过滤、搜索。
2. **建群向导**（3 步，对齐 CreateGroupWizard）：① 选成员（多选子智能体，口径同 /api/agents 可 @ 列表）② 模式（admin/everyone）+ 公告（≤2000）+ 管理员（∈成员，可无）③ 绑定项目 0..N + 当前项目 + 分组。
3. **群聊天页**（对齐 GroupChat/GroupRoom）：复用现有任务聊天渲染（channelRef=orchestrate 任务）；开新一轮（语义照抄 Android groupRoundCreateBody：mode=orchestrate+memberAgentIds+上轮结论注入 title=群名（第 N 轮）+projectId=activeProjectId；用户文本只 send 一次）；@提及点名；**空转折叠**（§4.9 词表照抄 GroupRoom.kt isIdleRelayText，连续 ≥2 条折叠，带工具调用/附件/@ 点名豁免；**重复消息折叠判定（≥8 码点包含）与 Android 调用侧口径一致：代码保留、调用侧暂不启用——对齐 Android 基线为 sync 第一原则，启用与否记遗留池做双端一致增强（复核 W3-2 裁定）**）；结束本轮（当前轮转历史轮、channelRef 清空）；历史轮只读回看。
4. **群设置侧板**（对齐 GroupSettings）：名称/公告/管理员/模式/成员增删/项目绑定与当前项目/权限覆写/提醒档/分组/归档/删除（危险操作二次确认）。
5. **弹窗规范**（Android 红线①②移植）：暗色令牌变量（--dsw-* / 既有 token），禁静态色值；错误行按（类型+taskId+时间窗）去重，重试成功即消失。

## 5. SKILL 更新范围

- `skills/onenat-workbuddy/SKILL.md`：核心概念加「群（Group）」一条；路由表加一行 → `skills/groups.md`；工具速查加 `workbuddy_group_manage`。
- 新增 `skills/onenat-workbuddy/skills/groups.md`：**以 MCP 通道用法为主**（REST 属控制台/Android 契约面 §2，不在 AI 开放面——复核 W4-1 修订原「REST + MCP 双通道」措辞）、幂等语义、channelRef 与任务编排关系、项目绑定语义、典型流程（建群→开轮→@点名→结束轮→回看）。
- `skills/workbuddy-mcp/SKILL.md`：工具目录登记 + 示例。
- `skills/onenat-workbuddy/scripts/wb.mjs` / `skills/workbuddy-mcp/scripts/wbmcp.sh`：若工具枚举为动态则零改动；仅允许纯增量登记。**wb.mjs 裁定（lead 2026-11-11）**：wb.mjs 仅支持 AI 令牌认证，而群工具对 AI 令牌全 action 拒绝（§3）——**不加 group 命令属正确实现**（加命令=死代码误导调用方），允许仅 HELP 补一行说明；「纯增量登记」条款让位于 §3 身份边界的一致性。**先例口径（expert 终审采纳）：工具对脚本通道不可用时，以 HELP/文档边界说明替代命令登记，知情链完整即可。**

## 6. Android 改造契约（onenat-workbuddy-android）

- `Api.kt`：新增群 REST 方法（biz 走 §2 端点）：groups()/group(id)/upsertGroup(room)/deleteGroup(id)/groupSections()/addGroupSection(name)/renameGroupSection(old,new)/removeGroupSection(name)/groupRounds(roomId)/addGroupRound(roomId,taskId)/markGroupRead(roomId,seq)。**markGroupRead 必须本地先 coerce（seq 非负、与当前 lastReadSeq 取 max）再发请求；服务端对非整数/负数取 400 严格口径（lead 裁定 2026-11-11，task-1 复核配套）。**
- 分层：**群管理写口一律先走 Web 接口，成功后回写本地缓存**；读口优先接口、失败回退本地缓存（离线可看不可管）。新增 `GroupRepository`（或 GroupStore 内 server-first 改造，programmer 定夺、expert 审查），把「网络失败时的乐观本地写 + 错误面」语义写清。
- 本地保留（仍存 SharedPreferences，不迁移）：chiefAgentId、defaultDshRef、myNodes、unread/lastReadSeq 本地叠加层。
- 调用点切换：CreateGroupWizard.kt、GroupSettings.kt、AdminScreens.kt、DshNodes.kt、GroupChat.kt。
- 测试：GroupStoreTest 适配分层（纯函数保持 JVM 可测）；新增 merge/缓存回退纯函数用例。构建判据不变：`:app:compileDebugKotlin :app:testDebugUnitTest` 全绿。
- 红线：不改设计文档/GLOSSARY.md；isChief 语义与存储键不动；WbNavigation.scope 隔离语义不变；不引 icons-extended。

## 7. 写范围（隔离）

- **programmer**：web `src/*`、`skills/*`、`scripts/*`（仅纯增量）、android `app/src/*`；唯一代码写者。
- **expert**：web `docs/review-*.md`（代码只读）。
- **ui-designer**：web `docs/ui-review-*.md`（代码与截图只读）。
- **coordinator(lead)**：本文档 + 任务板 + 统一构建/验收。
- **全队禁令**：禁止任何 git 写操作（commit/stash/checkout/reset/push）——web 仓库有在途未提交改动，一切工作只在工作树内进行；禁改 ~/.dsh、DSH 本体、Android 设计文档与 GLOSSARY.md。

## 8. 里程碑与验收

- M1（web 绿，lead）：`npm run typecheck` + `npm run test:unit`（groups.test.ts 纳入 runner 清单）+ `npm run build`。
- M2（android 绿，lead）：`./gradlew :app:compileDebugKotlin :app:testDebugUnitTest`。
- 复核门禁：每个实现任务 complete 前 expert 复核出 `docs/review-<task>.md`（⛔/⚠️/✅ 附文件:行号），⛔ 清零方可 complete；UI 任务加 ui-designer 走查报告 `docs/ui-review-web-groups.md`。
- 终验收（lead）：契约逐条对账（本文档 §1–§6）+ 双端构建绿 + MCP smoke（`npm run smoke:mcp`）。
