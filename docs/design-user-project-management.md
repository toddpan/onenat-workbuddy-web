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
