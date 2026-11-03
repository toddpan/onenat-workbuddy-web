# 用户管理与项目管理系统设计文档

- 版本：v1.0（草案，待评审）
- 日期：2026-10-18
- 关联项目：OneNat WorkBuddy（onenat-workbuddy-web）
- 原始需求：
  1. 用户管理：用户由管理员添加，新创建的用户通过邮箱发送邀请链接，用户通过链接补全信息（设置密码等）。
  2. 项目管理：用户可以创建自己的项目，可以邀请其它用户加入项目，通过邮件发送邀请链接。

---

## 1. 功能列表

### 1.1 用户管理（User Management）

| 编号 | 功能 | 说明 | 优先级 |
|---|---|---|---|
| U-01 | 管理员创建用户 | 管理员填写邮箱（必填）、显示名、备注，生成 `invited` 态用户 | P0 |
| U-02 | 邮箱邀请链接 | 系统向新用户邮箱发送一次性邀请链接（带 token，有效期） | P0 |
| U-03 | 邀请补全信息 | 用户点击链接，设置密码（+可选昵称），激活账号为 `active` | P0 |
| U-04 | 邀请重发/撤销 | 邀请未接受前，管理员可重发（旧 token 作废）或撤销邀请 | P1 |
| U-05 | 用户登录/登出 | 邮箱 + 密码登录，会话（session cookie/token）管理 | P0 |
| U-06 | 修改密码 | 用户主动修改密码（验证旧密码）；忘记密码走重置邮件 | P1 |
| U-07 | 忘记密码/重置 | 邮箱接收重置链接（与邀请链接同机制，类型不同） | P1 |
| U-08 | 用户列表/搜索 | 管理员分页查看用户，按邮箱/状态/角色过滤 | P0 |
| U-09 | 禁用/启用用户 | 管理员禁用用户：立即失效其会话，不可登录；启用恢复 | P0 |
| U-10 | 角色分配 | 管理员可授予/收回 `admin` 角色 | P0 |
| U-11 | 删除用户 | 软删除；其在项目中的成员关系处理见 §4.4 | P2 |
| U-12 | 个人资料 | 用户查看/修改自己的显示名、邮箱（改邮箱需验证，见待确认） | P1 |

### 1.2 项目管理（Project Management）

| 编号 | 功能 | 说明 | 优先级 |
|---|---|---|---|
| P-01 | 创建项目 | 任何 `active` 用户可创建项目，创建者为 `owner` | P0 |
| P-02 | 项目列表 | 「我创建的 / 我参与的」两个视图，分页 | P0 |
| P-03 | 项目详情/编辑 | 名称、描述；owner/admin 可编辑 | P0 |
| P-04 | 邮件邀请成员 | 成员（默认 owner/admin）填邮箱发邀请链接 | P0 |
| P-05 | 邀请接受 | 已注册用户登录后接受；未注册用户先走 U-03 注册再自动入项 | P0 |
| P-06 | 成员管理 | 列表、改角色、移除成员（owner/admin，且不能移除唯一 owner） | P0 |
| P-07 | 退出项目 | 成员主动退出；owner 退出前需转让或项目需有其他 owner | P1 |
| P-08 | 删除/归档项目 | 仅 owner（或平台 admin），软删除归档，可恢复 | P1 |
| P-09 | 邀请管理 | 查看项目待处理邀请，可撤销/重发 | P1 |
| P-10 | 项目内权限校验 | 非成员不可见项目内容；成员按角色限定操作 | P0 |

### 1.3 基础能力

| 编号 | 功能 | 说明 |
|---|---|---|
| B-01 | 邮件发送服务 | SMTP 配置化；发送失败重试与记录（mail_log） |
| B-02 | 一次性令牌 | 邀请/重置统一 token 机制：随机、哈希落库、有效期、单次有效 |
| B-03 | 审计日志 | 关键操作（邀请、入项、角色变更、禁用）落审计表 |
| B-04 | 速率限制 | 邀请/重置等发邮件接口限流，防滥用 |

---

## 2. 用户体系

### 2.1 角色（平台级）

| 角色 | 权限 |
|---|---|
| `admin`（管理员） | 用户全生命周期管理（创建/禁用/删除/授权）、查看全部用户、全局设置 |
| `user`（普通用户） | 管理自己的账号与项目；只能操作自己是成员的项目 |

- 第一个初始化账号由部署方以管理员方式创建（如 CLI / 环境变量引导），后续管理员由管理员授予。
- 管理员同时也是普通用户，可创建/参与项目。
- 系统至少保留 1 名启用状态的管理员（防止最后一个 admin 被禁用/降级）。

