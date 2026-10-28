# Agent 驱动人的协同平台 —— 后端架构规范 v1.0

> 角色：后端架构师 | 日期：2026-10-27 | 状态：设计定稿（待评审）

---

## 一、结论摘要

1. **核心范式反转**：平台把经典 Human-in-the-Loop 倒置——Agent 是编排者（Orchestrator），人是最末几公里的"受托执行者"。Agent 不直接命令人，而是产出**结构化授权请求（Action Request）**，经统一派发/回复/验收管线驱动人完成物理世界动作。
2. **五个核心服务**：编排服务（Agent Planner）、人机交互网关（派发+回复归一）、任务状态机（Event Sourcing）、验收引擎（Agent 验收 + 抽样人工复核）、通知/SLA 服务。围绕 PostgreSQL + Redis + 消息队列构建。
3. **人工任务是一种一等公民资源**：HumanTask 与 API 调用一样出现在计划 DAG 中，有 SLA、超时升级、重试、幂等 ID 与审批分级——这是"驱动人"与"派通知"的本质区别。
4. **安全上实行人保留最终否决权**：高危动作（外发、转账、删除、对外承诺）必须双人确认或人工审批，Agent 全程留痕可审计；Agent 权限最小化，对人只有"请求权"没有"控制权"。

---

## 二、问题定义与设计原则

### 2.1 要解决什么

| 传统模式 | 本平台目标 |
|---|---|
| 人发现问题 → 人分解 → 人指派 → 人跟催 | Agent 感知/接收目标 → Agent 分解计划 → Agent 派发给人 → Agent 跟催/验收/重派 |
| 任务散落在 IM/邮件/口头，无状态 | 每个"请求人做事"的动作是一条有状态、可追踪、可验收的记录 |
| 人回复格式不定，无法进入系统 | 回复经结构化网关归一（表单/确认卡/自由文本+LLM 抽取）回流 |

### 2.2 设计原则（不可妥协项）

- **P1 请求权而非控制权**：Agent 对人的最大化动作是"派发一个可拒绝的请求"；拒绝、延期、修改是人的合法输出，不是异常。
- **P2 一切驱动 = 有状态任务**：没有裸通知。每次驱动都创建 HumanTask 记录（含 SLA、重试策略、验收标准）。
- **P3 回路闭环**：派发 → 回执 → 提交成果 → 验收 → 结案，五态缺一不可；未闭环任务自动升级而非静默丢失。
- **P4 事件溯源**：AutomationPlan / HumanTask 的全部状态变更走事件流，天然获得审计、重放与调试能力。
- **P5 幂等与 at-least-once**：对外派发（IM/邮件/App）全部幂等键 + 去重窗口；回调网络抖动不产生双任务。
- **P6 人在环路的安全位**：高危 ActionRequest 强制 approval tier，Agent 不能自我放行。

---

## 三、高层架构

**架构模式**：模块化微服务（先 3 服务后拆分）
**通信模式**：内部 gRPC/事件驱动（NATS/JetStream），对外 REST + Webhook + IM Bot
**数据模式**：Event Sourcing（任务域）+ Traditional CRUD（配置/人档）
**部署模式**：容器化（K8s），无状态服务 + 托管 PG/Redis

```
                 ┌─────────────────────────────────────────────┐
  触发源          │              Agent Orchestration 层          │
  (IM/Slack/     │  ┌────────────┐  ┌─────────────┐  ┌───────┐ │
  Webhook/定时)──▶│  │ Goal Ingest│─▶│ Planner(Agent)│─▶│ Plan   │ │
                 │  └────────────┘  └─────────────┘  │  DAG   │ │
                 └─────────────────────────────────┬─┴───────┴─┘
                                                   ▼
                 ┌─────────────────────────────────────────────┐
                 │           Human Interaction Gateway          │
                 │  dispatch(IM/邮件/App push) ← idempotency    │
                 │  ingest(回复/表单/确认卡) → 归一化甚至结构化    │
                 └──────────────────┬──────────────────────────┘
                                    ▼
                 ┌─────────────────────────────────────────────┐
   事件总线       │        Task State Machine (ES)               │
   (NATS)◀──────▶│  创建/派发/回执/提交/验收/升级/取消             │
                 └──────────┬───────────────────┬──────────────┘
                            ▼                   ▼
                 ┌──────────────────┐   ┌──────────────────────┐
                 │ Verification Svc │   │ Escalation / SLA Svc │
                 │ Agent 验收+抽样复核│   │ 定时扫描→催办→换人→熔断│
                 └──────────────────┘   └──────────────────────┘
                            ▼
                 ┌─────────────────────────────────────────────┐
                 │  持久层: PostgreSQL(事件+读模型)               │
                 │  Redis(幂等/限流/在线人会话)  对象存储(成果附件)│
                 └─────────────────────────────────────────────┘
```

