# onenat-workbuddy-web 架构评审（Review Architecture）

> 评审时间：2026-10-16（公司笔记本节点，静态分析 + 受控复现）
> 工作目录：`/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web`
> 基线：`docs/review-baseline.md`（HEAD=`d1f96ac`，首次评审，无既往 review 记录）
> 边界：仅架构与扩展性评审。不做安全漏洞分析（安全域见应用安全工程师意见）、不编写测试用例、未修改任何业务代码；复现仅在 `/tmp` 隔离目录进行，已清理。

---

## 结论摘要

1. 分层（server 装配 → router/engine 编排 → store 持久化 → remote-client/onenat 远端）整体清晰、依赖图无真实运行时循环；主要风险集中在**三个巨模块**（web-ui 11,268 行、router.dispatch 约 2,380 行单方法、engine 3,223 行/75 方法）与**持久化单点**（store.json 全量同步落盘、任务数据无保留策略）。
2. **已复现一条高危数据丢失链路**：store.json 一旦损坏，`WorkStore.load()` 静默重置为空数据，且 `server.ts` 启动路径的无条件 `updateSettings()` 会在同一次启动内把空数据写回磁盘覆盖原文件（复现证据见 §3.1）。
3. 依赖方向存在两处结构性瑕疵：`expert-registry ↔ expert-store` 类型级循环、`tool-ops → router` 反向依赖（使 MCP/工具通道传递性拖入 617KB 的 web-ui）。均为小改动可消除。
4. 对外接口存在"影子契约"：AI 令牌开放面在 `server.ts` 硬编码复制了 router 的路由知识，MCP 协议版本号硬编码 5 处，公共基址/节点名推导各有两套实现且回退值已漂移。
5. 未验证项集中在：真实 ONENAT/DSH e2e、多进程并发写、旧版本数据兼容、大 store 实测性能（详见 §6）。

---

## 1. 评审范围与方法

- **方法**：全量 import 图提取（src/*.ts + src/mcp/*.ts，30,032 行）→ 逐模块抽查职责与数据流 → 关键链路（启动装配、持久化、SSE、工具通道）精读 → 1 项受控复现（/tmp 隔离目录）。
- **已执行的验证**：`tsc` 独立编译 store.ts 到临时目录并构造 `WorkStore` 复现损坏文件行为（§3.1）；所有引用行号经 grep -n 逐一核对。
- **未执行的验证**：`npm start` 常驻运行、`smoke:e2e` 及全部需真实远端凭据的命令（沿用基线 §5 结论）；未做任何基准压测。
- **假设**：沿用基线——按首次评审处理；`out/`、`pnpm-workspace.yaml` 缺口不在本评审范围。

## 2. 模块依赖图（事实）

由源码 import 语句提取（值导入与 type 导入未区分标注，见 §3.2 对循环的定性）：

```
server.ts（组合根）
 ├─ router ──→ [23 个模块：auth/engine/expert-*/library/monitor/monitor-ui/onenat/
 │              orchestrator/prompt-composer/remote-client/resolver/scheduler/
 │              schedule-templates/ssh-*/store/usage/web-ui/xiaozhi-mcp/date-version]
 ├─ engine ──→ expert-registry/expert-teams/onenat/orchestrator/prompt-composer/
 │             remote-client/resolver/ssh-store/store/types
 ├─ orchestrator → expert-teams/remote-client/resolver/store/types
 ├─ monitor ──→ engine/onenat/orchestrator/remote-client/resolver/scheduler/ssh-store/types
 ├─ scheduler → engine/store/types        store → expert-teams/types
 ├─ tool-ops ──→ router(!)/engine/monitor/onenat/orchestrator/prompt-composer/
 │              remote-client/resolver/scheduler/ssh-*/store/expert-registry
 ├─ mcp-server → tool-ops + xiaozhi-mcp   xiaozhi-mcp → tool-ops + types
 └─ library → store        onenat/remote-client/ssh-*/expert-teams → types（叶子）
