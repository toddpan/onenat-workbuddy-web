# 用户管理与项目管理实现说明（Phase 1 + Phase 2 完整交付）

- 日期：2026-10-19（Phase 2 同日补齐）
- 依据：docs/design-user-project-management.md + docs/review-user-project-management.md（方案 A：扩展现有 Project + 扩展 auth.json + 统一令牌表）
- 状态：**设计文档功能全集已实现**并通过验证（typecheck / 56 项单测 / 51 项平台 smoke / 86 项用户管理 smoke / 163 SMTP 真实发信验收）

## Phase 2 功能（本轮补齐）

| 设计项 | 实现 |
|---|---|
| U-04 撤销邀请 | `POST /users/:id/revoke-invite`（pending 置 revoked，用户保持 invited 可重发） |
| U-07 忘记密码/重置 | `POST /auth/forgot-password`（公开，恒 202 防枚举，24h token）+ `POST /auth/reset-password` + `/reset` 接受页 + 登录页入口；重置后吊销全部会话 |
| U-08 用户过滤 | `GET /users?status=&role=&q=` |
| U-12 个人资料 | `PUT /users/me/profile`（昵称）；控制台「当前账号」卡（昵称+改密；改邮箱需验证机制，暂不开放） |
| P-02 scope 视图 | `GET /projects?scope=owned\|joined\|all(admin)` |
| P-04/05/09 项目邮件邀请 | 统一令牌表 type=project_invite（7 天）：`GET/POST /projects/:id/invitations` + `/:invId/resend|revoke`（owner）；公开 `GET/POST /project-invitations/:token`（+ `/decline`）；接受语义按账号状态分流——未注册=一步注册入项、invited=激活入项（均自动登录）、active=须本人登录态接受（401/403 分级）、disabled=拒绝；`/project-invite` 接受页 |
| P-06 成员改角色 | `PUT /projects/:id/members/:userId {role}`（保留至少 1 owner） |
| P-07 owner 转让 | `POST /projects/:id/ownership-transfer`（目标升 owner，请求者成员身份则同步降 member） |
| P-08 归档/恢复 | `POST /projects/:id/archive|restore`；归档=只读（编辑/加人/邀请/发任务全部拒绝，前端抽屉含归档按钮） |
| B-03 审计日志 | `src/audit.ts`：dataDir/audit-log.json（留 1000 条），邀请/入项/角色/禁用/归档/转让/重置等关键动作全落库；`GET /api/audit-log`（admin）+ 设置页审计卡 |
| B-04 限流 | `RateLimiter`（mail.ts）：IP+动作+目标邮箱 5 次/小时，覆盖用户邀请/重发/项目邀请/重发/忘记密码 |

## 实现范围（对照评审 Phase 1）

| 能力 | 状态 |
|---|---|
| AuthUser 增加 id/displayName/role/status，会话存 userId | ✅ |
| 旧版 auth.json 自动迁移（存量账号 → active 管理员，行为不变） | ✅ |
| 管理员邀请用户（invited 态）→ 一次性链接（72h）→ 设置密码激活并自动登录 | ✅ |
| 邮件未配置：控制台「复制邀请链接」手动发送（零依赖） | ✅ |
| SMTP 邮件发送（B-01）：零依赖客户端 + .env 配置 + 邀请自动发信 + mail_log | ✅（本轮补齐，见下） |
| 用户列表 / 重发邀请 / 禁用启用 / 角色变更 / 软删除（管理员） | ✅ |
| Project 增加 owner/projectMembers/visibility；创建者自动成为 owner | ✅ |
| 成员隔离 + 防枚举（非成员 404）；存量无 owner 项目宽容模式（所有人可见） | ✅ |
| 项目成员管理：添加已激活用户 / 移除 / 自行退出 / 最后 owner 保护 | ✅ |
| 登录支持邮箱（大小写不敏感）；invited/disabled/deleted 不可登录 | ✅ |
| 密码策略：激活须 ≥8 位且含字母+数字；改密沿用 ≥6 位 | ✅ |

## SMTP 邮件发送（src/mail.ts，零依赖）

