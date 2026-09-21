# OneNat WorkBuddy 技能管理 + 子智能体技能绑定 实现方案（v1）

> 状态：历史设计记录（已实现）。本文撰写时项目还是 DSH 插件形态，文中 cordis/webServer 相关描述
> 仅为历史背景；**本项目现为独立 Node.js WEB 服务**（`node dist/server.js`，零 DSH 依赖），
> 技能中心已按「独立服务 + dsh-web-service HTTP API」形态落地。
> 关联仓库：`dsh-web-service`（远端 DSH HTTP 层）。

---

## 0. 需求一句话

在 **onenat-workbuddy** 里新增「技能中心」：通过 **dsh-web-service** HTTP API
远程管理 DSH 上的技能（**列表 / 上传 / 下载 / 删除 / 预览**）；在与子智能体交互时，
把 **子智能体已绑定的技能** 在其会话里 **自动装载**（注入技能全文），无需模型自己调 `skill` 工具。

---

## 1. 现状分析（基于源码）

### 1.1 DSH 侧技能机制（deepseek-harness）

技能 = 一个带 YAML frontmatter 的 `SKILL.md`（目录版）或扁平 `.md`，frontmatter 字段：

```yaml
---
name: dsh-doc                 # kebab-case，[a-z0-9]+(-[a-z0-9]+)*
description: ...              # 必填，路由用
whenToUse: ...                # 可选
disable-model-invocation: false   # 默认 false → modelInvocable
user-invocable: true              # 默认 true  → userInvocable
---
<正文 instructions>
```

**发现源（`packages/skill/skill-filesystem/src/index.ts`）** —— 按根目录扫描：

| 根 | 写法 | `source` | rank |
|---|---|---|---|
| 项目 | `<cwd>/.dsh/skills` | `project-dsh` | 100 |
| 项目 | `<cwd>/.agents/skills` | `project-agents` | 200 |
| 自定义 | 配置 `customSkillDirs` | `custom` | 300 |
| 用户 | `$DSH_HOME/skills`（`~/.dsh/skills`） | `user-dsh` | 400 |
| 用户 | `~/.agents/skills` | `user-agents` | 500 |
| 内置 | `$DSH_BUNDLED_SKILL_DIR` | `bundled` | 600 |

**注册表（`packages/skill/skill/src/index.ts`）**：`ctx.skills` 分层合并 + 优先级（rank，
同层取近）；`list()` 出摘要，`get(name, opts)` 按候选加载全文，`register()`/`registerProvider()` 注册。

**会话装载（`packages/skill/tool-skill/src/index.ts`）**：
- **面向模型**：`agent/pre-step` 把 `<available_skills>` 目录消息注入会话；模型通过 `skill` 工具
  `ctx.skills.get()` 拉全文，输出经 `renderSkillContent()` 渲染成 `<skill_content>` 块。
- **用户显式调用**：用户消息首行 `/name`，边界识别后注入 `<skill_content>` instructions 块。
- 关键：**技能列表/加载都 `scope` 于当前 agent、`cwd` 于会话工作目录**。

**Session 侧目录 RPC**：`sessionSkillCatalog.list()`（`skill-catalog.ts`）按 `sessionId`
取 cwd + preset，走 `ctx.skills.list({cwd, scope})` 只返回 `userInvocable` 摘要。

### 1.2 dsh-web-service 现状（`@dsh-external/dsh-web-service`，v0.1.4）

- 路由：`HttpRouter`（`router.ts`），`apply()` 里 `register*Routes(ctx, router)` 注册模块。
- 现有模块：`workspaces / sessions / models / streaming / files / fs / openapi / system`。
   **无技能端点**（openapi.json 里只有 workspaces/sessions/models/chat/completions/fs）。
- `inject = ['webServer', 'tools']`；`apply()` 用 `ctx.get('webServer')` 注册 `pathPrefix`（默认 `/api/v1`）。
- 鉴权：`apiKey` 存在时校验 `Authorization: Bearer` 或 `X-API-Key`。
- 现有能力刚好覆盖：**会话流式（prompt-stream）、工作目录（createSession cwd）、文件上传、fs 浏览/建目录**。

### 1.3 onenat-workbuddy 现状

- **拓扑**：主控 DSH 驻留本插件；`SubAgentPool` 每个子智能体绑一个 DSH 实体
  （`mapping/app/direct`），`AgentResolver` 每次派发前解析成 `{baseUrl, apiKey}`；`TaskEngine`
  通过 `DshClient`（SSE prompt-stream / 同步 prompt / 轮询）驱动远端子智能体。
- **D2 资源即提示词**：`PromptComposer.compose(agent, ctx)` 把绑定资源的入口+凭证+技能全文合成
  `[可用资源清单]` 块，`engine.ts` 里 `fullPrompt = `${block}\n\n[当前用户消息]:\n${text}``
  注入每个子任务/直通轮次。