```

循环依赖：仅 1 处（expert-registry ↔ expert-store，§3.2）。`web-ui`/`monitor-ui`/`login-ui` 为无出边叶子，前端与后端无 import 级耦合（仅经 render 函数参数传递 prefix/version，接口干净）。

## 3. 发现清单

> 分类标记：**【已复现】**=附复现证据或代码级确证；**【潜在风险】**=代码确证、触发依赖外部条件；**【未验证】**=依据不足。每条含：位置 / 触发条件 / 影响 / 最小修改方案。

### 3.1 持久化：损坏即静默清空（数据丢失链）【已复现】

- **位置**：`src/store.ts:58-84`（`load()` 的 `catch {}` 静默容错，行 81-83 无任何日志）+ `src/server.ts:206-210`（启动时无条件 `store.updateSettings(settings)` → 内部 `save()` 落盘）。
- **触发条件**：store.json 因任何原因损坏（半截写入、磁盘故障、手工误编辑）。此后**下一次启动**即触发。
- **影响**：`load()` 解析失败后内存态重置为空（agents/tasks/schedules/projects/teams 全空），无告警；随后启动流程的 `updateSettings()` 立即把空数据写回同一路径，**损坏的原文件被覆盖，恢复机会消失**。子智能体、任务历史、专家团、定时任务一次性丢失。
- **复现证据**（2026-10-16 实测，隔离目录 /tmp/wb-arch-test，`tsc` 单独编译 store.ts 后运行）：
  ```
  --- before: "{corrupted json content"
  --- after load: tasks = 0 , agents = 0        ← 构造期间无任何告警输出
  --- after one mutation, file = "{\n \"agents\": [],\n \"tasks\": [], ..." ← 原文件已被空数据覆盖
  ```
  （复现调用 `updateSettings` 等价于 `server.ts:210` 的启动路径；临时目录已清理）
- **最小修改方案**：① `load()` 的 catch 中 `console.error` 告警并把损坏文件改名备份为 `store.json.corrupt-<ts>` 再继续（保留法证与手工恢复可能）；② `flush()` 改为写临时文件 + `renameSync` 原子替换（配合 §3.3 消除损坏来源）；③ `server.ts` 启动回写仅在 CLI/env 值与存量设置**实际不同**时执行 `updateSettings`。
- **需交叉核对**：安全意见——备份文件与 store.json 同样含 `apiKey` 明文（store.ts:14/`onenat.apiKey` 字段），落盘权限需一并评估；回归用例——启动冒烟 + 流式完整性场景（docs/streaming-integrity.md）。

### 3.2 依赖方向

#### 3.2.1 expert-registry ↔ expert-store 类型级循环【已复现（代码确证），风险评级低】

- **位置**：`src/expert-registry.ts:20`（值导入 `UserExpertStore`）与 `src/expert-store.ts:14`（`import type { Expert, ExpertProfile }`）。
- **触发条件**：当前 `import type` 在编译期擦除，运行时无环（tsc 通过、node 加载无问题）；但两模块类型层面已互指，任何一方把 type 导入改为值导入即成真实 ESM 循环，且初始化顺序问题会静默出现（拿到 undefined）。
- **影响**：结构性脆弱点；重构时易踩。另注：`src/store.ts:9` 引 `expert-teams`（BUILTIN_TEAMS）方向为基础设施→领域常量，无环，可接受，仅记录。
- **最小修改方案**：把 `Expert`/`ExpertProfile` 类型定义移入 `src/types.ts`（或新建 `expert-types.ts`），expert-store 只依赖类型模块，环即断开。

#### 3.2.2 tool-ops → router 反向依赖（巨模块传递拖入）【已复现（代码确证）】

- **位置**：`src/tool-ops.ts:22` `import { normalizeDshRef } from './router.js'`；`normalizeDshRef` 定义在 `src/router.ts:3191`。
- **触发条件**：任何引用 tool-ops 的模块（mcp-server、xiaozhi-mcp，经 server.ts 装配必然加载）。
- **影响**：工具定义模块反向依赖 HTTP 路由巨模块，传递性把 router → web-ui（617KB 源）/monitor-ui/library/usage 等全部拉进 MCP/小智通道的加载图。功能正确但耦合方向倒置、加载面无谓扩大，且"工具层改一行会重审路由层"的维护成本倒挂。
- **最小修改方案**：把 `normalizeDshRef`（约 20 行纯函数）移入 `src/types.ts` 或新建 `src/dsh-ref.ts`，router 与 tool-ops 改为共同引用；两处调用点（router.ts:1458/1532、tool-ops 内部）语义不变。
- **需交叉核对**：回归用例——子智能体创建/更新接口与工具通道冒烟（`npm run smoke` 已覆盖 tool 列表，建议补 normalizeDshRef 的单测）。

### 3.3 模块职责边界

#### 3.3.1 router.dispatch 单方法约 2,380 行【已复现（结构测量）】

- **位置**：`src/router.ts:730`（`dispatch` 起）至 `src/router.ts:3109`（下一个方法 `subtaskChat` 前）；类内共 40 个方法，其余为私有辅助。
- **触发条件**：每次新增/修改任意 API 端点。
- **影响**：顺序 if 链匹配（正则 + 前缀判断）意味着**路由遮蔽风险**（新路由若落在宽匹配之后即被吞）；变更局部化差（基线成功指标"80% 变更只动 1-2 个模块"无法达成）；评审时无法按资源域定位。工作台/投屏/登录三个页面的 HTML 也由该层直接吐出（router.ts:752-766）。
- **最小修改方案**：不推倒重写。第一步仅引入"路由表"结构（method + pattern → handler 函数引用），`dispatch` 退化为查表循环；handler 按资源域（tasks/agents/experts/projects/schedules/monitor/fs）分文件导出。每步迁移由既有 `npm run smoke`（51 项）护航，属于可逐端点推进的可逆重构。

#### 3.3.2 engine.TaskEngine 巨类（3,223 行 / 75 方法）【已复现（结构测量）】

- **位置**：`src/engine.ts:67` 起。职责含：任务生命周期、@提及解析、DAG 编排执行（executeDag/launchSubtask/runSubtask）、ask 监视与自动应答（watchPendingAsk，行 1475）、权限同步（syncSessionPermission）、附件直传 P2P（directUploadInit/Register/Relay，行 2977-3188）、工作区缓存（wsCache）。
- **触发条件**：任一子域改动（如附件流程调整）都要在全文 3,000+ 行中定位，且与流式主链共用私有状态（activeJobs/hub/blockCache）。
- **影响**：与 3.3.1 同源——变更局部化差；单测仅覆盖 orchestrator/interaction-guard（基线缺口 8），重构无安全网。
- **最小修改方案**：先把边界清晰的三个簇抽为协作对象（构造参数注入，公开方法签名不变）：`attachments`（行 2851-3188）、`askWatcher`（行 1464-1730）、`permissionSync`（行 2704-2750）。hub/订阅生命周期现状良好（hub.ts:423-431 空 Set 即删、SSE close 即退订，router.ts:2901），抽取时保持。

#### 3.3.3 ExpertRegistry 归属错位 + 装配时序回填【潜在风险】

- **位置**：`src/router.ts:67`（registry 由 router 持有并 `attachUserStore`，行 76）+ `src/server.ts:252-254`（router 构造后 `engine.attachExperts(router.expertRegistry)` 回填，源码注释自证"构造顺序晚于引擎，此处回填"）。
- **触发条件**：`server.ts:222` engine 创建后、`server.ts:254` 回填前，任何代码消费 engine 的专家视图（当前 scheduler 首跳 20s（scheduler.ts:15,48）、monitor 巡检 30s，窗口内未命中——属侥幸安全而非设计保证）。装配顺序一旦调整（如监控启动提前、或新增早启消费者）即静默退化。
- **影响**：专家团任务、expert-mcp（server.ts:266）、工具通道（server.ts:270）四类消费方共用一份注册表，但所有权挂在不相干的 HTTP 层；时序约束只存在于注释里。
- **最小修改方案**：把 `new ExpertRegistry()` + `attachUserStore(new UserExpertStore(dataDir))` 上移到 `createApp` 组装根部，作为构造参数同时注入 engine 与 router，删除 `attachExperts` 回填 API。
- **需交叉核对**：回归用例——专家团任务派发、`/api/experts/mcp`、trigger 类工具。

### 3.4 对外接口与数据结构兼容性

#### 3.4.1 AI 令牌开放面：路由知识的影子副本【已复现（两处清单对照）】

- **位置**：`src/server.ts:546-569`（`isAiTokenAllowedPath` 硬编码 16 条路径规则）vs `src/router.ts:730+`（真实路由集）。
- **触发条件**：router 增删改端点时。新增端点 → AI 令牌默认 403（安全侧偏保守，可接受但可能违背意图）；**改名/下线端点 → allowlist 残留死条目，无人察觉**。两份清单无任何机制强制同步。
- **影响**：策略漂移成为常态而非事故；且 `/api/projects` 整面（含写/删）对 AI 令牌开放（server.ts:567）——**开放面是否过宽属安全域判断，转交安全意见复核**。
- **最小修改方案**：路由表化（§3.3.1）后，为每条路由声明 `auth: 'session' | 'ai' | 'both'` 元数据，server.ts 读元数据判定，删除手工清单。
- **需交叉核对**：安全意见（开放面收敛、/api/projects 写面）+ 回归用例（skills/onenat-workbuddy/scripts/wb.mjs、workbuddy-mcp 技能的实际调用路径）。

#### 3.4.2 同一语义多套实现且已漂移【已复现（代码对照）】

- **位置与证据**：
  - 公共基址：`src/router.ts:128-131`（`requestBase`，host 回退 `'localhost'`）vs `src/mcp-server.ts:67-71`（`requestPublicBase`，host 回退 `''`）。server.ts:477 工具通道用后者、router 其余端点用前者——**同一请求语义在两处已产生不同回退值**。
  - 节点显示名：`src/router.ts:115-125`（按 mappingId/appId 精确解析）vs `src/engine.ts:2293-2303`（按 baseUrl 前缀匹配 listEndpoints）——同一 DSH 节点在任务气泡与专家面板可能显示两个名字。
  - MCP 协议版本 `'2024-11-05'` 硬编码 5 处：mcp-server.ts:31、mcp/expert-mcp.ts:22、server.ts:493、xiaozhi-mcp.ts:335、monitor-ui.ts:609。
- **触发条件**：反代/隧道场景下对比不同端点生成的绝对链接；协议升级时。
- **影响**：前端拿到的回传 URL 因调用路径而异（排查困难）；协议升级时漏改任一处导致 MCP 客户端握手不一致。
- **最小修改方案**：新建 `src/http-base.ts`（或复用 mcp-server 的实现迁出）统一 `requestPublicBase`；`nodeLabelOf` 统一走 `OnenatDirectory` 单一解析；协议版本收进共享常量。三处都是纯函数级改动。
- **需交叉核对**：回归用例——附件 P2P 直传（依赖节点直连配方 URL，engine.ts:2965 buildNodeDownloadUrl）、monitor 页 MCP 诊断。

#### 3.4.3 持久化 schema 无版本与字段级规范化【潜在风险 + 未验证】

- **位置**：`src/store.ts:62-78`（load 仅对 settings 浅合并、xiaozhi 单值→列表迁移；agents/tasks/schedules/projects/teams **整数组原样信任**）；对照 `src/types.ts:346`（`memberAgentIds: string[]` 必需）、`src/types.ts:355`（`sessions` 必需）。
- **触发条件**：加载由旧版本或异常来源产生的 store.json，其中任务缺新增必需字段（如早期版本无 `memberAgentIds`）。`store.ts:220`（deleteAgent）等直接 `.includes()` 将抛 TypeError。
- **影响**：单条脏数据可让删除/读取等全店操作抛错（操作粒度失败，非进程崩溃）；无 `schemaVersion` 使未来破坏性迁移无从判断。
- **最小修改方案**：load 时对每条记录做 normalize（缺数组补 `[]`、缺 `sessions` 补 `{}`），文件顶层加 `schemaVersion: 1`。改动集中在 `load()` 一处。
- **【未验证】**：本仓库无旧版本样本数据，无法证实现网存在缺字段记录；风险成立与否取决于历史 schema（需对照 git 历史 `src/types.ts` 演进）。

#### 3.4.4 API 契约无护栏【未验证】

- **位置**：全部 `/api/*`（router.ts）+ 工具通道参数 schema（tool-ops.ts:124 起 `ToolParamDef` 手写）。
- **说明**：响应统一 `{ok, data/error}` 包裹，但无 OpenAPI/快照测试；消费者（web-ui、wb.mjs、wbmcp.sh、外部 MCP 客户端）与实现同仓演进时安全，**第三方消费者**的兼容性无自动化护栏。建议（不强制）：smoke 增加核心端点响应形状快照断言。本轮未执行任何接口调用验证，不影响结论成立性。

### 3.5 扩展性与可维护性

#### 3.5.1 store.json 全量同步落盘 + 任务数据无界增长【潜在风险】

- **位置**：`src/store.ts:123`（每次 `save()` 全量 `JSON.stringify + writeFileSync`，同步阻塞）；`src/store.ts:358-381`（tasks 无任何归档/清理路径）；对照有界先例：scheduler.ts:16（`MAX_RUNS = 50`）、monitor.ts:8（快照保留 30 天）。
- **触发条件**：长期运行、任务与多轮对话（turns 含全文与附件元数据）持续累积；每次结构性 mutation 都全量重写整个文件。
- **影响**：写放大随数据线性增长——源码注释自证"1.5MB 级 store 单次约 3.5ms 且同步阻塞事件循环"（store.ts:90-100，该问题历史上已引发流式卡顿并催生 scheduleSave 尾随合并）；store 越大，所有 API mutation 的尾延迟与流式阻塞风险越大，且放大 §3.1/§3.3（非原子写）的损坏窗口。
- **最小修改方案**：第一步仅做**归档出库**——`WorkTask.archivedAt` 字段已存在（types.ts:361），新增按期把归档任务移入 `store-archive-<yyyy-mm>.json` 的后台任务，主 store 体积恢复有界；分片存储等更大改动仅在归档不足时再评估。
- **需交叉核对**：回归用例——流式完整性（docs/streaming-integrity.md）、历史任务读取、usage 统计与 monitor 趋势（跨文件聚合语义）；安全意见——归档文件同样含 apiKey 明文。

#### 3.5.2 配置漂移：三处默认值/优先级语义分叉【潜在风险】

- **位置与证据**：
  - 数据目录默认值两套：`src/server.ts:92`（`WORKBUDDY_HOME || ~/.onenat-workbuddy`）vs `src/store.ts:44-45`（`DSH_HOME || ~/.dsh/onenat-workbuddy`）。当前 server 恒传参使后者为死代码，但两套默认并存，未来新增 WorkStore 构造点（如脚本/工具）即分叉。
  - 默认 ONENAT 端点硬编码在持久层：`src/store.ts:14`（`https://onenat.sooncore.com`）。
  - 启动种子写回：`src/server.ts:205-210` 把 CLI/env 值写进 store 并落盘——env 移除后配置残留 store，"环境配置"与"用户设置"两种语义混在一处（设置页后续修改可能在下次带 env 重启时被覆盖）。
- **影响**：排障时"配置到底从哪来"需要同时理解三个文件；README:33 与 standalone-deploy.md:74 均只描述了 server 侧默认值，文档与死代码默认不一致。
- **最小修改方案**：数据目录解析收敛到 server.ts 单点（store.ts 删除 DSH_HOME 兜底或改为显式告警）；默认端点常量移到 types/常量模块；启动写回仅在值变化时执行（与 §3.1 修复 ③ 合并）。

#### 3.5.3 web-ui 单文件与构建关卡【已复现（现状事实），维护性观察】

- **位置**：`src/web-ui.ts`（11,268 行模板字符串单页）；`scripts/build-standalone.sh`（注释自证"历史故障两次"并已内建 page-check 语法关卡 + `\s` 求值关卡）。
- **影响**：前端无类型检查/模块边界，但**已有缓解**（build 关卡能拦截转义断裂类故障）。鉴权/前缀经参数注入（web-ui.ts:15-17），与后端接口耦合靠同仓同发布对齐。
- **最小修改方案**：暂不拆分（可逆性差、收益低）；仅建议把 build 里的 page-check 逻辑在 smoke 中复用以覆盖运行时路径；若未来前端复杂度继续增长再评估模块化。
- 附带：`scripts/build-standalone.sh` 硬编码本机 tsc 候选路径（`/Users/tsbj/feyanggit/deepseek-harness` 等），可移植性弱（低优先级，参数化即可）。

#### 3.5.4 远端客户端实例分散【潜在风险（一致性）】

- **位置**：`new DshClient()` 共 11 处（engine.ts:68、monitor.ts:232、router.ts:64/1068/1087、tool-ops.ts:160/592/1144、orchestrator.ts:406、resolver.ts:93 每次调用新建）。
- **触发条件**：调整超时/重试/连接池策略时需逐处修改；resolver.ts:93 每次健康检查新建实例属无谓开销。
- **影响**：当前 DshClient 为无状态 fetch 包装（remote-client.ts:226 起），行为正确；但超时值散落（如 120s 硬编码 remote-client.ts:256），全局 undici dispatcher 未做池化调优，高并发下无统一背书。
- **最小修改方案**：DshClient 内聚默认超时常量与可选共享实例；resolver 复用单例。不强制改全部调用点。

## 4. 风险摘要表

| # | 严重度 | 分类 | 位置 | 触发条件 | 影响 | 修复（最小） | 验证方式 |
|---|---|---|---|---|---|---|---|
| R1 | **高** | 已复现 | store.ts:58-84 + server.ts:206-210 | store.json 损坏后下一次启动 | 数据静默清空且原文件被覆盖 | catch 告警+改名备份；启动写回仅在值变化时执行 | /tmp 复现脚本已证；修复后以损坏样本重跑 + `npm run smoke` |
| R2 | 高 | 潜在 | store.ts:123 | 崩溃/断电发生在 flush 写盘中途 | 半截 JSON → 落入 R1 链路 | tmp 文件 + renameSync 原子写 | 人为中断写盘模拟 + 损坏样本回归 |
| R3 | 中 | 已复现 | server.ts:546-569 vs router.ts:730+ | router 增删改端点 | AI 开放面策略漂移；/api/projects 写面待安全复核 | 路由元数据声明 auth 面，删手工清单 | wb.mjs/技能包调用路径回归 + 安全意见复核 |
| R4 | 中 | 潜在 | store.ts:358-381 | 长期运行任务累积 | 全量同步落盘尾延迟增大，放大 R2 窗口 | 按 archivedAt 归档出库，主 store 有界 | 大样本压测前后写延迟对比；流式回归 |
| R5 | 中 | 已复现 | tool-ops.ts:22 → router.ts:3191 | 每次加载 MCP/工具通道 | 依赖方向倒置，传递拖入 web-ui 等巨模块 | normalizeDshRef 移至独立模块 | smoke + agents 工具回归 |
| R6 | 中 | 已复现 | router.ts:730-3109 | 任意端点变更 | 路由遮蔽风险、变更局部化差 | 引入路由表，dispatch 查表化 | 逐端点迁移 + smoke 51 项护航 |
| R7 | 中 | 潜在 | types.ts:346/355 vs store.ts:62-78 | 旧版本/异常 store.json 缺必需字段 | 记录级操作抛 TypeError | load 时字段级 normalize + schemaVersion | 构造缺字段样本单测（需先核实历史 schema，见 §6） |
| R8 | 低 | 已复现 | expert-registry.ts:20 ↔ expert-store.ts:14 | 一方改为值导入 | 真实 ESM 循环、初始化 undefined | Expert/ExpertProfile 类型外移 | tsc + node 加载冒烟 |
| R9 | 低 | 潜在 | router.ts:67 + server.ts:252-254 | 装配顺序调整 | engine 专家视图回填前被消费 → 静默退化 | registry 上移组合根，构造注入 | 专家团任务 + expert-mcp 回归 |
| R10 | 低 | 已复现 | router.ts:128 vs mcp-server.ts:67 等三组 | 反代场景/协议升级 | 回退值已漂移；协议版本 5 处硬编码 | 收敛为共享实现/常量 | monitor MCP 诊断 + P2P 直传回归 |
| R11 | 低 | 潜在 | store.ts:44-45/14 + server.ts:92 | 新增构造点/移除 env | 数据目录与默认端点语义分叉 | 默认值单一来源化 | 启动冒烟 + 文档核对 |
| R12 | 低 | 潜在 | engine.ts:3223 行/75 方法 | 子域改动 | 变更局部化差、无测试安全网 | 按簇抽取协作对象（attachments/askWatcher/permission） | 先补特征测试再抽取 |
| R13 | 信息 | 已复现 | web-ui.ts（11,268 行）+ build-standalone.sh | 前端复杂度继续增长 | 转义类故障历史已发生两次（有关卡缓解） | 维持现状；page-check 复用进 smoke | 现有 build 关卡 |

## 5. 需交叉核对安全意见与回归用例的变更点清单

| 变更点 | 涉及发现 | 需安全意见 | 需回归用例 |
|---|---|---|---|
| store 原子写 + 损坏备份 + 启动写回条件化 | R1/R2 | 备份文件与 store.json 含 apiKey 明文，落盘权限 | 启动冒烟、流式完整性（streaming-integrity.md 场景） |
| AI 令牌开放面收敛 / 路由元数据化 | R3 | `/api/projects` 写面、开放面清单是否过宽（本评审仅标记，未做漏洞分析） | wb.mjs、workbuddy-mcp 技能、monitor 页全部调用路径 |
| normalizeDshRef 迁移出 router | R5 | 无 | 子智能体创建/更新、工具通道 smoke |
| ExpertRegistry 装配上移 | R9 | 无 | 专家团任务派发、/api/experts/mcp、trigger 工具 |
| MCP 协议版本/公共基址/节点名统一 | R10 | 无 | mcp 冒烟、xiaozhi 冒烟、附件 P2P 直传、monitor 诊断 |
| 任务归档保留策略 | R4 | 归档文件密钥明文与清理周期 | 历史任务读取、usage 统计、monitor 趋势聚合 |
| 持久化 schemaVersion + 字段 normalize | R7 | 无 | 旧数据样本加载、全量 store 读写回归 |

## 6. 未验证项（明确声明）

1. **真实 ONENAT/DSH 端到端**：全部 e2e/远端冒烟未执行（无凭据，沿用基线 §5 结论）；本报告所有结论仅基于静态分析与本地受控复现。
2. **多进程并发写同一 dataDir**：两个服务实例共享数据目录时的行为（store.json 相互覆盖）未测试；单实例假设来自代码阅读（server.ts:200-203），未验证部署文档是否禁止多实例。
3. **大 store 性能**：3.5ms/1.5MB 数字引自 store.ts:94 源码注释（作者实测），本轮未复测压测。
4. **旧版本数据兼容**：无历史 store.json 样本，R7 触发概率未证实；需 git 历史核对 WorkTask schema 演进（本轮未做逐版本比对）。
5. **web-ui 运行时行为**：前端内存/性能未测（超出架构静态评审边界）。
6. **`out/` 目录、pnpm allowBuilds 占位**：沿用基线缺口记录，未展开。

## 7. 建议与验收（按优先级）

| 优先级 | 行动 | 完成标准 |
|---|---|---|
| P0 | R1+R2：load 告警/备份 + 原子写 + 启动写回条件化（一处 PR 可完成） | 损坏样本启动后产生 `.corrupt-<ts>` 备份且 stderr 有告警；`npm run smoke` 51/51 通过 |
| P1 | R5+R10：normalizeDshRef 外移、requestPublicBase/nodeLabelOf/协议版本收敛 | import 图中 tool-ops 不再依赖 router；全局仅一处协议版本常量；smoke 通过 |
| P1 | R3：与安全意见会商后路由元数据化开放面 | server.ts 手工路径清单删除；wb.mjs 全链路回归通过 |
| P2 | R4：归档出库策略（复用 archivedAt） | 万级任务模拟下主 store 体积有界；历史任务仍可查 |
| P2 | R7：load normalize + schemaVersion | 缺字段样本加载不抛错；版本字段落盘 |
| P3 | R6/R9/R12：路由表化、registry 上移、engine 分簇（先补特征测试） | 每步迁移 smoke 全绿；engine/router 各自可按资源域定位修改 |

## 8. 交接给主调度

1. **需与安全意见核对**：§3.4.1 中 `/api/projects` 对 AI 令牌的写面开放（server.ts:567）是否越权面过宽——本评审只做了边界定位，未做漏洞分析；store.json/归档文件 apiKey 明文的落盘权限（§3.1/§3.5.1）。
2. **需与回归用例核对**：§5 清单 7 项变更点的验证方式是否已被现有 51 项 smoke 覆盖；流式完整性场景（docs/streaming-integrity.md）应作为 R1/R2/R4 修复的固定回归项。
3. **缺失资料**：既往 schema 演进史（判定 R7 实际风险）；设计总文档在外部仓库（基线缺口 4），本次未核对装配描述是否与实现漂移。
4. **未覆盖内容**：前端运行时质量、性能压测、多实例部署形态——均超出本轮架构静态评审边界，建议按需另开专项。

## 验收对照

| 验收标准 | 通过情况与证据 |
|---|---|
| 1. 产出架构评审文档，每个发现含位置/触发条件/影响/最小修改建议 | ✅ 本文档 §3.1–§3.5 共 13 条发现，全部含四要素；文件为 `docs/review-architecture.md` |
| 2. 覆盖模块职责边界、依赖方向与循环依赖、接口兼容性、扩展性与可维护性 | ✅ 分别对应 §3.3、§3.2、§3.4、§3.5，另附 §2 依赖图为共同基础 |
| 3. 区分已复现（附证据）/潜在风险/未验证项 | ✅ 已复现 6 条（R1 含 /tmp 复现命令输出，R3/R5/R6/R8/R10/R13 为代码级确证并附行号对照）；潜在风险 6 条；未验证项单列 §6 共 6 条 |
| 4. 标记需与安全意见和回归用例交叉核对的变更点清单 | ✅ §5 表格 7 项，逐项注明需哪方核对 |
| 5. 不引用不存在的文件或未经执行的测试结果 | ✅ 所有引用文件/行号经 grep -n 实测核对（如 store.ts:123、server.ts:546-569 均真实存在）；复现仅在 /tmp 执行并已声明；未声称执行任何 e2e；未修改业务代码（仅新增本评审文档） |
