# 用户管理与项目管理设计文档 - 审查意见

**审查日期**：2026-10-18  
**审查人**：OneNat WorkBuddy 开发维护工程师  
**文档版本**：v1.0 草案

---

## 总体评价

设计文档结构完整、逻辑清晰，覆盖了用户管理与项目管理的核心功能、数据模型、API 设计和业务流程。整体思路符合多用户协作 SaaS 应用的标准实践，并考虑了安全性（防枚举、限流、审计）与边界条件（token 过期、并发、未注册用户）。

**适配性判断**：设计方案与 WorkBuddy 现有架构**基本兼容**，但需要在多个关键环节做适配性调整，以避免与现有的项目体系、认证机制、持久化方案产生冲突。

---

## 核心问题与建议

### 1. 与现有项目体系的关系（最优先确认）

**问题**：待确认事项 §8.8 直指核心——WorkBuddy 已有 `project_manage` 与 `Project` 类型（见 `src/types.ts` + `src/store.ts`），其定义为：

```typescript
export interface Project {
  id: string              // proj-xxxxxxxx
  name: string
  description?: string
  dshRef?: DshRef         // 绑定执行节点（必需）
  workDir?: string        // 工作目录
  instructions?: string   // 项目指令
  members?: SubAgent[]    // 可 @ 的子智能体
  skills?: string[]       // 技能
  resources?: AgentResourceBinding[]
  createdAt: string
  updatedAt: string
  archivedAt?: string
}
```

现有项目是**任务执行上下文的捆绑**（节点 + 工作目录 + 可 @ 成员 + 技能），**无成员权限概念**，任何登录用户可看到所有项目（当前单管理员部署模式下无权限隔离需求）。

**建议**：

#### 方案 A：直接扩展现有 `Project`（推荐）

在现有 `Project` 类型上新增字段：

```typescript
export interface Project {
  // ... 原有字段 ...
  
  // 新增：用户管理与权限
  owner: string               // 创建者 userId（存量项目迁移：取 createdBy 或置空由 admin 认领）
  projectMembers?: {          // 项目成员列表（与 members: SubAgent[] 区分：后者是可 @ 的智能体，前者是人类用户）
    userId: string
    role: 'owner' | 'member'
    joinedAt: string
    invitedBy?: string
  }[]
  visibility?: 'private' | 'team' | 'public'  // 可见性（private=仅成员，team=组织内，public=所有人可读）
}
```

- **优点**：零迁移成本；现有任务、定时任务、API 全部复用；`proj-*` ID 体系统一。
- **缺点**：`Project` 概念过载（既是执行上下文又是权限容器）；需谨慎处理 `members: SubAgent[]` 与 `projectMembers: User[]` 的命名歧义。
- **实施要点**：
  - `src/types.ts` 扩展 `Project` 接口；
  - `src/store.ts` 兼容读取（`projectMembers` 缺省时视为公开项目或管理员全权）；
  - REST API `/api/projects` 扩展响应字段；
  - 权限校验中间件：`GET /api/projects/:id` 检查 `projectMembers` 或平台 admin（见方案 §2）。

#### 方案 B：独立 `UserProject` 实体 + 映射层

新建 `UserProject` 类型（`uproj-*` 前缀），与现有 `Project`（技术项目/任务上下文）解耦：

```typescript
export interface UserProject {
  id: string              // uproj-xxxxxxxx
  name: string
  description?: string
  owner: string
  members: { userId, role, joinedAt, invitedBy }[]
  linkedProject?: string  // 可选关联到现有 proj-* 执行项目
  createdAt, updatedAt, deletedAt
}
```

- **优点**：职责清晰；不破坏现有 `Project` 语义。
- **缺点**：引入两套 ID 体系；任务 `projectId` 需映射层；API 复杂度上升（`/api/user-projects` vs `/api/projects`）。
- **不推荐理由**：WorkBuddy 规模不足以支撑两套项目抽象；用户认知成本高。

**结论**：**推荐方案 A**，直接扩展现有 `Project`，存量数据添加 `owner` 字段（初始 migration 置空或取 `createdBy`，由管理员认领）。

---

### 2. 认证与会话机制

**现状**：`src/auth.ts` 已实现基于 scrypt 的用户认证 + 会话管理（`SESSION_COOKIE`，7 天滑动续期），但当前仅支持**单用户管理员模式**（`auth.json` 存用户列表，无 `role` 字段）。

**问题**：

