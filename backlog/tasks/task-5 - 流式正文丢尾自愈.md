---
id: TASK-5
title: "流式正文丢尾自愈（多步回合收尾按会话历史复核）"
status: "Done"
assignee:
created_date: '2026-11-01T00:30:00Z'
updated_date: '2026-11-01T00:30:00Z'
labels:
  - "engine"
  - "reliability"
dependencies:
priority: "high"
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
现象（2026-11-01 08:00 复现）：长回合（25 次工具调用）在 App/控制台的最后一条回答只剩前半段，尾部（markdown 表格 + 后续段落，约 1300 字）消失；DSH 会话事件库中该轮 assistant 文本完整（seq228 236 字 + seq274 1380 字），说明丢失发生在 workbuddy 侧回合文本，而非客户端渲染。

根因：dispatchWithFallback 只要「收到 turn_end 且存在文本」就直接采用 SSE 累积文本，永不做历史核对；长回合末段 assistant/message 差量一旦未送达（隧道抖动/网关截断），回合文本永久停在半截，且 complete=true 使原有对账兜底不触发。

修复：新增 verifyStreamTail —— 多步回合（本回合出现过工具调用）流式正常收尾后再做一次单次 history 对账，仅当「历史文本以流式文本为真前缀且更长」（纯尾部丢失）才采纳历史版本并打 warn 日志「流式正文疑似丢尾（N → M 字）」；单步短回答不额外请求，对账 attempts=1 不重试。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 多步回合 SSE 完整收尾但历史更长时，回合文本被历史全文覆盖（有单测）
- [x] #2 单步回合不发起额外历史请求（有单测，断言 reconcileCalls=0）
- [x] #3 只采纳「历史以流式文本为前缀且更长」的结果，避免串回合覆盖
- [x] #4 npm run typecheck / test:unit（99 项）/ build / smoke（70 项）全通过
- [x] #5 真实节点端到端回归：多步任务正文完整（1466 字，结尾标记齐全），未误触发补全
<!-- AC:END -->

### 2026-11-01 08:30 执行记录
- 改动：src/engine.ts 新增 verifyStreamTail + dispatchWithFallback 增加 verifyTail 选项（3 处 chat 派发调用点传入）；src/engine.test.ts 扩展 StubDshClient 并新增 2 条用例。
- 验证：typecheck ✅ / test:unit 99 ✅ / build ✅ / smoke 70 ✅ / mock ONENAT + 本机真实 DSH 节点端到端 ✅。
- 后续观测：部署到线上实例后，若日志出现「流式正文疑似丢尾」即真实触发并自愈；若仍截断且无该日志，则问题在 App 轮询收尾时机，需转向客户端排查。
