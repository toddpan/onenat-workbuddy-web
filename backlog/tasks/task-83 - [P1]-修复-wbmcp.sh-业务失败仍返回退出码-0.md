---
id: task-83
title: '[P1] 修复 wbmcp.sh 业务失败仍返回退出码 0'
status: Done
assignee:
created_date: '2026-11-08T11:40:42Z'
updated_date: '2026-11-08T12:54:02Z'
labels:
  - ai-ux-20261108
  - mcp
  - bug
  - reliability
  - cli
dependencies:
priority: P1
ordinal: 83000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
来源：2026-11-08 AI 工具调用体验，关联体验任务 task-cafa75a0；已核对现有 65 条 backlog，无同范围条目。

实测：执行 wbmcp.sh call workbuddy_task_manage '{"action":"invalid_readonly_probe"}'，MCP 响应 isError=true，业务 JSON 为 ok:false，但脚本退出码仍为 0；stderr 仅打印 isError: True，自动化调用方可能误判成功。

定位：skills/workbuddy-mcp/scripts/wbmcp.sh 的 call 分支及 post/call_json。修复业务错误、RPC 错误和传输错误的退出语义；stdout 保留机器可读业务结果，诊断输出放 stderr。检查 curl 状态及响应解析，不将失败伪装为成功。重试仅针对可安全重试的情况，不能因客户端恢复逻辑重复执行写操作。

范围：脚本可靠性及测试；通用业务错误字段另列待办。第一批实施，与 Schema 修复优先落地。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 合法工具调用退出码为 0；ok:false、MCP isError:true、RPC error 均返回非零退出码。
- [ ] #2 覆盖 HTTP 非成功状态、超时、非 JSON 响应及损坏 SSE/JSON 的失败路径，错误不会被静默吞掉。
- [ ] #3 stdout 保持可解析的结果，stderr 承载诊断，不输出令牌或节点凭据。
- [ ] #4 补自动化回归，包含本次 invalid_readonly_probe 复现及正常工具调用。
- [ ] #5 会话过期恢复或网络重试不造成重复 create/send/dispatch 等写操作。
<!-- AC:END -->

### 2026-11-08T12:46:19Z 派发为任务
task-5965a976 · mode=chat · 成员=0

### 2026-11-08T12:54:02Z 派发执行（成功）
任务 task-5965a976 · 结果=成功
我会先检查脚本的错误处理与会话恢复路径，补上可复现的自动化回归，再完成修复并运行构建、类型检查和 smoke。此次按 `diagnosing-bugs` 技能定位问题，重点验证失败退出码、stdout/stderr 分离，以及写操作不会被自动重放。
工作区已有其他未提交改动，我会将本次修改限定在客户端脚本和新增回归测试。服务端目前用 RPC `-32001` 表示会话过期；客户端的恢复逻辑需要覆盖这一实际行为。为避免重复写入，本次将采用保守策略：失败请求不自动重放，清除会话缓存后，由下一次显式调用重新握手。
最小回归已复现：`invalid_readonly_probe` 返回 `ok:false`、`isError:true` 时，旧脚本退出码为 0，测试明确失败。

接下来按三项假设验证：一是 `call` 只打印业务错误、未设置退出码；二是 `post` 固定返回 0，掩盖传输失败；三是空响应或宽泛的 `-32` 匹配触发重放，可能重复执行写操作。回归会分别断言这些路径的退出码和请求次数。
核心修复已完成，首轮黑盒回归 33 项通过，覆盖了错误退出码、超时、JSON/SSE 解析