1. 现有 `AuthUser` 接口无 `role` / `status` 字段，无法区分 admin/user、invited/active/disabled。
2. 现有会话只存 `username`，无 `userId`（设计文档要求关联 `userId`）。
3. `auth.json` 与设计文档的 `users` 表存储分离（设计要求并入 `store.json`）。

**建议**：

#### 选项 1：扩展 `auth.ts` 与 `auth.json`（推荐）

保持认证逻辑独立（`auth.json` 专职登录凭据），扩展字段：

```typescript
export interface AuthUser {
  id: string           // 新增：usr-xxxxxxxx（与 store.json 的 users 关联）
  username: string     // 保留：登录名（邮箱）
  displayName?: string // 新增
  salt: string
  hash: string
  role: 'admin' | 'user'  // 新增
  status: 'invited' | 'active' | 'disabled' | 'deleted'  // 新增
  createdAt: number
  lastLoginAt?: number
}

interface Session {
  userId: string       // 改：原 username 改为 userId
  username: string     // 保留：用于日志
  expiresAt: number
}
```

- `AuthService` 在播种管理员时生成 `id: usr-<uuid>`，`role: 'admin'`，`status: 'active'`。
- 登录成功时 session 存 `userId`，路由层从 session 拿 userId 做权限判定。
- **users 表不必并入 `store.json`**：`auth.json` 作为认证专用存储，避免 store.json 过载（任务/会话数据已达 15.7MB，见 `store.ts` 注释）。

#### 选项 2：并入 `store.json`

将 `users` 表并入 `StorageData`：

```typescript
export interface StorageData {
  agents: SubAgent[]
  tasks: WorkTask[]
  schedules: ScheduledTask[]
  projects: Project[]
  teams: ExpertTeam[]
  users: User[]        // 新增
  settings: WorkBuddySettings
}
```

- **缺点**：认证与业务数据混在同一 JSON 文件，落盘竞争风险上升（流式任务尾随落盘 3s 窗口内，用户登录也触发落盘）。
- **不推荐**：认证是高频写（登录、会话刷新），与任务数据分离存储更健壮。

**结论**：**选项 1**，扩展 `auth.ts` 与 `auth.json`，保持认证独立。

---

### 3. 数据模型适配 JSON 存储

**问题**：设计文档的数据模型（§5）暗含关系型数据库假设（联合唯一约束、外键、条件更新原子性），但 WorkBuddy 实际采用 **JSON 文件落盘**（`store.ts`）：

- 无原生索引：邮箱唯一性需手动遍历校验。
- 无事务支持：「条件更新 affected=1」无法原子执行（并发接受 token 的防重靠内存锁，崩溃窗口内仍可能双写）。
- 软删除 + 归档机制已存在（`archivedAt`、`deletedAt` 时间戳 + 终态任务磁盘骨架化）。

**建议**：

1. **邮箱唯一性**：
   - `AuthService.createUser()` 线性扫描 `users` 数组检查 `email` 重复（现有 `username` 检查逻辑类比）。
   - 邮箱小写归一化：`email.trim().toLowerCase()`。

2. **Token 原子性**（invitation_tokens / project_invitations）：
   - 内存态 `usedTokens: Set<string>`（进程内防双击）+ 落盘 `status: 'used'`。
   - 接受邀请时：
     ```typescript
     if (this.usedTokens.has(tokenHash)) return { error: 'Token 已使用' }
     const inv = this.findToken(tokenHash)
     if (!inv || inv.status !== 'pending') return { error: '无效或已使用' }
     this.usedTokens.add(tokenHash)
     inv.status = 'used'
     inv.usedAt = now()
     this.save()
     ```
   - 崩溃窗口（落盘前重启）可能双接受，但概率极低（3s 窗口 + 手动双击），可接受。

3. **软删除**：
   - 对齐现有 `deletedAt?: string` 模式（用户、项目均可软删除）。
   - 查询时过滤 `deletedAt` 非空记录（或按需求决定是否暴露给管理员）。

4. **联合唯一约束**：
   - `(projectId, userId)` 唯一：`project_members` 作为 `Project.projectMembers[]` 内嵌数组，天然按 projectId 分组，查重时遍历数组检查 `userId`。
   - `(projectId, email)` pending 邀请唯一：`project_invitations` 同理。

**结论**：JSON 存储可承载设计需求，但需手动实现约束校验；原子性靠内存锁 + 尾随落盘，崩溃容忍度已充分（见 `store.ts` 注释：15.7MB 单次快照 ~110ms）。

---

### 4. 邮件发送服务