### 2.2 用户状态机

```
created(管理员录入) ──发邀请──> invited
invited ──token 有效期内完成设置密码──> active
invited ──token 过期──> 仍为 invited，需重发（重发刷新 token）
active ──管理员禁用──> disabled
disabled ──管理员启用──> active
任意态 ──管理员删除──> deleted（软删除）
```

约束：
- 邮箱全局唯一（含 invited 态；重复创建返回冲突，或提示「重发邀请」）。
- `invited` 用户不可登录（无密码）；token 过期后原链接失效。
- `disabled` / `deleted` 用户的所有会话立即失效，且在成员列表中标记但不参与权限判定。

### 2.3 认证与会话

- 密码：scrypt（与现网 auth.json 机制一致）加盐落库，不存明文。
- 会话：登录成功签发HttpOnly Cookie（服务端 session 表或签名 token），有效期 7 天滑动续期；登出/禁用即吊销。
- 所有 REST API（除 登录/邀请接受/公开健康检查）要求登录态；管理接口另要求 `admin` 角色。

---

## 3. 项目体系

### 3.1 项目角色（项目级）

| 项目角色 | 权限 |
|---|---|
| `owner` | 全部权限：编辑、删除/归档、邀请、改成员角色、移除成员、转让 |
| `member` | 查看项目与内容、（可选）邀请（见待确认 §8.4） |

- 创建者默认 `owner`；一个项目至少 1 个 `owner`。
- `owner` 退出或被移除前必须先转让 owner，或保证项目还有其他 owner。
- 项目角色与平台角色独立：平台 admin 不自动成为项目成员（是否「管理员可进入任意项目」见待确认 §8.5）。

### 3.2 项目状态

`active`（正常）→ `archived`（归档：只读，不可邀请/编辑）→ 可恢复；`deleted` 为软删除，N 天后物理清理（默认 30 天，可配置）。

### 3.3 邀请状态机（项目邀请）

```
pending ──接受──> accepted（写 members 记录，邀请关闭）
pending ──拒绝/撤销──> declined / revoked
pending ──过期（默认 7 天）──> expired，需重发
```

- 邀请按「项目 + 邮箱」唯一（pending 态不可重复发，可重发刷新 token/有效期）。
- 被邀请邮箱已是成员：提示无需邀请，不发送邮件。
- 被邀请人未注册：接受页引导其先完成注册（U-03 同页复用：设置密码 + 接受邀请一步完成）。

---

## 4. 核心业务流程

### 4.1 管理员邀请用户（注册）

```
管理员                     系统                              新用户
  │ POST /api/users         │                                 │
  │ {email, displayName}    │                                 │
  ├────────────────────────>│ 校验邮箱唯一 → 建 invited 用户    │
  │                         │ 生成 inviteToken(随机32B)        │
  │                         │ 存哈希 + 过期时间(72h)            │
  │                         │ 发邮件: /invite/accept?token=…   │
  │<────────────────────────┤ 201 {userId}                    │
  │                         │                                 │ 打开链接
  │                         │<──── GET /api/invites/:token ───┤ (回显邮箱/有效期)
  │                         │<─── POST /api/invites/:token ───┤ {password,…}
  │                         │ 校验 token 未用未过期            │
  │                         │ scrypt 存密码 → 状态 active      │
  │                         │ token 标记 used                  │
  │                         │──── 自动登录(签发会话) ──────────>│ 进入控制台
```

边界条件：
- token 错误/已用/过期：页面提示并引导「联系管理员重发」；POST 一律 410/400。
- 邮件发送失败：用户保持 invited，管理员可重发；mail_log 记录失败原因。
- 同一邮箱已 active：创建接口返回 409。
- 密码策略：≥8 位，含字母与数字（可配置）；前端+后端双校验。

### 4.2 用户创建项目并邀请成员

```
用户A(creator)             系统                          用户B
  │ POST /api/projects      │                             │
  ├────────────────────────>│ 建 project + member(A,owner) │
  │<────── 201 {projectId} ─┤                             │
  │ POST /api/projects/:id/invitations {email}            │
  ├────────────────────────>│ 校验：A 是 owner、B 非成员、  │
  │                         │ 无 pending 邀请              │
  │                         │ 生成邀请 token(7 天)，发邮件   │
  │<──────── 201 ───────────┤                             │
  │                         │   B 打开链接                  │
  │                         │<─ GET /api/project-invites/:token（回显项目名/邀请人）
  │                         │   B 已登录?                   │
  │                         │     是 → POST 接受            │
  │                         │     否 → 登录/注册后接受       │
  │                         │ 写 member(B,member)，邀请=accepted
  │<── 事件: B 加入项目 ─────┤                             │
```