- **子智能体模型**（`types.ts` `SubAgent`）：已有 `resources: AgentResourceBinding[]`，每个
  资源绑定带 `credentialMode` 与 `skillMode: 'all' | {names:string[]} | 'none'`（这是**资源自身技能**，
  与本需求是两码事）。
- **Web UI**（`web-ui.ts`）：已有资源目录/子智能体/工作台面板，`upsertAgent` 持久化到 `store.json`。

---

## 2. 结论：为什么不改 haraness 本体即可落地

DSH 的技能机制是 **目录 + `ctx.skills` 注册表 + cwd/scope 感知**。onenat-workbuddy 是**远端客户端**，
它无法直接改远端 `ctx.skills` 的内存层，但可以：

1. 用 **dsh-web-service 的 `/skills` REST 端点**做技能的全生命周期管理（落盘到远端技能根目录）。
2. 用 **PromptComposer 注入技能全文**实现「子智能体会话自动装载」——把绑定技能用
   `renderSkillContent` 同构的 `<skill_content>` 块插到子任务指令前。**这是 D2 模式的自然延伸**。

不依赖 DSH 的 `skill` 工具自动发现（那是模型主动行为），而是**确定性注入**，与「绑定即装载」的需求完全对齐。

> 需在 dsh-web-service 新增 `/skills` 端点模块——这突破 README「D6 零侵入」的旧约定，本期权且以
> 「dsh-web-service 新增能力」的方式实现（不破坏既有端点，向后兼容）。

---

## 3. 总体设计

### 3.1 概念模型

```
技能中心（onenat-workbuddy UI）
   │  选择一个 DSH 目标（子智能体节点 或 任一 direct 节点 / 全局）
   ▼
dsh-web-service /skills REST
   ├─ GET    /skills           列表（name/description/whenToUse/source/root/invocation）
   ├─ GET    /skills/:name     单技能详情（含全文，供预览/下载）
   ├─ POST   /skills           新建/上传技能（JSON 或 multipart）
   ├─ PUT    /skills/:name     更新技能正文/元数据
   └─ DELETE /skills/:name     删除技能（连同 <name>/ 目录或文件）

子智能体（onenat-workbuddy SubAgent.skills: string[]）  ← 绑定的是「已安装」技能名
   ▼
派发子任务/直通时，PromptComposer 对该节点 fetch 每个绑定技能全文
   ▼
组装成 <skill_content> 块注入 fullPrompt  →  远端会话自动装载
```

### 3.2 关键决策点

| 点 | 决策 | 理由 |
|---|---|---|
| D1 技能归属节点 | 每个子智能体在自己节点的技能中心管理自己的技能；全局技能可放「全局 DSH 目标」 | 与「子智能体绑自己已安装技能」一致，注入时从该节点拉全文 |
| D2 上传统一协议 | 优先 **JSON**（`{name, description, whenToUse, invocation, content}`），可选 multipart 文件 | JSON 易于 UI 表单/预览；multipart 便于导入现成 SKILL.md |
| D3 技能根目录 | 端点接受 `root` 参数（默认 `user-dsh` = `~/.dsh/skills`），可选 `project`（需 `cwd`）+ `custom` | 对齐 DSH 发现源，落盘在发现根内即可被 DSH 自动发现 |
| D4 注入形态 | `renderSkillContent()` 同构 `<skill_content name>...` 块，多条连续嵌入 | 与 DSH 原生技能工具输出一致，远端 DSH/该 agent 的 `skill` 目录逻辑不冲突 |
| D5 注入时机 | `PromptComposer.compose()` 结尾追加 `[已装载技能]` 段，`engine.ts` 无需改 | 最小侵入，复用现有 block 注入位 |
| D6 重复/冲突 | 绑定技能在注入时对内容 `dedupe` by name；不覆盖远端同名字技能 | 避免同一技能注入多份撑爆上下文 |

---

## 4. dsh-web-service 侧实现（新增 `/skills` 模块）

### 4.1 新增文件

`dsh-web-service/src/skills.ts`：`registerSkillRoutes(ctx, router)`。在 `index.ts` 的
`apply()` 里加一行 `registerSkillRoutes(ctx, router)`。

### 4.2 端点契约

统一响应壳 `{ ok:boolean, data, error?, code?, timestamp }`（沿用 `sendJson`）。

**1) `GET /skills`**