**问题**：设计要求 SMTP 配置化（§7），但 WorkBuddy 现有架构**无邮件模块**。

**建议**：

1. **依赖注入外部邮件服务**（推荐）：
   - 新建 `src/mail.ts` 封装 SMTP 客户端（推荐用 Node 内置模块或 `nodemailer`，但需评估依赖体积）。
   - 配置走环境变量或 `settings.mail`：
     ```typescript
     settings: {
       onenat: { ... },
       planner: { ... },
       mail: {
         smtp: {
           host: string
           port: number
           secure: boolean
           auth?: { user, pass }
         }
         from: string
         mock?: boolean  // 开发模式：邮件内容写日志，不真发
       }
     }
     ```
   - 开发模式（`mock: true` 或无 SMTP 配置）：邮件内容 console.log + 写 `mail_log`（`status: 'mock'`），满足 smoke 测试需求。

2. **零依赖替代方案**：
   - 邮件功能作为**可选增强**：启动检测 SMTP 配置，缺失时禁用邮件邀请接口（返回 503 + 提示「邮件服务未配置」）。
   - 管理员通过**复制邀请链接**手动发送（控制台 UI 提供「复制邀请链接」按钮，链接含 token）。
   - **优点**：零额外依赖，不破坏「无框架依赖」原则；适配内网部署（无外网 SMTP）。
   - **缺点**：用户体验下降；管理员需手动转发。

**结论**：**短期采用方案 2**（零依赖 + 手动复制链接），**长期演进到方案 1**（可选 SMTP 配置）。邮件模块不阻塞 MVP 交付。

---

### 5. API 路由与鉴权中间件

**问题**：设计文档 API 前缀为 `/onenat-workbuddy/api`（§6），现有路由已在此前缀下（`src/router.ts` 的 `WorkBuddyRouter`），需扩展而非替换。

**建议**：

1. **路由分组**：
   - 认证路由：`/api/auth/*`（login / logout / me / forgot-password / reset-password）
   - 用户管理：`/api/users/*`（需 admin 角色）
   - 邀请路由：`/api/invitations/:token`（公开，token 自鉴权）
   - 项目路由：`/api/projects/*`（扩展现有 `/api/projects`）
   - 项目邀请：`/api/projects/:id/invitations/*` + `/api/project-invitations/:token`

2. **鉴权中间件**（`src/router.ts` 扩展）：
   ```typescript
   function requireAuth(req, res, next) {
     const session = authService.validateSession(req.headers.cookie)
     if (!session) return res.writeHead(401).end(JSON.stringify({ ok: false, error: '未登录' }))
     req.userId = session.userId
     req.username = session.username
     next()
   }

   function requireAdmin(req, res, next) {
     const user = authService.getUserById(req.userId)
     if (!user || user.role !== 'admin') return res.writeHead(403).end(JSON.stringify({ ok: false, error: '需要管理员权限' }))
     next()
   }
   ```

3. **项目权限校验**：
   ```typescript
   function requireProjectMember(req, res, next) {
     const projectId = req.params.id
     const project = store.getProject(projectId)
     if (!project) return res.writeHead(404).end(JSON.stringify({ ok: false, error: '项目不存在' }))
     const isMember = project.projectMembers?.some(m => m.userId === req.userId)
     const isAdmin = authService.getUserById(req.userId)?.role === 'admin'
     if (!isMember && !isAdmin) return res.writeHead(404).end(JSON.stringify({ ok: false, error: '项目不存在' }))  // 防枚举
     req.project = project
     next()
   }
   ```

**结论**：路由与中间件需在 `router.ts` 扩展，复用现有 `WorkBuddyRouter` 结构。

---

### 6. 待确认事项的建议答案

针对 §8 的 10 个待确认事项，给出工程视角的默认答案：

