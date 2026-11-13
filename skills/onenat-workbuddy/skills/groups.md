# 子技能：协作群（group_manage）

群 = 成员 + 频道（一条 orchestrate 任务流）+ 首页分组。群元数据平台承载（每用户隔离，v1 无共享群），群聊复用任务通道：开一轮 = 创建 orchestrate 任务，发言 = 向频道任务发消息。字段口径与 Android GroupRoom 逐字一致。

## 身份边界（先读，决定你能不能用）

`workbuddy_group_manage` 只对**控制台登录会话**开放（Web 控制台「👥 群」页签）。AI 令牌通道（wb.mjs / wbmcp.sh / 持 `wbk-` 令牌的 HTTP tools 通道）对**全部 12 个 action 一律返回 `AI_TOKEN_DENIED`**——群数据按登录用户隔离、无共享桶，这是安全基线而非权限配置问题。AI 侧需要群信息时：引导用户在控制台操作；只读旁观频道内容可用 `task_status` / `task_chat`（拿 room 的 channelRef 后当普通任务看）。

## 用法

```
group_manage {action:"list", compact:"true"}      ← 当前登录用户全部群（compact 字段集见下）
group_manage {action:"get", roomId:"…"}
group_manage {action:"create", room:{memberAgentIds:["agent-a","agent-b"], mode:"admin",
  notice:"群公告（≤2000 字）", adminAgentId:"agent-a", projectIds:["proj-x"],
  activeProjectId:"proj-x", section:"项目群"}}
group_manage {action:"update", roomId:"…", room:{notice:"新公告"}}    ← 部分字段合并（缺省字段保留原值）
group_manage {action:"delete", roomId:"…"}        ← 不存在静默幂等；级联清该群历史轮记录
group_manage {action:"sections"}
group_manage {action:"add_section", name:"项目群"}                   ← 重名幂等 {added:false}
group_manage {action:"rename_section", old:"旧名", to:"新名"}        ← 409 SECTION_CONFLICT 并级联迁移群引用
group_manage {action:"remove_section", name:"旧名"}                  ← 幂等；级联置引用群为未分组
group_manage {action:"rounds", roomId:"…"}                           ← 历史轮 taskId 列表（保序）
group_manage {action:"add_round", roomId:"…", taskId:"task-…"}       ← 同 taskId 去重保序
group_manage {action:"mark_read", roomId:"…", lastReadSeq:7}         ← 单调取 max，unreadCount 归零
```

## 幂等语义（照 Android GroupStore，重复调用安全）

- upsert：同 id **保位覆盖**内容，新 id **追加末尾**（列表顺序不抖动）；id/createdBy/createdAt 服务端权威，room 里传了也会被覆盖。
- delete：不存在静默幂等；同时清该群历史轮记录（无孤儿键）。
- add_section：重名幂等 `{added:false}`；空名 INVALID_PARAM。
- rename_section：旧名不存在或新名已存在（含新旧同名）→ `SECTION_CONFLICT`（409），成功时级联迁移引用群且顺序不变。
- remove_section：不存在有效名幂等；级联把引用群的 section 置空串（未分组）。
- add_round：同 taskId 去重保序；群不存在不落键。
- mark_read：`lastReadSeq = max(当前, 入参)` 单调不回退，unreadCount 归零；位点必须非负整数。
- create/update：落库同样对 `lastReadSeq` 取 max（陈旧位点不回退，AND-2）；`unreadCount` 照收（客户端覆盖上报口径不变）。

## 字段口径

- `name` 留空 = 成员名拼接（渲染期语义）；`adminAgentId` 空串 = 无管理员；`mode`：admin（新建默认，普通消息由管理员 @ 分派）/ everyone（自由发言）。
- `channelRef` = 当前频道 orchestrate taskId（空串 = 频道空闲）；`activeProjectId` 必须 ∈ `projectIds`，否则服务端归一化为空（不报错）。
- `notice` ≤2000 字（超长 INVALID_PARAM）；`notifyLevel` all/mention/mute（默认 mention）；`permissionOverride` 空串 = 沿用各成员权限档。
- `memberAgentIds` / `projectIds` 服务端去重保序；`unreadCount` 允许客户端覆盖上报；`createdAt/updatedAt` 服务端维护。

## compact 字段集（W2-2）

`list {compact:"true"}` 每群只返回 **id / name / section / archived / unreadCount / lastReadSeq / memberAgentIds / channelRef / activeProjectId** 九个字段；**未列字段（notice / adminAgentId / mode / projectIds / permissionOverride / notifyLevel / createdAt / updatedAt）是省略、不是丢失**——需要哪个字段用 `get` 取全量，不要据此误判群配置被清空。

## channelRef 与编排的关系

频道就是一条 orchestrate 任务（多成员共享一条消息流）。开新一轮（照 Android groupRoundCreateBody，message 只装轮开启上下文，防双发）：

```
① task_manage {action:"create", mode:"orchestrate", memberAgentIds:[…],
   title:"<群显示名>（第 N 轮）", projectId:"<activeProjectId 如有>",
   message:"新一轮讨论已开启（第 N 轮）。【上轮结论】<≤400 字>"}
② group_manage {action:"update", roomId:"…", room:{channelRef:"<① 返回的 id>"}}   ← 写回频道
③ task_manage {action:"send", taskId:"<频道 id>", message:"<用户正文>"}            ← 用户文本单独投递一次
```

结束本轮：`task_manage {action:"cancel", taskId:频道}` → `add_round` 收进历史 → `update {channelRef:""}`。轮号口径：第 N 轮 = 历史轮数 + 2 起算（当前频道占用一个号位）。

## 典型流程（控制台场景）

建群（create）→ 开轮（create 任务 + update 写回 channelRef）→ 成员 @点名 发言（send）→ 结束轮（cancel + add_round + 清 channelRef）→ 历史轮回看（rounds + task_status / task_chat 只读）。Web 控制台「👥 群」页签已内置全部流程（含空转折叠与已读落位），AI 一般不需要替用户手动走。

## 错误速查

| code | 含义与动作 |
|---|---|
| AI_TOKEN_DENIED | AI 令牌通道调用（改控制台登录会话；wb.mjs/wbmcp.sh 不可用） |
| UNAUTHORIZED | 未登录（群功能需要控制台身份，无共享桶） |
| NOT_FOUND | 群不存在（跨用户不可见，防枚举） |
| SECTION_CONFLICT | 分组重命名冲突（旧名不存在或新名已存在） |
| INVALID_PARAM | 枚举非法 / 公告超 2000 字 / lastReadSeq 非负整数等 |
| STORE_UNHEALTHY / STORE_WRITE_FAILED | 存储损坏保护态 / 落盘失败（联系管理员检查数据文件） |
