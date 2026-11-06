---
id: task-54
title: 'task_status detail:full 超大任务返回聊天内容下载 URL（>32KB 追加 downloadUrl）'
status: Done
assignee:
created_date: '2026-11-06T00:34:51Z'
updated_date: '2026-11-06T00:41:53Z'
labels:
  - mcp
  - ai-access
  - reliability
  - backlog
dependencies:
priority: High
ordinal: 54000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
现状验证：MCP 通道单帧上限 MAX_RESULT_BYTES=64KB（src/xiaozhi-mcp.ts L40），task_status {detail:"full"}（src/tool-ops.ts L547-548）序列化整个任务对象含全部 turns+日志，超 64KB 时被 mcp-server.ts L311-322 替换成「结果过大」错误，调用方完全拿不到内容。
方案已验证可行：① 服务端已有带 token 的下载端点先例（/library/file/:kind/:id?token=，requestPublicBase 已处理反代 x-forwarded-host，外网经 ONENAT 隧道可达）；② 新增只读 REST 端点 GET /api/tasks/:id/chat-export（支持 format=json|markdown，AI 令牌或短期 downloadToken 鉴权），返回完整任务聊天内容。
实现：task_status detail:full 序列化前先量字节数，>32KB 时不直接回全文，改为返回摘要（id/title/status/turns/summary 预览）+ chatDownloadUrl（requestPublicBase 拼绝对地址 + 一次性/短期 token，TTL 建议 10 分钟）+ nextAction 提示调用方下载；MCP 通道「结果过大」兜底 hint 同步指向该下载端点。补单测（小任务仍回全文 / >32KB 任务回 URL / 下载端点鉴权与 404 / token 过期）。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 task_status detail:full 结果 >32KB 时返回摘要+chatDownloadUrl 而非全文
- [ ] #2 新增 GET /api/tasks/:id/chat-export 端点（json/markdown，token 鉴权，未授权 401/过期失效）
- [ ] #3 ≤32KB 时行为向后兼容不变
- [ ] #4 单测覆盖阈值分支与下载端点，npm run typecheck 与 npm run smoke 通过
<!-- AC:END -->