### 服务分解

| 服务 | 职责 | 关键技术点 |
|---|---|---|
| **Goal Ingest** | 接收目标（用户消息/webhook/定时/监控告警），创建 Goal 聚合 | 分布式去重（dedup key）、速率限制 |
| **Planner**（Agent） | LLM 将 Goal 拆解为 Plan DAG：节点=API 调用或 HumanTask | 计划 schema 校验（JSON Schema）、人审闸门 |
| **Human Gateway** | 派发请求到 IM/邮件/App，归一化人力回复；管理"人在会议中"等异步语义 | IM Bot 回调、模板卡片、结构化表单版本化 |
| **Task FSM** | HumanTask 状态机与事件溯源，唯一写入路径 | 乐观并发、事件序号、投影重建 |
| **Verification** | 验收：规则 + LLM Judge + 抽样人工复核；不合格自动退回 | Judge 结论可信度分数、退回即生成新节点 |
| **Escalation/SLA** | 扫描临近超时任务：催办 → 换人 → 升级到管理者 → 标记失败回流规划器 | 定时器用持久化 timer（PG-based），不依赖进程内存 |
| **Notification** | 与 Gateway 共用通道但语义分离：通知可丢，请求不可丢 | 投递重试、死信队列 |

---

## 四、数据模型（核心 Schema）