| 编号 | 待确认事项 | 建议 |
|---|---|---|
| 1 | 邮箱域名白名单 | **不限制**。内网部署通常无公网邮箱，限制会增加配置复杂度；若需要，后期通过正则配置 `settings.mail.allowedDomains`。 |
| 2 | 密码策略与 SSO | **≥8 位字母+数字可接受**（符合 NIST 最新指南）。SSO/LDAP 预留：`AuthUser` 新增 `authType?: 'local' | 'sso' | 'ldap'`，SSO 用户无 `hash` 字段。 |
| 3 | 邀请有效期 | **沿用设计文档默认值**（注册 72h、项目 7d、重置 24h），后期可配置化（`settings.invitations.ttl`）。 |
| 4 | 项目成员能否邀请他人 | **默认仅 owner 可邀请**（member 无邀请权限）。若开放，需新增 `canInvite` 权限位，增加复杂度，不建议 MVP 包含。 |
| 5 | 平台 admin 可见所有项目 | **是**。WorkBuddy 定位为企业内部工具，管理员全局可见符合运维需求；非成员 admin 访问项目时返回 200 但标记「管理员访问」。 |
| 6 | 唯一 owner 离开策略 | **强制转让**（前端阻止 + 后端 422）。自动转让逻辑复杂（选谁？最早成员？最活跃？），不如强制用户显式操作。 |
| 7 | 邀请 token 存储 | **统一表**（`invitation_tokens` 加 `type` 字段区分 user_invite / password_reset / project_invite）。复用 token 机制代码，减少重复。 |
| 8 | 项目体系关系 | **方案 A：扩展现有 `Project`**（见 §1）。存量项目迁移：添加 `owner` 字段（初始为空或取 `createdBy`），由管理员认领。 |
| 9 | 邮件通道 | **短期零依赖手动复制链接，长期可选 SMTP**（见 §4）。失败重试：3 次指数退避（1s / 2s / 4s），记录 `mail_log.attempt`。 |
| 10 | 用户删除 | **软删除 + 定期清理**。`deletedAt` 标记 + 90 天后物理删除（可配置）。GDPR 诉求：提供「立即物理删除」管理接口（`DELETE /api/users/:id?permanent=true`）。 |

---

## 实施优先级建议

### Phase 1: MVP（P0 功能）

1. **扩展 `auth.ts` 与 `Project`**：
   - `AuthUser` 添加 `id / displayName / role / status` 字段。
   - `Project` 添加 `owner / projectMembers / visibility` 字段。
   - Session 存 `userId`。

2. **用户管理核心流程**（管理员创建 + 邀请链接 + 注册激活）：
   - U-01, U-02, U-03：`POST /api/users` + `GET/POST /api/invitations/:token`。
   - 邮件功能暂用**手动复制链接**（控制台 UI 提供复制按钮）。

3. **项目权限校验**：
   - P-01, P-02, P-03, P-06, P-10：创建/列表/详情/成员管理/权限中间件。
   - 项目邀请暂用**手动添加成员**（管理员在项目设置里直接选择已注册用户添加）。

4. **前端 UI**：
   - 登录页（已有 `login-ui.ts`，扩展表单字段）。
   - 用户列表（管理员）+ 邀请接受页（公开）。
   - 项目列表（owned / joined 分页）+ 成员管理页。

### Phase 2: 完善（P1 功能）

1. **邮件邀请**（P-04, P-05, P-09）：
   - 集成 SMTP（可选配置）或外部邮件服务 API。
   - 项目邀请全流程（发送 + 接受 + 撤销/重发）。

2. **用户自助功能**（U-06, U-07, U-12）：
   - 修改密码、忘记密码/重置、个人资料编辑。

3. **项目高级功能**（P-07, P-08）：
   - 退出项目 + owner 转让。
   - 归档/恢复（复用现有 `archivedAt` 机制）。

### Phase 3: 增强（P2 及待定）

1. **用户删除**（U-11）+ GDPR 支持。
2. **审计日志**（B-03）：扩展 `store.ts` 的 `audit_log` 数组。
3. **SSO/LDAP 集成**（待确认 §8.2）。

---

## 安全与非功能要点补充

1. **限流实现**：
   - 邮件接口：内存 `Map<string, number[]>`（按 `${ip}:${email}` 记录时间戳数组，滑动窗口 1h 内 5 次）。
   - 登录失败：现有 `AuthService` 已实现（5 分钟内 10 次 → 429）。

2. **防枚举**：
   - `/auth/forgot-password`：恒返回 202（不管邮箱是否存在）。
   - 非成员访问项目：404 而非 403（已在 §5 中间件实现）。

3. **审计日志字段**：
   ```typescript
   interface AuditLog {
     id: string
     actorId: string          // userId
     action: string           // 'user.invite' | 'project.member.add' | ...
     targetType: string       // 'user' | 'project' | 'invitation'
     targetId: string
     detail?: string          // JSON 字符串（变更前后对比）
     ipAddress?: string
     userAgent?: string
     createdAt: string
   }
   ```

4. **Token 安全**：
   - `crypto.randomBytes(32)`（256 位熵）+ `base64url` 编码（无 `+/=` 字符，URL 安全）。
   - sha256 哈希落库（即使数据库泄露，token 原文不可逆推）。
   - 校验顺序：存在 → 未过期 → 未撤销 → 未使用（短路优化，减少时间攻击面）。

