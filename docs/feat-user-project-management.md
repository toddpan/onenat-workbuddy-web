# 用户管理与项目管理（Phase 1 MVP）实现说明

- 日期：2026-10-19
- 依据：docs/design-user-project-management.md + docs/review-user-project-management.md（推荐方案：方案 A 扩展现有 Project + 扩展 auth.json + 零依赖手动邀请链接）
- 状态：已实现并通过验证（typecheck / 52 项单测 / 51 项平台 smoke / 42 项用户管理 smoke / 163 SMTP 真实发信验收）

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

- 单测 src/auth.test.ts（6 例）：迁移、邀请激活全流程、token 状态机、邮箱唯一、admin 保护、过期拒绝
- 单测 src/mail.test.ts（5 例）：.env 解析、SMTP 配置读取、开发模式 mock、假 SMTP 服务器全流程真发、认证失败不重试
- 端到端 scripts/smoke-users.mjs（42 项，内置假 SMTP 服务器验证邀请邮件真发链路）→ npm run smoke:users
- 平台回归 scripts/smoke-standalone.mjs（51 项）→ npm run smoke
- 真实发信验收：smtp.163.com:465（.env 配置）自检邮件 + 管理端邀请 API 真发均成功

## 已知边界 / Phase 2 待办

- 项目邀请邮件（P-04/P-05/P-09）、忘记密码/重置邮件（U-07）留待 Phase 2（SMTP 基础设施已就绪，mail.ts 可直接复用）
- invited 用户的邀请在用户被删除时自动 revoked；过期令牌在 >800 条时惰性瘦身
- 审计日志（audit_log）与 GDPR 物理删除未包含（Phase 3）