边界条件：
- 未注册邮箱接受：同一页面完成「设置密码（注册）+ 入项」，中间不丢邀请上下文（token 在注册后仍有效，或注册成功自动续接）。
- 邀请过期/撤销后点链接：明确提示，不可接受。
- 邀请期间该邮箱被禁用/删除：接受时拒绝（403）。
- 并发接受（同一 token 双击）：token 原子置 used（条件更新 affected=1 才成功）。

### 4.3 成员移除 / 退出

- 移除：owner/admin 发起 → 删除 member 记录 → 审计；被移除者会话仍有效但失去该项目访问权（下次访问 403）。
- 退出：member 可直接退出；最后一个 owner 不可退出/被移除，需先转让（POST transfer-ownership）。

### 4.4 用户删除对项目的影响

软删除用户：其 member 记录保留但标记 inactive（项目成员列表显示「已注销」）；若其为项目唯一 owner，项目转为无主，由平台 admin 指派新 owner（或按待确认 §8.6 策略自动转让）。

---

## 5. 数据模型

> 存储沿用项目现状：JSON 文件落盘（store.ts）即可承载；字段定义与关系型等价，便于未来迁移。时间统一存 ISO 字符串（UTC）。

### 5.1 users

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string (uuid) | 主键，`usr-` 前缀 |
| email | string | 唯一，小写归一化 |
| displayName | string | 显示名 |
| passwordHash | string? | scrypt；invited 态为空 |
| role | `admin` \| `user` | 平台角色 |
| status | `invited` \| `active` \| `disabled` \| `deleted` | 状态机 |
| createdBy | string? | 邀请人（管理员）userId |
| createdAt / updatedAt / lastLoginAt | string | 时间戳 |

### 5.2 invitation_tokens（用户注册邀请 & 密码重置共用）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 主键 |
| type | `user_invite` \| `password_reset` | 用途 |
| tokenHash | string | sha256(token)，token 本体只在邮件链接中出现 |
| email | string | 目标邮箱 |
| userId | string? | 关联用户（user_invite 必有） |
| status | `pending` \| `used` \| `revoked` | 状态 |
| expiresAt | string | 默认 72h（重置 24h） |
| usedAt / createdAt | string | |

### 5.3 projects

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | `proj-` 前缀（与现有 WorkBuddy 项目 ID 体系对齐或做映射层） |
| name | string | 必填，≤100 字符 |
| description | string? | |
| status | `active` \| `archived` \| `deleted` | |
| createdBy | string | owner 的 userId（初始） |
| createdAt / updatedAt / deletedAt | string | |

### 5.4 project_members

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 主键 |
| projectId | string | 联合唯一 (projectId, userId) |
| userId | string | |
| role | `owner` \| `member` | 项目角色 |
| status | `active` \| `inactive` | inactive=成员账号已注销 |
| joinedAt | string | |
| invitedBy | string? | |

### 5.5 project_invitations

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 主键 |
| projectId | string | |
| email | string | |
| tokenHash | string | 同 5.2 机制（也可并入 5.2 加 projectId，二选一，见 §8.7） |
| role | `member` \| `owner` | 入项角色（默认 member） |
| status | `pending` \| `accepted` \| `declined` \| `revoked` \| `expired` | |
| invitedBy | string | 发起人 userId |
| expiresAt / respondedAt / createdAt | string | |

### 5.6 sessions（登录会话）

| 字段 | 说明 |
|---|---|
| id / userId / tokenHash / createdAt / expiresAt / revokedAt | 服务端会话表，吊销即失效 |

### 5.7 mail_log / audit_log

- mail_log：type、to、subject、status（sent/failed）、error、attempt、createdAt。
- audit_log：actorId、action（如 `user.invite`、`project.member.remove`）、targetType/targetId、detail、createdAt。

### 5.8 关系小结

```
users 1─* invitation_tokens (via userId/email)
users *─* projects  (via project_members)
projects 1─* project_invitations
users 1─* sessions
```

---

## 6. API 清单

前缀：`/onenat-workbuddy/api`（与现有 REST 前缀一致）。鉴权：除标注「公开」外均需登录；标注 🔒 需平台 admin。

### 6.1 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/login` | 公开。{email, password} → 会话 Cookie |
| POST | `/auth/logout` | 吊销当前会话 |
| GET | `/auth/me` | 当前用户信息与角色 |
| POST | `/auth/forgot-password` | 公开。{email}，恒返回 202（不泄露邮箱是否存在） |
| POST | `/auth/reset-password` | 公开。{token, newPassword} |