```ts
// query
{
  root?: 'user-dsh' | 'user-agents' | 'custom' | 'project'  // 缺省 'user-dsh'
  cwd?: string   // root=project 时必填，用于定位项目 .agents/skills / .dsh/skills
  search?: string
}
// data
{
  skills: Array<{
    name: string
    description: string
    whenToUse?: string
    modelInvocable: boolean
    userInvocable: boolean
    source: string          // project-agents / user-dsh / ...
    root: string            // 实际根路径
    path: string            // SKILL.md 绝对路径
    size: number
  }>
}
```

实现：映射 root → 目录（复用 `skill-filesystem` 的根定义，但**直接 fs 扫描**而非
`ctx.skills.list()`——因为 list 只回 userInvocable，管理视图要看到全部+root/path）。
每个子目录若含 `SKILL.md` 即一个技能；扁平 `.md` 也识别。

**2) `GET /skills/:name/body`（下载/预览）**

```ts
// data
{ name, description, whenToUse, invocation, path, content /* 全文 */ }
```
返回 `content`（`SKILL.md` 全文）。供 UI「预览」和「下载为 .md」。`Content-Disposition` 可选。

**3) `POST /skills`（新建/上传）**

```ts
// body (JSON)
{ root?: string, name: string, description: string,
  whenToUse?: string, invocation?: { modelInvocable, userInvocable },
  content: string   // 正文（不含 frontmatter；由服务端拼）
}
// 或 multipart: file=<SKILL.md> + root
// data
{ name, path }   // 落盘：<root>/<name>/SKILL.md；扁平 .md 则 <root>/<name>.md
```
校验：`name` 匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`；`description` 非空；`root` 合法。
服务端用 `yaml` 拼 frontmatter（name/description/whenToUse/disable-model-invocation/user-invocable）。

**4) `PUT /skills/:name`（更新）**

body 同 POST（可只给要改字段）。落盘后**触发 `ctx.skills` 失效**（若有 `skills` 服务，`invalidate`）。

**5) `DELETE /skills/:name?root=...`**

删除 `<root>/<name>/`（目录版）或 `<root>/<name>.md`（扁平）。同样触发 `ctx.skills` 失效。

### 4.3 与 `ctx.skills` 联动

- 只**读管理视图**走 fs 扫描（稳定、含废弃/未装载根）。
- 每次写（POST/PUT/DELETE）后调用 `ctx.get('skills')?.invalidate`（方法可选）或直接触发
  `ctx.events.emit('skills/change')`，让远端该节点的会话目录/`skill` 工具**下个回合即发现**。
- dsh-web-service 的 `inject` 无需强制加 `skills`，用 `ctx.get('skills')` 可选取。

### 4.4 鉴权与开放范围

沿用现有 `apiKey` 校验；`/skills` 全部走鉴权（非 public）。同一 dsh-web-service 只要
`apiKey` 已配，onenat-workbuddy 请求带 `Authorization: Bearer` 即可。

---

## 5. onenat-workbuddy 侧实现

### 5.1 `remote-client.ts` —— 新增技能 CRUD 客户端方法

```ts
// 对齐 DshClient 现有风格，吃 { baseUrl, apiKey }
listSkills(target, opts?: { root?: string; cwd?: string; search?: string })
getSkillBody(target, name, opts?: { root?: string })
createSkill(target, payload)
updateSkill(target, name, payload)
deleteSkill(target, name, opts?: { root?: string })
```
全部带 `AbortSignal.timeout`（10s 量级），err 包装成 `{ ok:false, error }`。

### 5.2 `types.ts` —— 子智能体新增技能绑定

```ts
export interface SubAgent {
  ...
  skills: string[]            // 绑定的「已安装」技能名（kebab-case）
  ...
}
```
`AgentResourceBinding.skillMode`（资源自身技能）**保持原语义不变**，与本需求互不影响。

### 5.3 `store.ts` —— 持久化

`upsertAgent`/`mutateAgent` 透传 `skills`；`store.json` 的 agent 记录随之持久化。追加到
`SubAgent` 的规范化里，缺省 `[]`。

### 5.4 `router.ts` —— 技能中心 + 绑定 REST 端点

```
GET  /api/skills                   ?target=<agentId|direct-url>  → 列表（转发到目标节点）
POST /api/agents/:id/skills        {skills:[...]}                → 覆盖式绑定
GET  /api/agents/:id/skills        → 读绑定列表
（技能中心节点选择：用 `target=agentId` 解析该子智能体节点；或用全局 direct 目标）
```
- `POST /api/agents/:id/skills` 落到 `store.mutateAgent` 写 `agent.skills`。
- `GET /api/skills?target=...` 内部走 `AgentResolver.resolve(agent)` → `listSkills`。
- 提供 `GET /api/agents/:id/skills/preview` 可选：预览绑定技能全文（用于界面「预览装配」）。

### 5.5 `prompt-composer.ts` —— 自动装载绑定技能（核心）

`compose()` 末尾（合成 `[可用资源清单]` 之后、返回前）追加逻辑：

```ts
const skillResults = await this.fetchAgentSkills(agent, ctx)   // 见下
if (skillResults.length > 0) {
  parts.push('')
  parts.push('[已装载技能]（子智能体绑定技能，已注入全文，请直接遵循）:')
  for (const s of skillResults) parts.push(s.renderedBlock)     // <skill_content name=...>
}
```

`fetchAgentSkills`：
1. 解析 `agent.dshRef` → `target`（复用 `AgentResolver`）。
2. 对每个 `agent.skills` 名字：`getSkillBody(target, name)`（带 `cwd=agent.workDir`）。
3. 渲染成 `<skill_content name="${name}">…</skill_content>`（对齐 DSH `renderSkillContent` 结构）。
4. `mask` 模式（预览）只取摘要，不注入全文。

**为什么这样能「自动装载」**：`engine.ts` 已把 `compose().block` 拼进 `fullPrompt`，
远端会话每轮都会看到这段 instruction——模型无需主动调 `skill` 工具即获得技能全文。
（等价于 DSH 用户显式 `/name` 注入路径的确定性版本。）

### 5.6 `web-ui.ts` —— 技能中心面板 + 绑定选择器

新增顶部 nav：「技能中心」页签（或子智能体编辑弹窗内嵌）：
- **目标节点选择器**：下拉列出子智能体/全局 DSH 目标，默认当前编辑的子智能体节点。
- **技能列表**：卡片 = `name + 标签([文件系统]/[可调用:模型/用户]) + description + path`，
  右侧绿色启用开关（跳转载入/禁用仅展示）+ 红色删除按钮 + 每卡「预览/下载」入口。
- **上传**：「技能」+「创建」按钮 → 表单(name/description/whenToUse/content) 或
  multipart 拖拽 SKILL.md 上传。
- **预览/下载**：`GET /skills/:name/body` → 弹窗展示 Markdown，可「下载 .md」。
- **绑定选择器（子智能体编辑页）**：从该节点已安装技能里多选，保存到 `agent.skills`。
- 状态：列表 loading / 空态 / 失败 toast；操作后刷新。

UI 复用现有 `api()` 封装、`.blk` 卡片风格，新 CSS 类 `.skill-card/.skill-tag/.skill-toggle`。

---

## 6. 影响与风险

| 风险 | 缓解 |
|---|---|
| 远端 dsh-web-service 无 `/skills` 端点 | onenat-workbuddy 部署需**配套升级 dsh-web-service**；`listSkills` 404 时降级提示「远端未安装技能端点」 |
| 注入技能全文可能超上下文 | 单技能上限（如 8KB，同 `SKILL_INLINE_LIMIT`）；绑定数量上限（如 8 个）；超限截断并警告 |
| 注入与 DSH `skill` 工具重复 | 注入块加 `[已装载技能]` 标题并采用 DSH `skill_content` 同构结构，语义无冲突；模型不会再重复 load |
| 安全 | 技能全文来自远端节点，仅按绑定的白名单注入；不做远端任意路径读取（只暴露 `/skills` 白名单接口） |
| 破坏 README「D6 零侵入」 | 本期以「dsh-web-service 新增能力」为边界；更新 README 说明 |

---

## 7. 实现顺序（建议 pipeline）

1. **dsh-web-service**：`skills.ts` 端点模块 + `index.ts` 注册 + `openapi.ts` 暴露 → 自测 list/create/get/update/delete。
2. **onenat-workbuddy remote-client.ts**：5 个技能 CRUD 方法。
3. **onenat-workbuddy store/types**：`SubAgent.skills` 字段 + 持久化。
4. **onenat-workbuddy prompt-composer.ts**：`fetchAgentSkills` + 注入块（含 mask/截断）。
5. **onenat-workbuddy router.ts**：`/api/skills` + `/api/agents/:id/skills` 端点。
6. **onenat-workbuddy web-ui.ts**：技能中心面板 + 绑定选择器 + 预览/下载/上传。
7. 集成测试 + 热重载 + 提交。

---

## 8. 待确认项

1. 技能中心**目标节点**：默认「当前子智能体节点」还是「全局 DSH 节点」？（建议：两者都可选，默认当前编辑的智能体节点）
2. 绑定技能后注入是否有**上限**（条数/每条约 8KB）？建议绑定 ≤ 8 条、单条 ≤ 8KB，超限截断。
3. 是否需要 **multipart 整包上传**（技能目录 zip/含 references 资源），还是仅 SKILL.md 单文件即可？建议 v1 仅单 SKILL.md 文本，v2 再支持资源目录上传。
4. dsh-web-service 的 `/skills` 是否随本插件一起发布，还是独立升级 dsh-web-service？
