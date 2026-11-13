# 工具参数契约（task-82）

16 个 WorkBuddy 工具使用同一份结构化输入契约。发现参数时优先读取 `inputSchema`：HTTP `GET /api/tools` 的每个工具条目与原生 MCP `tools/list` 暴露相同的 JSON Schema；旧 `parameters` 字段继续保留，供已有客户端展示描述。HTTP `POST /api/tools/:name`、原生 MCP `tools/call` 与 `skills/workbuddy-mcp/scripts/wbmcp.sh call` 在进入业务前执行同一套归一化和校验。

Schema 明确区分 object、array、string、boolean、number 等类型，并提供复杂对象的 `properties`、数组的 `items`、枚举与嵌套 `required`。每一层 `required` 中的字段都必须存在于该层 `properties`。`memberAgentIds`、`answers`、`itemIds` 是数组，不再以模糊的 object 替代。推荐直接传 JSON 原生数组与对象：

```json
{"action":"create","title":"先上传附件的草稿","memberAgentIds":[]}
```

这个 create 没有 `message`，只建立 draft，不启动执行；显式空成员数组保持为空。为兼容旧客户端，结构化参数仍接受内容为合法 JSON 的字符串，例如 `"itemIds":"[\"TASK-1\"]"`；解析后按相同结构校验，错误的数组或对象不会绕过校验。部分已有字符串列表参数也继续兼容其历史字符串形式。

`workbuddy_task_status`、`workbuddy_task_chat`、`workbuddy_task_evaluate`、`workbuddy_task_ask_answer` 没有 `action` 属性，也不要求 `action`。status 允许 `{}`，返回任务概览；提供 `taskId` 可查询单任务。其余三个工具各自保留所需的任务、成员或答复字段。其余 12 个工具在 schema 声明必填 `action` 并列出合法值；运行时保留原有省略 action 的默认行为。显式未知 action 返回字段错误。

分支必填在运行时校验，例如 task send 要求 `taskId` 与 `message`，backlog dispatch 要求项目及 `itemId` 或非空 `itemIds`，mapping 节点引用要求 `mappingId`，答复数组的每一项要求 `id`。这些检查只负责参数结构；项目/任务是否存在、权限和当前状态继续由业务层判断。查询不存在的项目可以返回业务 `NOT_FOUND`，这表示参数已经通过检查。

字段错误的工具结果为：

```json
{
  "ok": false,
  "code": "INVALID_PARAMS",
  "error": "answers[0].id: 必填字段",
  "errors": [{"path":"answers[0].id","message":"必填字段"}]
}
```

未知参数以 `paramWarnings: string[]` 提醒并忽略，不导致原本合法的调用失败；warning 不回显字段值。嵌套字段同样适用。客户端应修正拼写，并依据当前 action 的说明传参。

HTTP 成功传递工具调用时返回 HTTP 200 及 `{ok:true,tool,result}`；上述业务或参数错误位于 `result` 中，不能仅检查外层 `ok`。MCP 将同一工具 JSON 放在 `result.content[0].text`，并以 `result.isError` 标记工具失败。bash 客户端把解包后的工具 JSON 写到 stdout，工具失败时返回非零退出码；因此测试需分别核对传输和工具结果。

发现信息体积实测：使用相同的当前工具名称与描述，将旧转换器与结构化契约分别序列化为 MCP 工具列表，UTF-8 大小由 24,161 字节增加到 37,742 字节（约 +56%）。增加部分来自嵌套字段、枚举与约束；这是字节测量，未将其冒充特定模型的首轮 token 数。分支必填保留在运行时，顶层使用兼容的 object/properties/required 结构，避免展开多套根级联合 Schema。

验证结果：`typecheck`、`build` 通过；常规 smoke 93 项、三通道 MCP smoke 146 项、小智 MCP smoke 34 项通过。三通道样例验证参数能够到达业务层；答复成功路径另以无网络 mock 单测验证原生数组和旧 JSON 字符串均原样送达答复客户端。

回归命令（从仓库根目录执行）：

```bash
npm run build
npm run smoke:mcp
```

冒烟服务使用临时 `WORKBUDDY_HOME`、本地 mock ONENAT，bash 客户端另用临时 `TMPDIR` 隔离 session 缓存。相同样例逐一经过 HTTP、原生 MCP 和实际 bash 脚本，覆盖 draft create、status、原生/legacy 数组、字段错误和 warnings。合法 ask_answer 停在 draft 无挂起提问的本地业务错误；dispatch 使用不存在项目并断言 `NOT_FOUND`；最后确认只有一个未运行的 draft，避免真实外部副作用。