### 6.2 用户管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/users` | 🔒 分页；?status=&role=&q= |
| POST | `/users` | 🔒 {email, displayName}，创建并自动发邀请；409 已存在 |
| POST | `/users/:id/resend-invite` | 🔒 重发（旧 token 作废） |
| POST | `/users/:id/disable` / `/enable` | 🔒 禁用/启用 |
| PUT | `/users/:id` | 🔒 改 displayName/role；降级校验「至少一个 admin」 |
| DELETE | `/users/:id` | 🔒 软删除 |
| GET | `/users/me` | 同 /auth/me（保留其一） |
| PUT | `/users/me/password` | 改自己密码 {oldPassword, newPassword} |
| PUT | `/users/me/profile` | 改自己 displayName |

### 6.3 用户注册邀请（公开，token 鉴权）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/invitations/:token` | 公开。校验并回显 {email, expiresAt, valid}，不消耗 token |
| POST | `/invitations/:token` | 公开。{password, displayName?} → 激活账号并自动登录 |

### 6.4 项目

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects` | ?scope=owned\|joined\|all(admin)，分页 |
| POST | `/projects` | {name, description?}，创建者为 owner |
| GET | `/projects/:id` | 成员可见；非成员 404（不泄露存在性） |
| PUT | `/projects/:id` | owner 可改 |
| POST | `/projects/:id/archive` / `/restore` | owner |
| DELETE | `/projects/:id` | owner/平台 admin，软删除 |

### 6.5 项目成员与邀请

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/:id/members` | 成员可见 |
| PUT | `/projects/:id/members/:memberId` | owner 改角色（保留至少 1 owner） |
| DELETE | `/projects/:id/members/:memberId` | owner 移除（同上约束）；member 可删自己=退出 |
| POST | `/projects/:id/ownership-transfer` | owner → {targetMemberId} |
| GET | `/projects/:id/invitations` | owner；pending 列表 |
| POST | `/projects/:id/invitations` | {email, role?}；409 已成员/pending |
| POST | `/projects/:id/invitations/:invId/resend` / `/revoke` | owner |
| GET | `/project-invitations/:token` | 公开。回显 {projectName, inviter, valid} |
| POST | `/project-invitations/:token` | 接受；需登录，未注册时前端引导注册后回跳 |

统一响应：`{ok:true,data}` / `{ok:false,error}`；错误码沿用 200/201/400/401/403/404/409/410。

---

## 7. 邮件与令牌规范

- 邮件模板：注册邀请、密码重置、项目邀请 3 类；含产品名、操作按钮链接、有效期提示、「非本人操作请忽略」。
- 链接格式：`{BASE_URL}/onenat-workbuddy/#/invite?token=…`、`/#/project-invite?token=…`、`/#/reset?token=…`（BASE_URL 取自部署配置）。
- token：`crypto.randomBytes(32).toString('base64url')`；库中仅存 sha256 哈希；校验顺序：存在 → 未过期 → 未撤销 → 未使用，条件更新原子置 used。
- SMTP：host/port/username/password/from 走环境变量或管理设置；未配置 SMTP 时进入「开发模式」——邮件内容写入日志与 mail_log（status=mock），便于 smoke 测试。

---

## 8. 待确认事项

1. **邮箱域名白名单**：是否限制只允许公司域名注册/被邀请？:不用
2. **密码策略与 SSO**：当前密码≥8 位字母+数字是否可接受？未来是否接企业 SSO/LDAP（影响 users 表与登录流程预留）？：可以接受
3. **邀请有效期**：注册邀请 72h、项目邀请 7 天、重置链接 24h，是否需要调整？：不用调整
4. **项目成员能否邀请他人**：默认仅 owner/admin 可邀请，是否放开给普通 member？：用户可以邀请其它加入自己创建的项目。
5. **平台 admin 是否可见/可进入所有项目**：合规上常见，但涉及隐私，需产品确认。
6. **唯一 owner 离开的处理策略**：强制转让 vs 平台 admin 代管，选哪种默认行为？
7. **邀请 token 存储方案**：项目邀请并入统一 invitation_tokens 表（type=project_invite）还是独立表？建议统一表以复用令牌机制。
8. **与 WorkBuddy 现有项目体系的关系**：本文档的「项目」是否即现有 `project_manage` 的项目（新增成员/权限维度），还是独立的新模块？若是前者，现有项目无 owner 概念，需数据迁移策略（存量项目 owner=创建者或置空由 admin 认领）。
9. **邮件通道**：SMTP 直发 or 复用企业邮件网关/飞书邮箱？失败重试策略（建议 3 次指数退避）。
10. **用户删除**：是否允许物理删除（GDPR 类诉求）？数据保留多久？

