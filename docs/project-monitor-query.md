# 项目发现与监控查询（task-87）

项目列表支持过滤、分页与摘要；监控概览支持按项目、部分和条数投影。HTTP 与工具通道各自调用共享的项目查询和监控查询模块，权限检查在过滤和计数之前执行。工具 `compact:false` 保留旧列表摘要（节点标题、专家、技能、连接器等），项目指令等详情使用 `get`；HTTP 完整记录继续包含指令。

## 项目列表

工具：`workbuddy_project_manage`，`action:"list"`。HTTP：`GET /onenat-workbuddy/api/projects`。

| 参数 | 语义 |
| --- | --- |
| `name` | 项目名称子串，不区分大小写 |
| `workspace` | 工作目录子串，不区分大小写 |
| `keyword` | 空白分词，每个词均须命中项目的 ID、名称、工作区、指令或技能 |
| `limit` | 工具默认 20，合法整数 1–200 |
| `offset` | 默认 0，非负安全整数 |
| `compact` | `true` 或 `false`，兼容工具字符串形式；默认 false |

三个过滤条件同时提供时取交集。先过滤、再分页，`total` 只计当前身份可见且匹配的项目。`compact:true` 每个项目只保留 `id/name/dshRef/defaultExecutionNodeRef/workspace/defaultAgentIds/taskCount`；不存在的可选执行节点字段遵循 JSON 的省略语义。

```json
{"action":"list","name":"Alpha","workspace":"/fixture/alpha","keyword":"project","limit":2,"offset":2,"compact":true}
```

```bash
curl -sS -H "Authorization: Bearer $WORKBUDDY_TOKEN" \
  "$WORKBUDDY_BASE_URL/api/projects?name=Alpha&compact=true&limit=2&offset=2"

bash skills/workbuddy-mcp/scripts/wbmcp.sh call workbuddy_project_manage \
  '{"action":"list","name":"Alpha","compact":true,"limit":2,"offset":2}'
```

工具业务结果包含 `ok:true`、`projects` 数组与顶层分页字段。HTTP 保留 `{ok:true,data:[...]}`，分页字段同样置于顶层：

```json
{"ok":true,"data":[],"total":0,"offset":0,"limit":20,"returnedCount":0,"hasMore":false,"nextOffset":null,"truncated":false}
```

`hasMore` 表示后面还有匹配项；`nextOffset` 有下一页时为 `offset+returnedCount`，否则为 null。`truncated` 在有下一页或 `offset>0` 时为 true，表示当前响应没有呈现从头开始的完整集合。compact 模式附带 `omittedFields` 与 `detailAction`，可用 `workbuddy_project_manage {action:"get",projectId:"..."}` 获取详情。无命中返回空数组与 `total:0`。

兼容性：不带查询参数的旧 HTTP 请求继续返回全部可见项目的完整记录；工具 `list` 即使不带查询参数也默认分页 20 条。HTTP 一旦显式指定查询参数，即使用有界查询语义。已有 HTTP `scope=owned/joined/all` 的权限规则继续适用。

## 监控概览

工具：`workbuddy_monitor_read`，`action:"overview"`。HTTP：`GET /onenat-workbuddy/api/monitor/overview`。

| 参数 | 语义 |
| --- | --- |
| `projectId` | 限定一个可见项目；不存在返回 404 |
| `section` | 逗号串，可选 `kpi,agents,nodes,tasks,schedules,sshPool,alerts,events`；缺省全部 |
| `compact` | 工具缺省 true；HTTP 显式查询时缺省 false |
| `limit` | 每个数组的上限，默认 30，最大 200；嵌套数组同样受限 |

```bash
curl -sS -H "Authorization: Bearer $WORKBUDDY_TOKEN" \
  "$WORKBUDDY_BASE_URL/api/monitor/overview?projectId=p00&section=agents,tasks&compact=true&limit=2"

bash skills/workbuddy-mcp/scripts/wbmcp.sh call workbuddy_monitor_read \
  '{"action":"overview","projectId":"p00","section":"agents,tasks","compact":true,"limit":2}'
```

项目投影只返回项目相关的任务、默认及实际参与智能体、节点、事件、告警和资源；项目活动说明不引用其他项目任务。智能体 `busy` 保留全局实际派发忙闲状态，`runningCount/taskCount` 和项目 KPI 按本项目重算，因此智能体可能 `busy:true` 而本项目 `runningCount:0`。调度本身可能跨项目运行，项目概览不把整个调度的其他运行统计归入项目。

工具业务结果的 `agents/tasks/...` 与 `metadata` 直接位于顶层；HTTP 位于 `data` 下。未请求的部分省略。`metadata` 示例：

```json
{"projectId":"p00","compact":true,"limit":2,"sections":{"agents":{"total":2,"returned":2,"hasMore":false},"tasks":{"total":3,"returned":2,"hasMore":true}},"omittedFields":["agents[].resources","tasks[].activity"],"truncatedFields":[]}
```

