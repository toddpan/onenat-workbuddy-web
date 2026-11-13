# AI 能力与操作契约 2026-11-08.1

首次接入调用 `workbuddy_capabilities {}`。能力摘要返回服务版本、契约版本、操作知识版本、身份类型、每个 action 的允许上限与风险，以及当前通道的等待和文件限制。`allowed=true` 只描述 action 上限；对象可见性、归属、工作区路径和运行时校验仍可能拒绝。发现响应不包含账号、密钥、SSH 凭据或节点直传配方。

## 发现操作知识

MCP `resources/list` 列出 `workbuddy://contracts/2026-11-08.1/{tasks,large-files,questions,security}`；使用 `resources/read {uri}` 获取正文。HTTP 工具和旧 MCP 宿主可调用 `workbuddy_capabilities {resource:uri}` 取得相同内容。资源 URI 带版本；服务行为变更时应同时更新契约与资源版本，并更新两份技能的 `service-contract` 声明。服务不能验证外部安装技能的实际版本，因此能力摘要中的 `installedSkillVersion` 为 null。

资源分别描述任务草稿/启动/轮询、草稿→直传→登记→发送、大模型提问恢复，以及权限和输出约定。`prompts/list` 保持空集，操作知识统一由 resources 与等价工具发现。

## 输出

所有 17 个工具在 HTTP 发现、标准 MCP 与小智工具发现中提供 `outputSchema` 和 annotations。MCP 返回：

```json
{"content":[{"type":"text","text":"{\"ok\":true,...}"}],"structuredContent":{"contractVersion":"2026-11-08.1","ok":true,"data":{"ok":true}},"isError":false}
```

`data` 是既有 JSON 工具结果，保留 action 各自字段；外层版本、布尔成功标志、对象数据为可验证的稳定结构。JSON 文本仍可供旧客户端解析。HTTP 保留 `{ok,tool,result}`，增加同形 `structuredContent`。业务失败检查 `result.ok` / `structuredContent.ok` / MCP `isError`，HTTP 200 只代表工具通道已应答。64KiB MCP 限制计算完整双格式结果，避免新增结构化字段使帧超限。

混合 manage 工具的 `readOnlyHint=false`，有删除/任意命令分支的工具标为 destructive；task_chat 追问、task_evaluate、状态 full 导出凭据均按有副作用处理。action 风险可在能力发现中逐项读取。annotations 是客户端提示，授权由服务端执行。

## 只读体验凭证

运维在启动环境设置独立随机值 `WORKBUDDY_READONLY_TOKEN`，通过通常的 Bearer / X-WorkBuddy-Token 方式调用。该值必须不同于普通 AI 令牌；若相同服务拒绝启动。它不落入普通 AI 令牌存储，不授予新增 AI 权限。环境移除或替换后重启即可撤销。请使用至少 32 字节随机值。

该凭证只允许 `/api/tools` 与 `/mcp` 路径。每次执行和 MCP 缓存回放均依据服务端上下文检查策略，工具参数中的 `readOnly`、`session` 或 `aiTokenOnly` 不参与鉴权。只读身份优先于同时携带的登录 cookie，缓存键包含只读策略，避免读取普通身份缓存的写操作结果。

只读白名单允许存储信息与任务结果读取、任务 preflight/wait，以及现有文件读取权限内的 list/download。拒绝任务创建/发言/追问/评估、提问答复、SSH 明文/执行/测试、资源刷新或探活、上传、配置/待办/计划变更；task_status full 可能签发导出凭证，亦拒绝。普通 AI 令牌原有写范围保留，SSH get/exec 仍禁止；控制台 SSH 操作额外按既有资源 ACL 校验。

此策略保证体验调用不能发起业务写操作或远端智能体执行；它不是远端执行沙箱，也不保证查询不产生日志、鉴权会话或后台监控更新。需要远端只读执行时应另行部署文件系统/命令/网络权限沙箱并独立验收，不能用“不写文件”的自然语言替代权限。

## 验证边界

`node scripts/capabilities-e2e.mjs` 使用隔离数据目录和 mock ONENAT 检查发现、双格式输出、资源版本、只读越权、REST 旁路、伪造上下文和跨策略缓存。纯策略测试覆盖所有 action 的已知/未知边界。构建与现有 smoke 仍是交付检查。

发现负载测量：当前 17 个工具仅输入定义为 39,514 UTF-8 字节，包含输出契约与 annotations 为 47,103 字节，新增 7,589 字节；这是传输体积度量，实际提示词 token 数取决于宿主使用的 tokenizer。操作全文延迟到资源读取，避免每次 tools/list 加载。

这些测试不代表真实大文件直传、挂起提问恢复、SSH 命令或多智能体编排已端到端验收；本轮测试验证相关入口被只读策略拒绝，以及操作文档与实际工具行为一致。