---

## 9. 非功能与安全要点

- 所有用戶输入长度/格式校验；邮箱小写归一化去重。
- 防枚举：forgot-password 恒定响应；项目详情对非成员返回 404 而非 403。
- 限流：发邮件类接口按 IP+目标邮箱 5 次/小时。
- 审计：所有 §1.3 B-03 列出的动作落 audit_log，管理端可查。
- 移动端：邀请接受页需适配 ≤768px 与微信 X5 旧内核（沿用现有前端约束）。
- 测试：注册邀请全流程、项目邀请全流程纳入 smoke（mock SMTP），关键状态机加单测。

---

## 10. 权限模型扩展（资源与子智能体归属）

> 基于现有 `src/types.ts` 实际落点（`ProjectMember`、`Project.visibility`，`SshResource` / `SubAgent` 均无归属字段）补充的核心思路：**平台角色管「人」，项目管「业务上下文」，资源与子智能体用独立的所有权/共享模型，不挂在项目角色上**。

### 10.1 权限总模型：四层

| 层 | 载体 | 决定什么 |
|---|---|---|
| 平台角色 | `user.role: admin \| user` | 用户/全局设置/审计；admin **不**自动穿透项目内容 |
| 项目成员 | `ProjectMember.role: owner \| member` + `visibility` | 项目及项目内任务/文件/成员管理 |
| 资源所有权 | 每类资源加 `ownerUserId` + `sharedProjectIds?` 或 `visibility` | SSH 资源、DSH 节点引用、连接器 |
| 智能体归属 | `SubAgent.ownerUserId` + `projectIds`（可绑多项目） | 子智能体/专家/专家团谁能看、谁能改、谁能 @ |

原则：**默认最小可见，显式共享**；存量数据走宽容模式（`owner` 缺省 = 所有人可用，与现有 `Project.owner?` 注释一致）。此处的「可用」指**读面**；写面（改/删/取明文）对无归属的存量实体收敛为「仅管理员」，见 §10.7「存量口径」。

### 10.2 用户与项目（§2/§3 微调）

- 平台两级角色即可，不引入 RBAC 大表：`admin`（用户生命周期、全局设置、**可进任意项目但需显式「以管理员身份进入」并落审计**）、`user`。
- 项目角色就 `owner`/`member` 两级；member 的「可邀请」做成开关而非第三种角色，即 `project.allowMemberInvite: boolean`（对应 §8.4 已确认放开）。
- `visibility`：`private=仅成员`、`team=登录可见（只读摘要，进入仍需成员）`；`public` 不开放（单机部署，语义多余），保留字段但默认禁用。
- 权限判定收口到一个 `canAccessProject(userId, projectId, action)`，所有 REST 路由统一前置调用，避免散落判断；现状 `projectMembers` 缺省即全员可见的宽容模式必须集中在这一处处理。

### 10.3 资源（SSH / ONENAT 映射 / 连接器）

资源分两类，模型不同：

**① 本地 SSH 资源池（`SshResource`，含密码/私钥，最敏感）**
- 加 `ownerUserId`（创建者）+ `visibility: 'private' | 'shared'`。
- 共享不走全局公开，只走**项目绑定**：`Project.connectorIds` 中 `ssh:<id>` 表示该资源已共享给该项目所有成员可 *使用* —— 但 `get`（取回明文凭据）仅 owner，`exec` 成员可用（现有 skill「ssh exec 危险操作先确认」的权限落点）。
- 判定矩阵：`list`=看到自己 + 所在项目绑定的；`use(exec/upload)`=owner 或所在项目绑定了它；`get 明文/delete/upsert`=仅 owner（+平台 admin）。

**② ONENAT 隧道资源目录（mapping/app，平台级只读）**
- 目录本身是全局事实（只读、实时解析），**不设权限**，全员可见。
- 敏感点在**凭证**：沿用 `credentialMode`（`inline/self-fetch/omit`）；「能否选某节点作为项目 dshRef」做成资源级授权：默认全员可选（单机/小团队），如需收紧再加 `DshRefACL: allowUserIds[]`（缺省=允许）。第一步不做节点 ACL（YAGNI）。

### 10.4 子智能体 / 专家 / 专家团

- `SubAgent` 加 `ownerUserId`；专家库（expert-registry）与专家团（expert-teams）同理。
- 专家库保留「公共名册」属性：名册条目全员可见可用，仅 owner/admin 可改删；子智能体（含 apiKey、systemPrompt 等私有配置）默认 private。
- 子智能体共享同样走**项目绑定**（`project.defaultAgentIds` 或任务内 `@`）：绑定到项目的子智能体，项目成员可在任务里 @ 它，但不能查看/编辑其 apiKey、systemPrompt —— **API 返回时对非 owner 脱敏**（沿用现有 `SshResourceMasked` 模式）。
- `ping/preview/models` 这类只读探测：能 @ 就能用。

