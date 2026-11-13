# BOT 会话历史索引（task-90）

Android 历史入口使用 `GET /onenat-workbuddy/api/tasks/history`。数据源为完整持久化任务账本，不读取 Token 记录，不限制最近天数或任务总数；自动归档及正文磁盘瘦身不移除索引。任务 ID 与任务列表、项目任务列表以及 task-85 的结果/聊天读取接口相同。此接口只发现任务，不读取远端聊天、不恢复会话、不创建 BOT—项目关联。

## 身份与权限

携带现有控制台登录会话。未登录由服务端返回 401；未绑定用户的 AI/服务令牌和体验身份不获得历史索引权限（403）。不允许通过 query 指定 userId、角色或服务身份来授权。

每次请求按当前用户与当前项目 ACL 重新校验，游标不会缓存权限。现存项目内的任务必须同时满足任务可见性和项目可见性（包括无 owner 的存量任务）；BOT 所有权、BOT 参与记录、项目历史快照和正式关联都不单独授予任务读取权。管理员仍可见所有项目。

项目删除后保留任务原 projectId，不移到公共任务空间。仅任务创建者与管理员可发现残留任务，原项目成员失去项目共享读取权；无 owner 的删除项目历史仅管理员可见。不存在或无权查询的指定项目/BOT 统一 404。BOT 已删除或不再可用时，有权读取其历史任务的用户仍可按稳定 agentId 查询，不返回 BOT 私有配置。存在且可用但没有任务的 BOT 返回空列表。

## 请求

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| agentId | 不限 | 稳定 BOT ID；不按名称匹配 |
| projectId | 不限 | **当前**正式任务归属；可与 agentId 组合 |
| participation | all | all / direct / participant；非 all 必须指定 agentId |
| status | 不限 | 逗号分隔真实 TaskStatus：draft/running/completed/failed/partial_success/success/cancelled |
| archived | all | all / active / archived，指任务 archivedAt，不是项目状态 |
| limit | 50 | 1–200 的十进制整数 |
| cursor | 无 | 服务端签发的下一页游标；续页只传 cursor 即可 |

示例：`GET /onenat-workbuddy/api/tasks/history?agentId=agent-123&participation=all&limit=50`。项目入口可使用同一接口指定 projectId；全局任务历史入口省略两者。

续页如果重复传筛选参数，必须与首次查询完全一致。未知的身份参数不影响授权。非法查询返回 400 INVALID_PARAM；无效/篡改游标返回 400 INVALID_CURSOR；跨用户、角色变化或超过 15 分钟有效期返回 410 CURSOR_EXPIRED；进程重启使签名失效，返回 400 INVALID_CURSOR，应清空本轮分页并重新查询。单个用户/角色最多同时保留 10 份多页查询快照，进程总上限 1000 份，单页查询不占用快照名额，达到上限返回 429 HISTORY_QUERY_LIMIT；可复用已有游标或等待到期，不应循环创建首屏查询。

## 响应

```json
{
  "ok": true,
  "data": {
    "items": [{
      "taskId": "task-abc",
      "title": "检查部署",
      "projectId": "project-1",
      "project": { "projectId": "project-1", "name": "平台", "status": "active" },
      "projectSnapshot": { "projectId": "project-1", "name": "平台", "capturedAt": 1794140000000 },
      "status": "completed",
      "createdAt": 1793000000000,
      "updatedAt": 1794140000000,
      "lastActivityAt": 1794140000000,
      "archivedAt": null,
      "participation": "direct",
      "chatAgentId": "agent-123",
      "agentStatus": "available",
      "canContinueDirect": true,
      "continuationReason": null,
      "summary": "部署检查完成",
      "summaryTruncated": false
    }],
    "nextCursor": null,
    "hasMore": false,
    "snapshotAt": 1794141000000,
    "expiresAt": 1794141900000,
    "sort": "lastActivityAt_desc_taskId_asc",
    "source": "task_ledger"
  }
}
```

时间均为 epoch 毫秒。摘要优先取汇总最终结论、汇总概述、最后一条本地回合文本，最多 800 UTF-16 code units。无消息任务摘要为空。最近活动为 updatedAt、createdAt 与最后一条回合结束/开始时间的最大值。status 是当前任务真实状态，不将 success 映射成 completed；不由 Token 消耗推断完成状态。

project 是当前项目名称及 active/archived/deleted 状态，未归属项目为 null。projectId 保留当前存储归属；删除项目仍保留原 ID。projectSnapshot 是首次在任务写入/变更时观察到正式项目的名称快照，属于展示数据，绝不用于授权、筛选或创建关联。旧任务在项目删除前补记快照；升级前已经删除的项目名称可能无法恢复，此时 name/projectSnapshot 为 null。项目重命名不改变已捕获快照。更换归属时 project 与 projectSnapshot 可以不同，客户端应以 project 显示当前归属，快照仅作历史说明。

## 参与类型与续聊

- direct：task.chatAgentId 与查询 agentId 相等，包括尚未产生任何回合的硬绑定 draft。
- participant：存在成员会话、实际回合、规划子任务或已记录路由证据，但没有该 BOT 的硬绑定。多 BOT 同一任务各自查询返回同一个 taskId。
- 仅 memberAgentIds 默认候选成员不算参与；过去按单成员创建、没有 chatAgentId 的旧任务也不自动推断为 direct。
- 未指定 agentId 时 participation、agentStatus 为 null，chatAgentId 仍返回真实硬绑定。

只有硬绑定 BOT 存在、启用、当前用户可使用，且项目存在并未归档时 canContinueDirect 才为 true。false 对应 continuationReason：unbound_task/collaboration/project_deleted/project_archived/agent_deleted/agent_disabled/agent_forbidden。协作参与任务应打开协作详情，通过 task-85 选择成员/子任务读取。此字段判断路由适用性，不保证节点在线；发送时仍执行既有可达性和身份预检。

任务本身归档仅改变列表分组，仍可续聊；项目归档只读，历史可读，不能直接续聊。任务物理删除后从后续页过滤，不提供墓碑。正式关联项目列表继续使用 task-89 的 linked，索引项目历史绝不能并入 linked。

## 分页一致性

首屏按 lastActivityAt 降序、taskId 升序固定全部匹配任务 ID 的快照，后续 cursor 沿此集合推进。任务在分页期间更新活动时间或状态、归档，仍保持首次集合中的位置，每个存活且仍有权限的任务恰好出现一次；行字段使用请求时的实时值，因此更新时间可能与固定排序位置不一致。新建任务在下一轮刷新中出现，避免插入导致跨页遗漏或重复。

删除、权限撤销、指定项目归属变化或 BOT 参与证据消失会使任务在续页即时过滤。状态/归档筛选用于确定首次集合，后续状态变化仍返回真实新值。hasMore 表示 ID 快照尚有未扫描部分；下一页可能因权限/删除过滤为空。不要通过 total 推断不可见任务数，也不返回全局总数。游标是同身份、同筛选、短期有效的分页句柄；重复请求同一游标不会消费游标，实时数据变化时响应内容可变化。