```sql
-- 人员档案与能力（谁可以被驱动、擅长什么、当前负载）
CREATE TABLE workers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    channels JSONB NOT NULL,          -- [{type:'lark', id:'ou_x'}, {type:'email', addr:'x@y'}]
    skills TEXT[] DEFAULT '{}',       -- 用于派发匹配
    max_concurrent INT DEFAULT 5 CHECK (max_concurrent >= 1),
    timezone VARCHAR(64) DEFAULT 'Asia/Shanghai',
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 目标（Agent 的输入）
CREATE TABLE goals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    origin VARCHAR(32) NOT NULL,      -- user|webhook|schedule|monitor
    raw_content TEXT NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'received',  -- received|planning|executing|done|failed|cancelled
    created_by VARCHAR(128),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_goals_status ON goals(status) WHERE status IN ('received','planning','executing');

-- 计划（Agent 拆解产物，DAG）
CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    goal_id UUID NOT NULL REFERENCES goals(id),
    version INT NOT NULL DEFAULT 1,          -- 重规划原子+1
    dag JSONB NOT NULL,                      -- {nodes:[{id,type:'api'|'human',spec}], edges:[...]}
    requires_human_review BOOLEAN DEFAULT false,  -- 高风险计划先过人审
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(goal_id, version)
);

-- 人工任务（平台的灵魂实体）
CREATE TABLE human_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES plans(id),
    node_id VARCHAR(64) NOT NULL,            -- DAG 内节点
    worker_id UUID REFERENCES workers(id),
    title VARCHAR(255) NOT NULL,
    instruction TEXT NOT NULL,               -- Agent 写的、给人看的指令
    structured_form JSONB,                   -- 可选：回复表单 schema
    deadline TIMESTAMPTZ NOT NULL,
    sla_policy JSONB NOT NULL,               -- {remind:[..], escalate_to, retry_count}
    approval_tier SMALLINT NOT NULL DEFAULT 0,  -- 0=无 1=本人确认 2=双人 3=管理者审批
    status VARCHAR(24) NOT NULL DEFAULT 'pending_dispatch',
        -- pending_dispatch → dispatched → acknowledged
        --   → submitted → (verified | rejected_rework) → verified
        --   任意态可 → declined / cancelled / escalated / failed
    outcome JSONB,                           -- 验收通过后的结构化成果
    attempts SMALLINT NOT NULL DEFAULT 0,
    idempotency_key VARCHAR(128) UNIQUE,     -- 防重复派发
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- 热路径索引
CREATE INDEX idx_ht_open_tasks ON human_tasks(worker_id, deadline)
    WHERE status IN ('pending_dispatch','dispatched','acknowledged','submitted');
CREATE INDEX idx_ht_sla_scan ON human_tasks(deadline)
    WHERE status IN ('dispatched','acknowledged');   -- SLA 扫描器专用部分索引
CREATE INDEX idx_ht_plan_node ON human_tasks(plan_id, node_id);

-- 事件溯源表（唯一事实来源；读模型由投影生成）
CREATE TABLE human_task_events (
    seq BIGSERIAL PRIMARY KEY,
    task_id UUID NOT NULL,
    event_type VARCHAR(48) NOT NULL,   -- Dispatched/Acked/Submitted/Verified/Declined/Escalated...
    payload JSONB NOT NULL,
    actor VARCHAR(64) NOT NULL,        -- agent:<id> / worker:<id> / system:sla / system:judge
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    prev_hash VARCHAR(64),             -- 事件链哈希，防篡改审计
    event_hash VARCHAR(64)
);
CREATE INDEX idx_hte_task ON human_task_events(task_id, seq);

-- 验收记录
CREATE TABLE verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES human_tasks(id),
    method VARCHAR(24) NOT NULL,       -- rule|llm_judge|human_review
    verdict VARCHAR(16) NOT NULL,      -- pass|fail
    confidence NUMERIC(4,3),           -- llm judge 置信度;低于阈值强制 human_review
    rationale TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**索引与查询目标**：SLA 扫描（部分索引，毫秒级）、按人查开放任务、按 Goal 回溯全链路（events join）。10 万级并发任务规模下 P99 查询 < 20ms，验证手段为 pg_stat_statements 周报。

---

## 五、API 设计规范

REST 对外（人/第三方），gRPC 对内，Webhook 回调进站。全部带请求 ID + 幂等键。

```text
# 派发与状态（对外管理面）
POST   /api/v1/goals                          创建目标 {content, origin}
GET    /api/v1/goals/:id/plan                 查看规划及其人审状态
GET    /api/v1/human-tasks?worker=me&status=dispatched   个人任务台
POST   /api/v1/human-tasks/:id/ack            {worker_id} 回执接单
POST   /api/v1/human-tasks/:id/submit         {outcome|form_schema_version, data, attachments[]}
POST   /api/v1/human-tasks/:id/decline        {reason} 拒绝是合法输出，触发重派
POST   /api/v1/human-tasks/:id/approve        高危动作人工审批 {decision, comment}

# 回调进站（IM/邮件渠道，Gateway 专用，HMAC 签名验证）
POST   /callbacks/:channel/:signature         归一化 → 匹配未决任务 → FSM 事件

# 事件流出（供下游消费）
GET    /api/v1/goals/:id/timeline             事件流投影视图
```

关键约束：
- `POST /submit`、`POST /ack`、`POST /decline` 一律幂等（已生效的相同请求返回 200 + 原结果）。
- 结构化表单带 `form_schema_version`：老版本回复在新版本校验规则下仍可验收（向后兼容）。
- 回调验签失败返回 401 并计数；同一渠道 5 分钟内 >100 次验签失败触发自动封禁告警。

---

## 六、人被"驱动"的交互语义（体验层约定）

人是被请求方，体验必须像"接到一张专业工单"，不是"被机器人轰炸"：

1. **请求卡**：一次派发 = 一张可操作卡片，含：目标背景（来自 Goal，让人理解为什么）、要做的事、截止时间、回复方式（按钮/表单/自由文本）、可点"不行，因为…"。
2. **回复归一化**：三种输入统一进 Gateway——(a) 结构化表单（首选）、(b) 卡片按钮（确认/拒绝/延期）、(c) 自由文本（LLM 抽取结构化字段，抽取置信度 < 0.8 则追问一次，最多追问 2 次后转人工）。
3. **催办节奏**：deadline 前 50%/1 个单位时间/超时后 1 个单位时间三次提醒（可配），全部通过同一通道节流，绝不让催办空间上刷屏。
4. **拒绝友好**：decline 必填结构化原因（没时间/能力不符/指令不清/有更优做法），回流规划器作为重规划信号——这是平台自我改进的数据来源。

---

## 七、状态机与可靠性设计

```
pending_dispatch ──dispatch──▶ dispatched ──ack──▶ acknowledged
   │                              │                    │
   │(无可用人/通道失败→badge重试)    │(超时→escalate)      ├─submit─▶ submitted ──verify──▶ verified ✔
   ▼                              ▼                    │                  │verify fail
 declined ◀──decline── (任何在途态可 decline，附原因)    │                  ▼
                                                      │              rejected_rework ──(重派, attempts+1)─▶ dispatched
   escalated ◀──(SLA 引擎外部转移)──┘  超过 attempts 上限/BUDGET 上限 ▶ failed ──▶ 触发重规划(plan v+1)