---

## 测试策略

1. **Smoke 测试扩展**（`scripts/smoke.js`）：
   - 用户注册全流程（mock SMTP）：创建 → 获取 token → 激活 → 登录。
   - 项目创建 + 成员添加（手动模式，跳过邮件）。
   - 权限校验：非成员访问项目 → 404。

2. **单测覆盖**：
   - `auth.ts`：scrypt 哈希、session 过期、登录限流。
   - Token 校验状态机：pending → used / expired / revoked。
   - 邮箱唯一性、项目成员去重。

3. **E2E 场景**（`scripts/smoke-e2e.js`）：
   - 管理员创建用户 → 用户登录 → 创建项目 → 邀请成员 → 成员接受 → 协作任务。

---

## 迁移计划（存量数据兼容性）

**背景**：现有部署可能已有项目与任务数据（`store.json`）、管理员账号（`auth.json`）。

**迁移步骤**（向后兼容，零停机）：

1. **代码部署**：
   - `src/types.ts` 扩展 `Project` / `AuthUser` 接口，字段全部 optional（`owner?: string`）。
   - `src/store.ts` 读取时兼容旧格式（`projectMembers` 缺省视为空数组）。

2. **数据迁移脚本**（`scripts/migrate-user-project.js`）：
   ```javascript
   // ① auth.json：为现有管理员添加 id / role / status
   for (const user of auth.users) {
     if (!user.id) user.id = `usr-${randomUUID()}`
     if (!user.role) user.role = 'admin'
     if (!user.status) user.status = 'active'
   }

   // ② store.json：为现有项目添加 owner
   for (const proj of store.projects) {
     if (!proj.owner) {
       proj.owner = '' // 置空，由管理员在控制台认领
       // 或：proj.owner = proj.createdBy（需先迁移 createdBy → userId 映射）
     }
   }
   ```

3. **控制台提示**：
   - 首次登录后检测 `projects.filter(p => !p.owner).length`，若 >0 提示「有 N 个项目待认领」。
   - 管理员点击「认领」按钮批量设置 `owner`。

4. **灰度策略**：
   - 部署后权限校验**默认宽容模式**（`owner` 为空的项目所有人可见）。
   - 管理员完成认领后，在设置页切换到**严格模式**（启用权限隔离）。

---

## 遗留风险与待办

1. **并发写冲突**：
   - JSON 落盘无事务，极端情况下同时接受邀请 + 修改项目可能导致一方丢失。
   - **缓解**：内存锁 + 尾随落盘窗口 3s（见 `store.ts`）；实际冲突概率极低。
   - **未来优化**：引入 SQLite（零配置嵌入式数据库）或迁移到 PostgreSQL。

2. **邮件依赖**：
   - 无邮件服务时邀请流程依赖手动操作。
   - **缓解**：控制台 UI 提供「复制邀请链接」+ 「手动添加成员」两条备用路径。

3. **Token 过期清理**：
   - 过期 token 累积占用存储（每个 ~200B，1 万次邀请 ~2MB）。
   - **缓解**：定期清理任务（类似 `archiveSweep`），每周删除 30 天前的过期 token。

4. **GDPR 合规**：
   - 物理删除用户需级联清理其所有数据（会话、审计日志、项目历史）。
   - **待办**：实现 `/api/users/:id/export`（导出用户全部数据）+ `/api/users/:id?permanent=true`（级联物理删除）。

---

## 结论

设计文档整体质量高，逻辑完整，符合多用户协作 SaaS 应用的行业标准。**关键适配点**：

1. **扩展现有 `Project` 而非新建独立实体**（最优先确认）。
2. **扩展 `auth.ts` 添加 `role` / `status` / `userId`，保持认证独立**。
3. **JSON 存储需手动实现唯一约束与原子性校验**（可接受）。
4. **邮件功能短期零依赖（手动复制链接），长期可选 SMTP 配置**。
5. **分阶段交付**：MVP 聚焦核心权限隔离，邮件邀请与高级功能后置。

**下一步行动**：

- [ ] 与产品确认待确认事项 §8（尤其第 8 条项目体系关系）。
- [ ] 评审本文档建议的技术方案（方案 A vs B）。
- [ ] 产出详细设计规范（API 接口定义、TypeScript 类型、数据库 schema）。
- [ ] 准备 Phase 1 开发排期（预估 2-3 周 MVP）。
