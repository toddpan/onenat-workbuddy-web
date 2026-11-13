---
id: task-96
title: '[P1] MCP 会话过期后无法自愈：initialize 被旧 session id 卡死，原生宿主永久失效'
status: Done
assignee:
created_date: '2026-11-12T02:02:04Z'
updated_date: '2026-11-12T02:35:00Z'
labels:
  - mcp
  - reliability
  - ai-access
  - backend
dependencies:
priority: P1
ordinal: 96000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
现象（2026-11-12 实测，安装 MCP 后若干分钟）：原生 MCP 宿主连续两次 tools/call 均返回「未知或已过期的 MCP 会话，请重新 initialize」，重试无效、只能卸载重装。用户直觉是「KEY 过期了」，但根因不是密钥。

【诊断结论】
1) AI 令牌不过期：src/auth.ts:102-163，wbk- 令牌落盘 data/ai-token.json，仅在显式「重置令牌」时轮换，无 TTL。所以「装完过一阵失效」与密钥无关。
2) 真正过期的是 MCP 会话：src/mcp-server.ts:55 SESSION_TTL_MS = 30 分钟（按 lastAt 空闲回收，:412 pruneSessions），且会话只在内存（:400-408 超过 SESSION_MAX=200 按 LRU 踢最旧），服务进程重启即全灭。
3) 致命死锁点 src/mcp-server.ts:233-238：携带已失效 Mcp-Session-Id 的 initialize 请求被直接回 SESSION_EXPIRED 拒绝。客户端「重新握手」这一步永远失败——只要它手里的旧 id 不丢，就永远过不去。
4) 自愈提示是错的：src/mcp-server.ts:35 给 recovery: { kind: call, tool: initialize }，但 initialize 是 JSON-RPC 方法不是工具，客户端照做必然再失败。
5) 通道不一致：scripts/wbmcp.sh:60-67 有「会话失效→重握手→重试一次」的兜底，所以 CLI 通道能自愈；原生 MCP 宿主（Claude Code 等）没有这层，命中即永久卡死。

【设计原则】会话过期必须对调用方透明，不该要求用户重装 MCP 或重开宿主。

方案：
A. initialize 容错：收到未知/已失效 session id 时不再报错，直接签发新会话并在 result 里回 sessionReset:true 与原 id 摘要，让客户端知道「换了个会话但握手成功」。
B. 非 initialize 方法透明续期：mcp-server.ts:255-258 处遇到失效 id 时按需重建同质会话并继续处理；写操作同样放行——前提是幂等键从「会话 id」改为「调用者身份 + 工具名 + 参数摘要」（:302 的 replayKey 目前以 mcp:<sessionId> 为前缀，会话一换幂等窗口就断，这正是「重试造重复任务」的隐患来源）。
C. 会话元数据落盘：id/createdAt/lastAt 持久化到 data/mcp-sessions.json，进程重启后旧 id 仍可识别并按需复活，不再全灭；SESSION_MAX 提升为可配置项，淘汰时打日志便于事后定位。
D. 错误契约修正：SESSION_EXPIRED 的 recovery 改为形态正确且客户端可执行的下一次动作（重新 initialize / 原命令可安全重试），去掉不存在的 tool: initialize；若某写操作确实不可重放，必须带 taskCreated 标识，不能用 SESSION_EXPIRED 笼统表达。
E. 安装链路自检：安装完成后做一次「握手 → tools/list → ping」探针，把结果写进安装报告，让「装好了但用不了」在安装阶段就暴露，而不是等到第一次派活。

影响面：src/mcp-server.ts 的 dispatch/handleToolCall/会话表；scripts/wbmcp.sh 的握手与重试语义需与 A/B 对齐（避免两边各写一套）；不改 AI 令牌有效期语义（令牌本就不该过期，但新增「是否可过期」应显式声明并在设置页可见）。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 携带已失效 Mcp-Session-Id 发起 initialize 时返回成功并签发新会话，不再返回 SESSION_EXPIRED
- [ ] #2 普通方法（tools/list 等）在会话失效时透明续期并正常返回结果，客户端无感知
- [ ] #3 服务进程重启后，重启前签发的旧 session id 不再一律失效（会话元数据落盘并可按需复活）
- [ ] #4 幂等键不再依赖会话 id：会话切换后重试同一 tools/call 不会产生重复任务（含 create 类写操作）
- [ ] #5 SESSION_EXPIRED 的 recovery 字段为客户端可真实执行的下一步动作，移除不存在的 tool: initialize
- [ ] #6 scripts/wbmcp.sh 的握手/重试语义与新服务端行为一致，不出现两套相互矛盾的兜底逻辑
- [ ] #7 安装流程结束后输出握手 + tools/list + ping 探针结果，失败时明确提示而非静默成功
<!-- AC:END -->

### 2026-11-12T02:03:13Z 派发为任务
task-031df1bf · mode=chat · 成员=0

### 2026-11-12T02:35:00Z 派发执行（成功）
任务 task-031df1bf · 结果=成功
我会按 task-96 的验收项修复服务端会话恢复、跨会话幂等和安装探针，并补上过期与重启场景的回归验证。先检查现有实现和项目约定；这次排查会使用 diagnosing-bugs 技能。已复现：携带旧 session id 的 initialize 返回 `SESSION_EXPIRED`，并把协议方法 `initialize` 错写成了工具恢复动作。

现有证据按可能性指向三处：一是握手校验旧 id，导致重新握手也被拒；二是会话表只在内存，重启或淘汰后旧 id 无法恢复；三是回放键包含 session id，换会话后同一写调用可能再次执行。接下来分别用旧 id 握手、重建服务实例和跨会话重试来验证。服务端修复已进入实现：普通请求会保留原 session id 并按需恢复，initialize 会成功签发新 id。写调用的回放键将使用调用者身份、工具名和规范化参数摘要，同时合并并发重试，避免两个相同请求都在首个结果缓存前执行。

安装脚本与 CLI 由另一位成员并行处理，验证会记录 initialize、tools/list、ping 各自的实际结果。会话恢复的 5 组定向回归已通过，