```

可靠性要点：
- **Persistent Timer**：超时/催办不依赖内存 setTimeout，用 PG `cron` 式任务表 + 通知行锁轮询；服务重启不丢定时器。
- **幂等投递**：派发消息以 `idempotency_key = hash(plan_id, node_id, attempt)` 入队；IM 侧以消息模板 ID 做去重窗口（10 分钟）。
- **死信队列**：三次投递失败进 DLQ + 告警，绝不静默吞掉一个"该给人做的请求"。
- **审计链**：human_task_events 事件哈希链，满足"谁在何时被谁要求做何事、如何回复"的全量追责。

---

## 八、安全设计

- **权限分层**：Agent 服务账号仅有 human-tasks 的 create/read 权限，无 approve 权限——审批权只属于人。审批分层：tier1 本人、tier2 双人（第二人不得是发起 Agent 的关联人）、tier3 部门管理者。
- **高危动作清单化**：外发邮件、转账、对外承诺承诺、删改生产数据强制 tier≥2，清单由安全配置中心下发。
- **Prompt 与任务注入防护**：Goal 与 worker 回复都是不可信输入；进 LLM 前过结构化包裹，禁止指令原文直接进入系统提示词；验收 Judge 同样隔离。
- **传输与存储**：全链路 TLS；成果附件对象存储 SSE 加密；worker 手机号等 PII 字段列级加密。
- **速率与熔断**：单 worker 每日被打驱动的请求数上限（防 Agent 失控轰炸）；平台级配额熔断；所有 Agent 派发行为有全局告警看板。
- **合规**：完整回答 GDPR 式的问题——"谁让我做的？我为什么必须做？" 事件链即答案。

---

## 九、验收（verify）引擎

```
submit 进来
   │
   ├─ 有 structured_form 且校验通过 ──▶ rule 验收（确定性）──pass──▶ verified
   │
   ├─ 非结构化成果 ──▶ LLM Judge（给出 verdict + confidence）
   │        ├─ confidence ≥ 0.9 且 pass ──▶ verified
   │        ├─ fail ──▶ rejected_rework（附 judge 理由给人，重派）
   │        └─ confidence < 0.9 ──▶ 升级 human_review（抽样/低置信复核）
   │
   └─ 人工抽检率全局 5% 起步，按 judge 历史准确率动态调整 —— 校准 Judge 本身
```

Judge 每月用人工复核结果回测准确率，是平台质量的核心 SLA 指标之一。

---

## 十、演进路线

| 阶段 | 范围 | 出口标准 |
|---|---|---|
| P0 MVP（4-6 周） | 单渠道（IM Bot）+ Goal→Plan→HumanTask→submit→验收 主链路，tier1/tier3 审批 | 10 个真实场景跑通，事件链完整 |
| P1 | 多渠道、SLA 升级自动化、LLM Judge + 抽样复核、decline 学习回流 | 拒绝原因回流驱动重规划成功率 > 30% |
| P2 | 多 Agent 协作规划（子 Agent 领域专家）、技能库、成本配额 | 单 Goal 10²级节点 DAG 稳定编排 |

---

## 十一、自检结论（架构师视角）

- **为什么能驱动人而不是骚扰人**：请求卡化 + SLA/g上限配额 + 拒绝合法化，三项共同约束 Agent 的"驱动力"。
- **最大架构风险**：自由文本回复的抽取可靠性。缓解：表单优先策略 + 追问上限 + 人工复核兜底 + 持续校准。
- **扩展性**：Task FSM 与 Verification 均无状态可横扩；存储单写多读，10 万任务/日规模下单 PG 主从足够，之后按 goal_id 分片。
