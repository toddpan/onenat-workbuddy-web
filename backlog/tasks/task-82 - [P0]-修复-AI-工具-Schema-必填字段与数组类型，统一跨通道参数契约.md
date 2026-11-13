---
id: task-82
title: '[P0] 修复 AI 工具 Schema 必填字段与数组类型，统一跨通道参数契约'
status: Done
assignee:
created_date: '2026-11-08T11:40:09Z'
updated_date: '2026-11-08T12:56:42Z'
labels:
  - ai-ux-20261108
  - mcp
  - bug
  - schema
dependencies:
priority: P0
ordinal: 82000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
来源：2026-11-08 Codex 以 AI 工具调用方身份实测；体验任务 task-cafa75a0（已完成，纯文本回显，无工具调用）。已检索现有 backlog，未发现同范围条目。

实测证据：tools/list 的 task_status、task_chat、task_evaluate、task_ask_answer 均声明 required:['action']，但 properties 没有 action；memberAgentIds、answers、itemIds 描述为数组，实际 inputSchema 却为 object。复杂 JSON 对象缺少结构化字段定义，严格宿主可能拒绝合法调用，模型也容易构造错误参数。

定位：src/xiaozhi-mcp.ts 的 toolDefToInputSchema（实测时约 82–91 行）将所有 json 参数映射为 object，并固定 required:['action']；src/mcp-server.ts tools/list 复用该转换器。

方案：每个工具显式声明必填字段；数组使用 array/items，嵌套对象声明 properties 与必要约束；action 声明合法取值并进行分支必填校验。HTTP、原生 MCP、脚本复用同一份业务参数契约，兼顾现有宿主支持范围与兼容性。保留已有 paramWarnings，不要将未知参数静默当成有效参数。

范围：契约修复与跨通道回归，不涉及新增业务功能或自动派发任务。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 16 个工具的必填字段均与实际参数声明及业务语义一致，四个无 action 工具不再要求不存在的 action。
- [ ] #2 memberAgentIds、answers、itemIds 可按 array/items 传递原生数组，并覆盖嵌套对象及错误类型校验。
- [ ] #3 agent、project、team、filter、item 等复杂对象具有可用的结构化 Schema；缺失必要字段时返回明确的字段级错误。
- [ ] #4 严格宿主可加载全部工具，并通过任务创建、状态查询、提问答复参数及批量 ID 参数的契约测试。
- [ ] #5 HTTP、原生 MCP、wbmcp.sh 使用相同合法样例完成回归，兼容原有正常调用并记录契约变更。
<!-- AC:END -->

### 2026-11-08T12:46:17Z 派发为任务
task-84a610db · mode=chat · 成员=0

### 2026-11-08T12:56:42Z 派发执行（成功）
任务 task-84a610db · 结果=成功
我会先核对 16 个工具的定义、参数校验和三条调用通道，修复共享契约，再补回归测试并执行构建与 smoke。此任务会使用 `agent-experience` 技能检查模型可见的 Schema。
已确认两个根因都在共用转换器：固定要求 `action`，以及把所有 `json` 参数都映射成 `object`。工作区已有其他未提交改动，我会保留它们。接下来会让工具定义同时驱动 Schema 和执行前校验，兼容现有 JSON 字符串入参，并保留未知参数的警告。
共享校验已接入三条通道调用的工具执行入口；HTTP 工具发现接口也已增加 `inputSchema`，与 MCP 使用同一份定义。回归测试正在补充：原生数组与旧 JSON 字符串的等价性、嵌套字段错误，以及未知参数的可见警告。测试只会创建无消息的 draft 任务，不会触发智能体执行。
16 个工具的契约文件已完成，兼容性检查保留了 `task_status` 不传任务 ID 的列表用法、项目局部更新和旧 JSON 字符串入参。首次类型检查发现了新 Schema 的类型声明问题，以及工作区其他并行改动造成的字段重复；正在修正并重新