`sections` 逐数组记录裁剪前总数、返回数和是否有更多，嵌套数组使用字段路径。metadata 的 `totalSource:"overviewSnapshot"` 表示这些计数来自当前概览快照，受聚合窗口影响，不代表全历史任务总数；源快照中的 alerts 最多 30 条、events 最多 100 条，先取该快照再做项目过滤，计数不是全量历史匹配数。`omittedFields` 说明摘要省略的字段；`truncatedFields` 记录过长文本的截断路径。不能用 `truncatedFields` 判断数组是否被裁剪，应检查对应的 `sections[path].hasMore`。摘要名称、标题等过长文本会截断至约 100 字符，并用省略号表示。

兼容性：无参数 HTTP 返回旧完整概览，保留原数组和完整对象结构，不加默认条数裁剪。工具默认 compact true，以控制上下文大小；需要完整字段时显式传 `compact:false`。按 section 查询与 compact 投影共享查询实现。

## 错误和权限

非法整数、越界条数、非法布尔值、未知或空 section 均返回参数错误。HTTP 使用 400；工具业务结果经统一错误层归一化为 `{ok:false,status:400,code:"INVALID_PARAM",legacyCode:"INVALID_PARAMS",...}`，MCP 信封置 `isError:true`，脚本保留业务 JSON 并非零退出。缺失项目使用 404。

监控概览仍仅对平台管理员或服务令牌开放。普通用户即使是所查项目成员，直接 HTTP、HTTP 工具调用、MCP 工具调用都返回 403。项目列表继续按项目成员隔离；过滤和分页 metadata 不能泄露其他用户的私有项目数量。服务令牌仅用于已授权服务通道。HTTP 项目列表保留原有的无用户会话可见范围，私有成员项目不会因此自动开放；AI 工具项目列表的服务身份可查全局范围。HTTP 监控服务身份延续原全局监控可见范围，可在其中按项目投影。因此带服务令牌时，HTTP 项目列表与 AI 工具列表的私有项目可见范围并不相同。

## 自包含回归

```bash
bash scripts/build-standalone.sh
node scripts/project-monitor-regression.mjs
```

脚本要求 Node.js、bash、curl、python3 和已构建的 `dist/server.js`。它启动随机本地端口的独立 WorkBuddy 和内置 mock，为本次运行创建私有临时 data 目录及脚本会话目录。fixture 固定为 28 个项目、19 个智能体、84 个草稿任务；无真实 DSH 入口、不发执行消息，不读取生产配置和数据。退出时终止子进程并删除本次临时数据。

覆盖 REST HTTP、HTTP 工具、原生 MCP、实际 `wbmcp.sh` 的过滤、组合条件、无命中、分页、最大条数、非法参数、摘要字段和裁剪说明，以及普通用户权限隔离。脚本输出逐项断言和每次调用 UTF-8 `responseBytes/businessBytes`，其中 MCP 响应字节包含 JSON-RPC/content 信封，脚本响应字节包含其 JSON 输出格式；`tools/list` 另行记录。常用单项目 `section:"agents,tasks",compact:true` 的业务 JSON 和 HTTP 响应目标为小于 2048 bytes。这个 fixture 目标用于发现结构膨胀，不是任意项目大小的固定响应保证。

2026-11-08 本地独立构建与回归通过：`bash scripts/build-standalone.sh`、`node --check scripts/project-monitor-regression.mjs`、`node scripts/project-monitor-regression.mjs`，153/153 断言通过。fixture 和查询条件如上，以下字节数均为 UTF-8：

| 请求 | 完整响应 bytes | 业务 JSON bytes |
| --- | ---: | ---: |
| MCP `tools/list` | 46929 | 46895（JSON-RPC result） |
| HTTP 旧项目全量（管理员） | 181491 | 181491 |
| HTTP 旧监控全量 | 40969 | 40969 |
| HTTP 单项目 `agents,tasks` compact | 1395 | 1395 |
| HTTP 工具单项目 `agents,tasks` compact | 3008 | 1441 |
| MCP 工具单项目 `agents,tasks` compact | 3253 | 1441 |
| wbmcp.sh 单项目 `agents,tasks` compact | 1572 | 1441 |
| MCP 工具同上加 `limit:2` | 2857 | 1258 |

HTTP 直接响应和三种工具通道的业务 JSON 均达到小于 2048 bytes 的目标。HTTP 工具与 MCP 信封可能同时保留文本/结构化业务结果，完整传输字节数仍高于 2048；脚本输出的 JSON 带空格，也大于紧凑业务 JSON。`tools/list` 当前约 46.9 KB，代表工具名称、描述与参数 schema 的模型上下文成本；用户先前记录的 24.8 KB 是历史基线，未进行受控的同版本前后对比，不能据此声称减少。

任务相关验证与上述脚本通过；仓库其他并发改动的全量 unit 另有 remote-history 错误字段和 tool-contracts 16/17 工具计数断言失败，不计为本脚本的覆盖结果。