### 10.5 任务与文件

- 任务天然归属项目（无项目个人任务归属创建者本人）→ 权限完全跟随项目成员，不单独设计。
- 工作区文件跟随项目 workspace → 同上；跨项目传文件（P2P 直传 URL）保持现状「URL+节点 apiKey 即可取」，但节点 apiKey 不进普通成员可见字段。
- 定时任务：跟随其引用的项目/智能体的可见性，owner 可改删，成员可见只读。

### 10.6 落地清单（按依赖顺序）

1. `auth/users` 增加 `role` 字段 + admin 守卫中间件（已有 login/auth 基础，改动小）。
2. 统一 `perm.ts`：`requireAdmin` / `canAccessProject` / `canUseResource` / `canManageResource` 四个判定函数，路由收口。
3. 存量迁移宽容模式：`owner`/`visibility` 全部 optional，缺省=旧行为（全员可用），UI 提示「未启用成员隔离」。
4. `SshResource`/`SubAgent`/Expert/Team 加 `ownerUserId` + 脱敏返回；共享只经项目绑定，不做独立分享链接。
5. 审计（B-03）覆盖：角色变更、成员增删、资源/智能体改删、admin 穿透进入项目。

### 10.7 已落地实现（Phase 3）

> 落地范围：§10.1~§10.4 的判定层与接线（不含任务/文件/定时任务跟随、审计扩展、DSH 节点 ACL）。

**新增模块 `src/perm.ts`（纯函数，无 IO，可单测）**

| 函数 | 语义 |
|---|---|
| `canAccessProject(session, project, action)` | 项目动作判定（`view/edit/manageMembers/invite/archive/delete`）；宽容模式（无 owner 且无成员）仅 admin 可改 |
| `canViewResource` / `canUseResource` / `canManageResource` / `canAccessResource` | 资源动作判定（`view/use/reveal/manage`）；**存量（无归属）资源：可见可用全员，写面（改/删/取明文）仅 admin** |
| `canViewAgent` / `canUseAgent` / `canManageAgent` | 智能体可见/可用/可改判定；**存量（无归属）智能体：可见可用全员，改删仅 admin** |
| `maskAgentForViewer(agent, session)` | 非归属人返回脱敏副本（剔除 `apiKey` / `systemPrompt` / `executionPrompt`），不改原对象 |
| `projectIsolated` / `isProjectMember` / `isProjectOwner` / `projectBindsResource` | 基础判定与项目绑定关系 |

**类型新增（`src/types.ts`）**

- `SshResource.ownerUserId?` + `SshResource.visibility?: 'private' | 'shared'`
- `SubAgent.ownerUserId?` + `SubAgent.sharedProjectIds?`
- `ExpertTeam.ownerUserId?`
- `Project.allowMemberInvite?`（成员邀请开关；缺省 = 仅 owner/admin 可邀请）

**路由接线（`src/router.ts`）**

| 面 | 规则 |
|---|---|
| `GET /api/ssh-resources` | 只返回本人可见（归属人 / admin / 项目绑定成员）的脱敏视图 |
| `GET /api/ssh-resources/:id` | 归属人/admin 返回明文；其余可见者返回脱敏视图；不可见者 404（防枚举） |
| `POST/PUT/DELETE /api/ssh-resources[/:id]` | 仅归属人/admin；归属人由服务端权威写入，不接受客户端传入 |
| `POST /api/ssh-resources/:id/exec|test` | 归属人/admin/项目绑定成员可用 |
| `GET /api/agents[/:id]` | 非归属人只见脱敏视图（无 apiKey / 提示词）；不可见者 404 |
| `POST/DELETE /api/agents[/:id]` | 仅归属人/admin；新建时的「同名 + 同节点」复用路径同样过归属判定（不得复用他人资产，且复用不转移归属） |
| `GET /api/teams[/:id]` | 专家团按「公共花名册」全员可见（仅 `coordinatorPrompt` 对非归属人脱敏）；改删仅归属人/admin |
| `GET/PATCH /api/projects/:id` | 项目可见性与 owner 判定统一改走 `perm.ts` 的 `canAccessProject` |
| `POST /api/projects/:id/invitations` | owner/admin；开启 `allowMemberInvite` 后普通 member 亦可邀请（邀请列表与重发/撤销仍限 owner/admin） |

**存量口径（2026-11-02 修正）**