- **配置**：环境变量 / `.env`（启动时自动加载，不覆盖已有环境变量）：`SMTP_HOST` / `SMTP_PORT`（默认 465）/ `SMTP_SECURE`（默认 true=SSL）/ `SMTP_USER` / `SMTP_PASS`（授权码）/ `SMTP_FROM_NAME`；支持 `WORKBUDDY_ENV_FILE` 显式指定路径，`.env` 已加入 .gitignore。
- **协议**：node:tls/net 手写 SMTP 客户端（EHLO → 明文端口自动 STARTTLS 升级 → AUTH LOGIN → MAIL/RCPT/DATA）；正文 base64 传输编码 + RFC 2047 主题/发件名；失败指数退避重试（默认 3 次，认证失败不重试）。
- **开发模式**：未配置 SMTP 时邮件内容写日志与 mail-log（status=mock），接口仍返回 inviteLink，不阻塞业务。
- **接线**：`POST /api/users` 与 `POST /api/users/:id/resend-invite` 自动发邀请邮件，响应含 `email: {sent, status, error}`；失败不阻塞创建，UI 弹窗展示发送结果并始终可复制链接手动发送。
- **管理端**：`GET /api/users/mail-status`（admin）返回配置概要与最近 10 条发送记录；设置页用户管理卡展示 SMTP 配置状态。
- **审计落盘**：`{dataDir}/mail-log.json`（保留最近 200 条：type/to/subject/status/error/attempts/createdAt）。
- **运维自检**：`node scripts/smoke-mail-real.mjs [收件邮箱]` 真发一封验证邮件（缺省发给自己）。

## 关键设计

- **统一令牌表**：auth.json 内 invites[]（type: user_invite/password_reset），只存 sha256 哈希；accept 原子置 used（内存 Set 防双击 + 落盘）。
- **兼容性**：Project.projectMembers 为可选字段；无 owner 且无成员的项目不启用隔离（宽容模式），存量数据零迁移成本。管理员认领后即进入隔离。
- **防枚举**：非成员访问隔离项目详情/成员接口一律 404。
- **admin 保护**：至少保留 1 名 active 管理员（降级/禁用/删除均校验）；禁用立即吊销全部会话。
- **项目邀请邮件（Phase 2）与 SMTP 未包含**：成员添加走「选择已激活用户」，无邮件依赖。

## REST API（前缀 {prefix}/api）

公开：
- GET  /invitations/:token —— 邀请回显（不消耗）
- POST /invitations/:token —— {password, displayName?} 激活并签发会话 Cookie
- GET  /invite?token=… —— 邀请接受页（移动端适配）

管理员（role=admin）：
- GET/POST /users；POST /users/:id/resend-invite|disable|enable；PUT /users/:id（role/displayName）；DELETE /users/:id（软删除）
- POST /users 响应含 inviteLink（{base}/invite?token=…）

登录用户：
- GET /auth/me（含 userId/role）
- GET /users/lookup?q= —— 添加项目成员用的用户搜索（最小字段）
- 项目成员：GET/POST /projects/:id/members、DELETE /projects/:id/members/:userId（owner 或本人=退出）

项目权限：
- 列表/详情按隔离过滤；PUT(PATCH)/DELETE 隔离项目需 owner 或平台 admin

## 测试

- 单测 src/auth.test.ts（10 例）：Phase 1 全套 + 撤销邀请、密码重置全流程、项目邀请状态机（创建/回显/拒绝/撤销/重发/重复）、接受分流（未注册/invited/active 会话校验/禁用）
- 单测 src/mail.test.ts（5 例）：.env 解析、SMTP 配置读取、开发模式 mock、假 SMTP 服务器全流程真发、认证失败不重试
- 端到端 scripts/smoke-users.mjs（86 项，内置假 SMTP 服务器）：Phase 1 全部 + 过滤/资料/重置（邮件报文解码链接）/项目邮件邀请全流程（一步注册入项、登录后接受、重复/已成员 409、撤销/重发令牌轮换）/角色变更/转让/归档恢复/归档发任务拒绝/scope 视图/审计日志/限流 429 → npm run smoke:users
- 平台回归 scripts/smoke-standalone.mjs（51 项）→ npm run smoke
- 真实发信验收：smtp.163.com:465（.env 配置）自检邮件 + 管理端邀请 API 真发均成功

## 已知边界 / Phase 3 待办

- 改邮箱（需邮箱验证机制）、GDPR 物理删除/数据导出（`DELETE /users/:id?permanent=true`）未做（设计 P2/Phase 3）
- 邮件发送为同步等待（≤2 次尝试 ×8s 超时），极端网络下邀请接口最长约 17s
- invited 用户的邀请在用户被删除时自动 revoked；过期令牌在 >800 条时惰性瘦身
