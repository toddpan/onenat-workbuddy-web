# 工具失败与恢复契约

HTTP `/onenat-workbuddy/api/tools/:name` 与 MCP `tools/call` 执行同一工具定义。HTTP 保留 `{ok:true,tool,result}` 传输信封，业务失败位于 `result.ok:false`；MCP 保留 text JSON 并设置 `isError:true`。不得解析中文 `error/message/nextAction` 判断错误类别。

失败统一字段：

| 字段 | 含义 |
| --- | --- |
| `ok:false` | 业务未成功 |
| `code` | 稳定具体错误码；参数错误统一 `INVALID_PARAM` |
| `category` | 分类，可统一处理既有 `TASK_NOT_FOUND`、`PROJECT_NOT_FOUND` 等具体 code |
| `message` | 人可读说明 |
| `error` | 兼容字段，与 message 相同 |
| `field` | 适用时为字段路径，例如 `projectId`、`schedule.rule.time` |
| `errors` | 参数校验失败的全部 `{path,message}` |
| `retryable` | 是否可自动重试本调用；写操作恒为 false |
| `retryAfterMs` | 可重试时的最小建议延时 |
| `recovery` | 机器可读下一步 |
| `paramWarnings` | 保留未知或不适用参数的告警 |

`category` 区分 `INVALID_PARAM`、`NOT_FOUND`、`PERMISSION_DENIED`、`AUTH_REQUIRED`、`SESSION_EXPIRED`、`NODE_OFFLINE` 和 `EXECUTION_FAILED`，以及冲突/状态等具体类别。分类由业务条件、远端 HTTP 状态或结构化 code 产生，不使用消息内容匹配。隐藏对象仍与不存在返回同样错误，只有调用方可见对象的权限不足才公开权限错误。

`recovery.kind`：

- `correct_parameters`：修改 `fields` 后再调用 `tool`；不回显原始参数或密钥。
- `poll`：等待 `delayMs` 后调用 `tool` 和 `arguments`。用于状态查询与可恢复只读错误。
- `call`：执行指定下一步，例如 backlog `retry-writeback`，或重新初始化 MCP 会话。
- `authenticate`：恢复鉴权/会话后再决定后续操作；不自动重放原写请求。
- `stop`：停止自动重试，需要检查状态或人工处理。

例如缺参返回：

```json
{"ok":false,"code":"INVALID_PARAM","category":"INVALID_PARAM","message":"projectId: 必填字段","error":"projectId: 必填字段","field":"projectId","errors":[{"path":"projectId","message":"必填字段"}],"retryable":false,"recovery":{"kind":"correct_parameters","tool":"workbuddy_project_manage","fields":["projectId"]}}
```

轮询、已接受、去重或仍运行的回执补充 recovery，指向 `workbuddy_task_status` 或不带 `followupMessage` 的 `workbuddy_task_chat`。现有 `nextAction` 继续供人阅读。

`taskCreated:true` 表示任务已创建，即使回写失败也不得再次 dispatch。必须保留 taskId，恢复指向 `retry-writeback` 或查询现有任务；`retryable:false`。MCP 超限回包也保留关键回执和只读恢复调用。精确/近似 create 去重、send 去重、RPC 回放和回放权限检查保持有效。

失败结果对凭据字段、Bearer 值、常见密钥前缀及 URL 凭据做脱敏；恢复参数只包含必要 ID/读取控制，不复制用户输入全文。未经处理的未知异常使用通用执行失败消息。JSON-RPC 保留协议数字 `error.code`，统一业务信息放入 `error.data`。

验证入口：`npm run test:unit`、`npm run smoke`、`npm run smoke:mcp`、`node --test scripts/tool-errors-http.test.mjs`。脚本退出码独立由 task-83 维护。