> 线上事故教训：存量实体（`ownerUserId` 缺省，归属不可追溯）若对全员开放写面，等于「谁都能改/删」。
> 故统一为「**读面全员、写面仅 admin**」；且**归属只在新建时写入** —— 更新既有实体保持原归属，
> 不得因管理员编辑一次就把共享存量资产静默变成其个人私有资产。
> 详见 `docs/qa-aliyun-permission-20261102.md`（含被误删智能体的恢复取证与回归结果）。

**已实现的 `visibility: 'shared'` 语义（细化 §10.3）**

- `private`（缺省）：仅归属人 / admin / 项目绑定成员可见可用。
- `shared`：额外对全部登录用户**只读可见**（列表摘要），但**不可使用、不可取明文、不可改删**。
- 「使用」永远只经项目绑定 —— 与 §10.3「共享不走全局公开」一致。

**验证**

| 命令 | 覆盖 |
|---|---|
| `npm run typecheck` | 类型检查 |
| `npm run test:unit` | 176 项（含 `src/perm.test.ts` 13 项权限单测） |
| `npm run smoke` | 91 项平台冒烟（SSH 资源脱敏/明文回读等） |
| `npm run smoke:users` | 86 项用户与项目成员冒烟 |
| `npm run smoke:perm` | 43 项归属与项目绑定共享端到端（`scripts/perm-owner-e2e.mjs`，含存量无归属实体的改删回归） |

**遗留（下一阶段）**

- 任务 / 工作区文件 / 定时任务「跟随项目或智能体可见性」的统一收口（§10.5）。
- 审计扩展：资源/智能体改删、admin 穿透进入项目落 audit_log（§10.6 第 5 项）。
- `DshRefACL` 节点级授权（§10.3 ②，YAGNI 未做）。
- 工具通道（HTTP `/api/tools` 与 MCP）按服务端级受信通道处理，不做逐用户资源过滤；如需收紧需引入「令牌绑定用户」。

## 11. 全站权限矩阵（§10 的全模块收口，2026-11-03 定稿并落地）

### 11.1 决策记录（已拍板）

1. **新建任务（未绑定项目）仅创建者可见**；团队协作走"绑定项目"路径（项目成员可见可聊）。
2. **存量无归属数据**（老任务/老定时任务/老专家条目/老库条目）：沿用 §10.7 事故先例——看可用全员、管理（改名/删除/归档/启停/手动 run）仅管理员。
3. **监控大屏与全局 Token 用量仅管理员**；任务内单任务 Token 明细（S2-1）随任务可见性，普通用户不受影响。
4. **技能/插件库**：人人可上传（条目归属上传者），删除与共享基址设置仅归属人+admin。

### 11.2 权限矩阵（可视 / 可操作）

图例：owner=归属人；admin=平台管理员；「缺省」=存量/AI 工具通道创建的无归属数据（宽容模式）。

