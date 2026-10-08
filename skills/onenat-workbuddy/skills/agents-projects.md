# 子技能：子智能体与项目管理（agent_manage / project_manage）

## 新建子智能体（sub agent）

```
agent_manage {action:"upsert", agent:{name:"136-执行者",
  dshRef:{kind:"mapping", mappingId:"<DSH 映射 ID>"},
  systemPrompt:"<角色+职责>", workDir:"<该节点上的项目目录>",
  resources:[{ref:{kind:"mapping", mappingId:"<SSH 映射 ID>"}, credentialMode:"self-fetch"}]}}
```

建好后 `ping` 探活、`models` 看可用模型。`credentialMode`：self-fetch（推荐）/ inline / omit。
`workDir` 必须是该 sub agent **绑定节点上的绝对路径**——@ 它时就在那台机器上执行。

子智能体把专家人格装进固定节点：`systemPrompt` 直接抄专家档案（`expert_manage get` 取），或 `preview` 看资源注入后的完整提示词。其余 action：list / delete / enable / disable / presets。

## 项目管理：project_manage

```
project_manage {action:"list"}                                   ← 列出项目（含节点/工作区/可@ sub agent/任务数）
project_manage {action:"get", projectId:"proj-x"}
project_manage {action:"upsert", project:{name:"KB 平台交付",
  dshRef:{kind:"mapping", mappingId:"<DSH 映射 ID>"},
  workspace:"/root/KB-algo", instruction:"<角色/阶段/规范指令>",
  expertIds:["agent-a","agent-b"], skillNames:["kb-algo","kb-api"]}}
project_manage {action:"delete", projectId:"proj-x"}
```

- 项目把「执行节点(DSH) + 工作目录 + 项目指令 + 可@ sub agent + 连接器 + 技能」捆绑成可复用上下文；`task_manage create` 带 `projectId` 即项目任务，全部自动继承（详见 tasks.md）。
- `expertIds` = 项目内可 @ 的 sub agent 集合（校验存在，用 `agent_manage list` 查 ID）。
- `connectorIds` 形如 `"ssh:<id>"` / `"map:<mappingId>"`；`skillNames` 是任务里可 `/技能名` 使用的技能。
- 编辑项目带原 `id`；映射 ID 用 `resource_manage {action:"dsh"}` 查，别凭记忆猜。
