# 子技能：监控值守与调度（monitor_read / schedule_manage / planner_manage）

## 看监控 / 值守

`monitor_read`：overview 看全局态势（挑在线且空闲的智能体也是它）；`{action:"events", since:<时间戳>}` 增量拉告警；`{action:"history", days:n}` 看历史；`{action:"task", taskId}` 看单任务卡点。

## 管理定时任务

```
schedule_manage {action:"upsert", schedule:{name:"每日站会纪要", nodeMappingId:"<DSH 映射 ID>",
  model:"zai-coding-cn/glm-5.3-flash", message:"生成昨日站会纪要", rule:{kind:"daily", times:["09:00","18:00"]}}}
schedule_manage {action:"run", scheduleId:"sched-…"}     ← 手动触发验证
```

规则：daily(times) / weekly(days,time) / hourly(minute) / monthly(days,time) / interval(minutes) / once(at，**毫秒时间戳**如 `Date.now()+3600000`，不接受日期字符串)。
`nodeMappingId` = 执行节点（主 DSH），到点任务在该节点直发；旧数据（仅 agentIds）自动回退到首个智能体绑定节点。
`model` = 实例级模型（可选，provider/model 格式）：**无人值守任务建议固定为稳定模型**，留空跟随全局调度模型（模型按钮切错会影响无人值守任务）。

## 主调度（@ 多个 sub agent 编排时拆任务用）

编排拆解默认在**任务发起节点（主 DSH）**上执行，无需指定拆解器智能体；`agentId` 仅作任务节点不可达时的兜底。模型：`planner_manage {action:"set", model:"zai-coding-cn/glm-5.3-flash"}`（建议给无人值守场景固定稳定模型）。普通任务不经规划器。