| 模块 | 可视 | 可操作 |
|---|---|---|
| 任务 | owner ∪ admin ∪（绑定项目且项目隔离时的项目成员）；缺省=全员 | 查看/聊天/SSE/消息/附件/goal-plan-compact/subtasks/stats/取消生成（cancel）/fork：view 级（fork 新任务归 fork 人）；改名/删除/归档/bulk-archive/编辑成员/session-model·preset/task model/permission 配置/queue：manage 级（owner ∪ admin，缺省=仅 admin） |
| 项目 | 不变（§10.2 成员可见 + 404 防枚举） | 不变（owner 管理面 + allowMemberInvite） |
| 待办 Backlog | 不变（canSeeProject + 归档只读） | 成员可写；dispatch 创建任务归属派发人 |
| 子智能体 | 不变（§10.4） | 补口：skills 读路径 `canViewAgent`；bindings POST / skills upload·delete 补 `canManageAgent`；**prompt-preview 收紧为 manage 级**（返回提示词原文；不可见 404 防枚举） |
| 资源目录 | ONENAT 平台目录全局只读不变；SSH 资源池不变 | 不变 |
| 技能/插件库 | 列表/下载/安装全员 | 上传/导入创建归属上传者；删除 owner∪admin（缺省=admin）；`/api/library/settings` 仅 admin |
| 语音助手 | 仅 admin（导航隐藏，深链接拉回工作台） | status/endpoints 增删全 admin |
| 定时任务 | owner ∪ admin；缺省=全员 | 编辑/删除/toggle/**run**（派生任务耗资源归 manage 级）：owner ∪ admin，缺省=仅 admin；不可见统一 404 防枚举；派生任务继承定时任务归属 |
| 文件管理 | 节点工作区为团队共享盘，保持登录门禁（`/api/agents/fs/*` 不做逐用户 ACL，见遗留） | `/api/tasks/:id/files/download` 随任务 view 级 |
| 专家管理 | 花名册/召唤/@发任务全员（公共名册不变） | 用户专家条目（source=user）编辑/删除：owner∪admin（缺省=admin，内置=admin）；归属只在创建时写入，编辑不夺归属 |
| 归档 | 列表=归档任务过 `canViewTask` 者（自动跟随任务可见性） | 恢复/删除逐条 `canManageTask`（bulk 逐条过滤静默跳过）；自动归档天数配置随 settings 收 admin |
| 设置 | 非 admin 仅「当前账号」+「AI 接入」卡 | admin：GET/POST `/api/settings`（GET 对非 admin 返回裁剪版：无 aiToken、无 xiaozhi 段）、`ai-token/reset`、`/api/planner/config`（**带 taskId 的主智能体切换除外**——任务会话日常操作）、`/api/library/settings`、xiaozhi、用户管理、审计 |
| 监控 + Token 用量 | 仅 admin（`/api/monitor/*`、`/api/usage/tokens/*`；`records?taskId=` 随任务可见性例外） | 同左 |
| mentions/candidates | 按可见性过滤（项目 `canSeeProject`、智能体 `canViewAgent`、SSH `canViewResource`；团队/专家公共名册、ONENAT 目录不变） | — |
| 审计 | admin 不变 | 新增动作：task.delete/archive/bulk_delete、schedule.create/update/delete/toggle/run、settings.update、settings.ai-token.reset、agent.delete、ssh-resource.delete、library.delete、expert.create/delete |

**实现口径**：判定全部收口在 `src/perm.ts` 新增纯函数（`canViewTask/canManageTask/visibleTasks/canViewSchedule/canManageSchedule/canManageOwned`）；归属字段一律服务端权威写入（`engine.createTask` 增加 `ownerUserId` 入参，fork 归 fork 人、派发归派发人、定时派生任务继承定时归属；AI 工具通道无会话 → 缺省宽容，文档化为设计内行为）；前端镜像 `canManageTaskUi/canManageScheduleUi/canManageOwnedUi/isAdminUi`（`web-ui.ts`，me 未就绪按可管处理、服务端兜底），全部按钮按条件渲染 + 安全绑定（QA round2 的 `wireAgentCard` null 绑定教训）。

**与批准矩阵的实现差异（两处，安全属性不变）**：
1. `GET /api/settings` 对非 admin 返回裁剪 200 而非 403——`loadSettings()` 全页面启动即调用且普通用户需要 base 等非敏感字段；敏感下发面收敛相同（aiToken/xiaozhi 凭证仅 admin）。
2. `POST /api/planner/config` 按 body.taskId 分流而非一刀切 admin——带 taskId 是任务会话内主智能体切换（全员日常），不带才是设置页全局配置。
3. `POST /api/tasks/:id/cancel` 定为 view 级——前端「⏹ 停止生成」走该路由，属会话协作动作（停止当前轮 ≠ 删除任务），与发消息同权；批准矩阵的 manage 清单未含 cancel。

**验证**（2026-11-03 本地实测）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test:unit` | 184 项全绿（perm.test.ts 20 项，§11 新增 7 项） |
| `npm run smoke` | 91 项全绿（回归） |
| `npm run smoke:users` | 86 项全绿（回归） |
| `npm run smoke:perm` | 74 项全绿（§11 新增 31 项：全局面门禁 + 任务/定时任务归属矩阵） |
| `npm run smoke:schedules` | 59 项全绿（回归） |
| `npm run smoke:xiaozhi` | 32 项全绿（回归） |

**遗留（下一阶段）**

- 文件管理节点级 ACL（`DshRefACL`，§10.3 ② YAGNI 未做）——`/api/agents/fs/*` 仍为登录级共享盘。
- AI 工具通道「令牌绑定用户」（token→userId），绑定后工具通道可复用同一套 perm 判定；当前 AI 通道创建的任务/定时任务为无归属宽容模式。
- CSRF：全 JSON 响应 `Access-Control-Allow-Origin: *` + 无 Origin 校验，靠 SameSite=Lax 兜底；如收紧需加 Origin 白名单（写面）。
- `ssrf-guard.ts`（已存在未接线）：`/api/dsh-test` 可探测任意 apiBaseUrl，建议接线后再放开表单直连。
- 存量归属回填：不可追溯，维持宽容模式 + 管理员可手动删除/移交；`/api/mentions/candidates` 的团队条目未脱敏 coordinatorPrompt（GET /api/teams 已脱敏，候选卡不带提示词字段）。
