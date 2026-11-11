# Task result reads (task-85)

`workbuddy_task_manage {action:"wait",taskId}`、`workbuddy_task_status {taskId,detail:"summary"|"full"}`、`workbuddy_task_chat {taskId}` 的已知任务响应共享顶层字段：`taskId/title/status/running/route/summary/lastReply/source/clipped`。没有路由记录时 `route:null`。summary/lastReply 为平台任务账本预览（800 字）；完整内容仍在 status full 的旧 `task` 字段。task-54 的 >32KB 下载 URL、令牌 TTL、requestBase 和原有字段继续保留；降级时 `clipped:true`。

`source` 指聊天消息列表的来源（status/wait 为平台账本）。`remote_history` 是绑定 DSH 会话的消息投影，`platform_ledger` 是平台实际接收并持久化的任务回复；后者不声称包含完整远端工具历史。chat 的 summary/lastReply 始终来自平台账本。`fallback.reason` 区分 remote_history_empty、remote_history_unavailable、remote_session_missing；附解释说明，不把空历史等同于消息丢失。远端失败且无该目标账本回复时返回 `ok:false/source:none`。合法空历史且账本也空时附 `emptyReason`。

省略 subtaskId 优先选择真实主会话绑定；没有主会话时，仅有一个目标可自动选择；多个目标返回 `CHAT_TARGET_REQUIRED` 和 `targets`，不自动挑成员。显式子任务使用子任务自己的 remoteSessionId 和 result，避免读取成员后来建立的会话。`__node__` 保持兼容。账本回退仅采用选中成员/子任务的回复，不借用其他成员文本。

chat 保留 returned/fetched/sessionId/agentId/messages，新增 `remoteHistory`（ok、returned、totalMessages、totalEvents、hasMore）。远端 hasMore、消息数量、正文或字节预算裁剪均使 clipped=true；默认从最新消息向前保留，再按时间顺序返回。full 仍最多向远端取 200 条，不承诺无限历史；hasMore 会明确暴露未取完。

## 复现与证据

最小样例：平台完成主会话且账本回复 WB_AI_UX_20261108_OK，绑定远端返回标准空 messages。旧 task_chat 仅 taskId 返回缺少 subtaskId；显式 __node__ 返回成功空数组，完全绕过账本。新测试 task-85 completed main task 在 HTTP/MCP 两上下文下检查默认目标、四种读取模式回复一致、来源与回退解释。

适配层另有可独立复现的缺陷：HTTP 返回 `{ok:true,data:{}}` 时，旧 getHistory 的 `: []` 将无效协议伪造成成功空历史。remote-history 测试已实跑红→绿；现返回协议错误，兼容合法 data.messages/旧数组，并保留事件计数和分页。合法 `messages:[],totalEvents:7` 与全零空会话分别测试。

本机安装的 dsh-web-service 实现核验显示标准 data.messages 已被原客户端支持；服务端事件读取异常可能回退 live snapshot，且只投影 user/message 与 assistant/message。不能据此认定 task-cafa75a0 的远端消息丢失或协议不匹配。该原任务绑定未在本轮取得；本机数据面鉴权返回 401。上述最小样例证实并修复了相同用户可见症状的读取路径，原任务的具体远端事件/绑定原因仍未证实。

## 回归

`npm run test:unit` 包含真实 loopback HTTP 的 remote-history.test 与 task-85 工具测试，覆盖协议缺字段、合法空会话、事件非空消息空、远端失败、目标歧义与隔离、子任务会话绑定、裁剪、跨调用上下文，以及 task-54 旧降级和 task-59 节点绑定/权限回归。`npm run build` 后运行 `npm run smoke` 与 `npm run smoke:mcp` 验证服务通道。
