# BOT 活动态与用户阅读位置（task-91）

REST 前缀 `/onenat-workbuddy/api`。Android 首页、BOT 卡、项目助手和任务页使用同一服务端账本。保持 HTTP 轮询，不新增推送依赖。

## 接口

`GET /activity` 返回当前登录用户可见且参与活动计数的完整任务集合，可选 `agentId`、`projectId` 过滤。`GET /activity?taskId=...` 用于任务详情，允许读取归档任务/已删除项目的可见历史。后者不代表历史应该重新进入首页计数。

响应 `data`：

```json
{
  "snapshotAt": 1794175200000,
  "snapshotVersion": 42,
  "source": "task_ledger",
  "items": [{
    "taskId": "task-x", "agentId": "bot-a", "agentIds": ["bot-a", "bot-b"],
    "projectId": "proj-x", "activityVersion": 42, "readVersion": 39,
    "unread": true, "state": "waiting_reply", "status": "running", "running": true,
    "pendingAsk": {"agentId": "bot-b", "turnId": "turn-x", "at": 1794175200000},
    "updatedAt": 1794175200000
  }],
  "counts": {"total": 1, "waitingReply": 1, "running": 0, "completed": 0, "failed": 0, "unread": 1},
  "agents": [{"agentId": "bot-a", "counts": {"total": 1, "waitingReply": 1, "running": 0, "completed": 0, "failed": 0, "unread": 1}}],
  "projects": [{"projectId": "proj-x", "counts": {"total": 1, "waitingReply": 1, "running": 0, "completed": 0, "failed": 0, "unread": 1}}]
}
```

示例省略第二个 BOT 的汇总行。`agentIds` 复用 task-90 实际参与语义：直接绑定、会话、已发生轮次、计划子任务、最近实际路由，补充真实 pendingAsk 执行者。候选/default 成员不证明参与；`__node__` 不作为 BOT。顶层/项目按 taskId 去重，同一任务可以出现在多个 BOT 分组中；不能把 BOT 计数相加作为全局计数。`agentId` 是直聊 BOT，否则为当前问题执行者，否则 null；精确定位问题使用 `pendingAsk.agentId`。

`POST /tasks/:taskId/read`，body `{"activityVersion":42}`。服务端从登录身份取 userId，忽略客户端身份，返回 `{taskId,readVersion,activityVersion,unread}`。无绑定用户 403；不存在或无权任务 404；非法/超前版本 400。GET 均不更新阅读位置，响应 `Cache-Control: no-store`。

## 状态与计数

状态优先级：真实非空 `pendingAsk.questions` → `waiting_reply`；本地引擎正在执行 → `running`；终态 completed/success/partial_success → `completed`；其后 failed、cancelled、draft 分别映射同名；存储显示 running 但引擎无法确认运行时 → `unknown`。pendingAsk 优先于引擎 running，因为等待答复时远端会话仍可能 running。答复桥清除 pendingAsk 后，下次读取在所有分组中同时消失。

`completed` 包含部分成功，保留原始 `status` 供客户端区分。完成提醒为 `state=completed && unread`。失败也可未读。取消/草稿/未知计入 total，且可计入 unread，不冒充运行或完成。BOT 在线/离线和 busy/idle 是 task-84 的连接与占用字段，独立于任务状态；离线不能清除问题或完成提醒，未知不能当作离线。活动接口不探测连接、不推算 Token。

默认集合排除归档任务、归档项目和已删除项目的任务；删除任务立即消失。项目恢复后任务按其自身归档状态重新参与计数，阅读位置不丢失。历史单任务查询继续走 task-90 相同 ACL：当前私有项目成员/创建者等现有任务权限；删除项目历史仅管理员或该任务创建者可读。撤销权限立即影响摘要与写入阅读位置，不泄露隐藏任务的存在。

## 阅读版本、同步与乱序

服务端观察任务语义内容（消息/工具卡、问题身份、执行状态、总结和子任务结果）生成持久单调 activityVersion；同内容重复刷新不递增。updatedAt、标题、阅读回执不参与内容签名。修改消息即使长度/时间戳相同也产生新版本。版本是服务端快照标识，不是时间，不保证连续；snapshotVersion 是本实例账本活动时钟，snapshotAt 是请求成功采样时间。多次活动若都发生在两次观察之间，只需一个新版本即可判定有未读。

阅读位置按 `(userId,taskId)` 落盘，与入口/设备无关；只取 max，旧设备迟到回执不回退，旧版本回执不吞掉新消息。客户端必须提交实际展示过的版本，不能用最新轮询版本自动标读。推荐先取单任务活动版本，再加载/渲染详情，确认当前页面可见且仍是该任务后提交较早版本。这样详情加载期间产生的新消息保持未读。仅浏览历史索引或刷新列表不提交回执。后台任务页不自动标读；再次明确打开详情后可标读。

轮询使用请求序号丢弃同入口乱序响应；收到旧版本 read 回执不能覆盖较新本地摘要。成功后共享数据驱动所有入口。请求失败保留最后一次成功数据和采样时间，显示“更新失败/最后成功时间”，首次失败显示未知，不能用空集合把计数归零。当前服务单进程 JSON 持久化语义保持不变；重启保留阅读位置。没有新增多服务写同一数据文件的保证。

## 验证

- `npm run typecheck`：类型检查。
- `npm run test:unit`：含活动业务与真实 HTTP 路由回归，覆盖问题优先级、答复消失、多 BOT 去重、用户隔离、重启、重复/乱序回执、内容同长度编辑、元数据/Token 不影响未读、归档/删除/撤权。
- `npm run build && node --test scripts/task-activity-ui.test.mjs`：生成页面的实际 JS 在 VM/jsdom 中验证乱序、失败保留、同版本跨设备阅读刷新、精确版本确认、可见性/滚动/历史门控、归档详情与卡片跳转。
- `npm run smoke`：mock ONENAT 独立服务回归。该验证不调用生产 BOT 或向真实用户投递消息。
