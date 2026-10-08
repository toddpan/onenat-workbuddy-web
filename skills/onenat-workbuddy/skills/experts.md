# 子技能：专家库管理（expert_manage）

专家库 = 数百位预制名册专家 + 内置角色 + 用户自建专家的统一注册表。专家可直接 @ 派活，也可作为子智能体的人格来源。

```
expert_manage {action:"list", domain:"team", limit:50, offset:0}   ← 分页列表（total + divisions 概览）
expert_manage {action:"search", query:"代码审查"}                  ← 全文检索（元数据 + prompt 正文）
expert_manage {action:"get", expertId:"expert-reviewer"}           ← 完整档案（systemPrompt/executionPrompt/role）
expert_manage {action:"create", expert:{id:"my-deploy-checker",
  name:"部署检查员", description:"发版前检查清单把关", icon:"🚦",
  systemPrompt:"你是部署检查员……（职责与约束，必填）",
  executionPrompt:"检查顺序：1… 2… 产出格式：…", tags:["部署","质检"]}}
expert_manage {action:"update", expert:{id:"my-deploy-checker", systemPrompt:"<修正后的提示词>"}}
expert_manage {action:"delete", expertId:"my-deploy-checker"}
```

- **权限边界**：`source:"user"` 的专家可改可删；`roster`/`builtin`（名册与内置角色）**只读**——要「修」它们时用 `create` 建一个同领域的用户专家替代（copy-on-write），id 不可与既有专家冲突。
- **id 规范**：小写字母/数字的中划线 slug（如 `my-reviewer`）。
- **修模板数据的路径**：`get` 取原档案 → 参考 systemPrompt 改写 → `create`/`update` 落到用户专家层 → 任务里 `@新专家名` 使用。
- **查全库**：`list` 默认每页 50 条（最大 200），返回 `divisions` 分区概览便于按 `domain` 收窄；`skill` 参数按名称/简介/tags 过滤。
- 专家库里的人**没有绑定节点**——@ 专家名派活时走任务所属节点（项目任务 = 项目节点）；要固定执行机器，把专家人格装进子智能体（`agent_manage upsert` 带 systemPrompt）再 @ 那个子智能体。

## 专家 vs 子智能体怎么选

| | 专家（expert_manage） | 子智能体（agent_manage） |
|---|---|---|
| 本质 | 纯人格（提示词档案） | 人格 + 绑定节点 + 工作目录 + 资源 |
| 执行位置 | 任务所属节点动态实例化 | 固定在自己绑定的节点 |
| 建档成本 | 一条 create 即可 | 需要节点映射 ID 与目录 |
| 适用 | 换个角色视角干活、临时专家 | 长期驻守某台机器的执行者 |
