/**
 * onenat-workbuddy-web - Data Types & Protocol Models
 *
 * 设计文档: ngrok 仓库 docs/onenat-workbuddy-design.md
 * 核心决策 D1: 子智能体/资源绑定一律引用 ONENAT 稳定 ID (mappingId/appId)，
 *              运行时经 ResourceDirectory 解析出当下公网入口，端口漂移免疫。
 */

// ---------- ONENAT 资源面 ----------

/** /api/v1/resources 返回的原始映射（字段子集） */
export interface OnenatMapping {
  id: string
  proto: 'tcp' | 'http'
  public_url?: string
  local: string
  note?: string
  auth_override?: boolean
  auth_type?: string
  app?: OnenatApp
}

export interface OnenatApp {
  id: string
  name: string
  type: string
  description?: string
  internal_url?: string
  auth_type?: string
  username?: string
  skills?: Array<{ name: string; size?: number; url: string }>
}

export interface OnenatTunnel {
  id: string
  name: string
  note?: string
  online: boolean
  mappings: OnenatMapping[]
}

/** 解析后的资源端点（同一映射在客户端重连后 host:port 会变，ID 不变） */
export interface ResolvedEndpoint {
  mappingId: string
  appId?: string
  tunnelId: string
  tunnelName: string
  note?: string
  online: boolean
  proto: 'tcp' | 'http'
  host: string
  port?: number
  local: string
  /** tcp 隧道承载 HTTP 或 http 映射时合成的 web 入口（路径不变） */
  baseUrl?: string
  kind: 'ssh' | 'dsh' | 'http' | 'tcp' | 'unknown'
  /**
   * 该映射是否设了实例级凭证覆盖（= /api/v1/resources 的 auth_override）。
   * false/undefined ⇒ 该映射继承"应用级默认凭证"：一个应用被多条映射共用时，
   * 这个凭证只对应用凭证所属的那台实例有效，对别的目标机可能无效。
   */
  authOverride?: boolean
  appName?: string
  appType?: string
  appSkills?: Array<{ name: string; size?: number; url: string }>
  resolvedAt: number
}

export interface ResourceSnapshot {
  fetchedAt: number
  baseUrl: string
  tunnels: OnenatTunnel[]
}

export interface OnenatCredentials {
  ok: boolean
  authType?: string
  username?: string
  password?: string
  apiKey?: string
  token?: string
  /** 'mapping' = 该映射的实例独立凭证（权威）；'app' = 继承应用级默认凭证（共享，可能对目标机无效） */
  resolvedFrom?: string
  /** 本凭证的取数时刻（ms）：提示词里必须暴露，用于判断"派发快照是否已过期" */
  fetchedAt?: number
  error?: string
}

// ---------- SSH 连接资源（本地直连资源池，补充 ONENAT 之外的资源） ----------

export type SshAuthType = 'password' | 'key'

export interface SshResource {
  id: string
  name: string
  host: string
  port: number
  authType: SshAuthType
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  description?: string
  tags?: string[]
  lastTestedAt?: number
  lastTestOk?: boolean
  lastTestError?: string
  createdAt: number
  updatedAt: number
}

export type SshResourceMasked = Omit<SshResource, 'password' | 'privateKey' | 'passphrase'> & {
  hasPassword: boolean
  hasPrivateKey: boolean
  hasPassphrase: boolean
}

// ---------- 子智能体 ----------

/** DSH 实体引用 —— 稳定 ID；direct 仅作手工兜底（D1） */
export type DshRef =
  | { kind: 'mapping'; mappingId: string }
  | { kind: 'app'; appId: string }
  | { kind: 'direct'; apiBaseUrl: string }

export type CredentialMode = 'inline' | 'self-fetch' | 'omit'

export interface AgentResourceBinding {
  ref: { kind: 'mapping'; mappingId: string } | { kind: 'app'; appId: string }
  alias?: string
  /** 凭证注入策略：inline=写进提示词；self-fetch=给 ONENAT 凭证接口让 AI 自取；omit=不给 */
  credentialMode: CredentialMode
  /** 技能文件注入：all=全部内联；names=指定清单；none=只给目录让 AI 按需拉取 */
  skillMode: 'all' | { names: string[] } | 'none'
  note?: string
}

export interface SubAgent {
  id: string
  name: string
  dshRef: DshRef
  /** direct 引用时的 API Key；mapping/app 引用时优先经 ONENAT 映射凭证接口解析 */
  apiKey?: string
  agentPreset?: string
  permission?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  systemPrompt?: string
  /** 专家正式角色名（如"需求分析师"）：编排花名册与卡片展示用；空 = 通用执行者 */
  role?: string
  /** 专家执行提示词：角色专属工作方法与产出结构要求（注入派工提示词的「执行指导」段） */
  executionPrompt?: string
  /** 远端工作目录（绝对路径）：该成员所有远端会话的 cwd，即其文件工具根目录与附件落盘处；留空用远端默认 */
  workDir?: string
  resources: AgentResourceBinding[]
  /** 绑定的「已安装」技能名（kebab-case）；派发时在提示词写入 /名 手势，由远端宿主原生加载技能正文 */
  skills?: string[]
  tags?: string[]
  description?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** 运行时解析出的 DSH 调用目标 */
export interface ResolvedDshTarget {
  baseUrl: string
  apiKey?: string
  agentId: string
  mappingId?: string
  resolvedAt: number
  /** 资源面健康状态 */
  online: boolean
  error?: string
}

export interface ResolveIssue {
  agentId: string
  name: string
  error: string
}

// ---------- 动态提及 (@ Mentions) ----------

export interface MentionItem {
  type: 'agent' | 'resource'
  id: string
  name: string
  kind?: 'ssh' | 'dsh' | 'http' | 'tcp' | 'unknown'
  detail?: string
  ref?: { kind: 'mapping' | 'app' | 'direct'; mappingId?: string; appId?: string; apiBaseUrl?: string }
}

export interface ExtractedFileMention {
  raw: string
  agentId: string
  agentName: string
  path: string
  filename: string
}

export interface ExtractedMentions {
  mentionedAgentIds: string[]
  mentionedResourceBindings: AgentResourceBinding[]
  mentionedFiles?: ExtractedFileMention[]
  /** @专家团 提及：本轮消息按该团队合同发起编排（消息级路由，命中后团队固化为任务语义） */
  mentionedTeamId?: string
  /** @专家库角色 提及（专家 id）：单个 → 定向直派（动态实例化在任务节点），多个 → 并行编排 */
  mentionedExpertIds?: string[]
  /** 提及了同名多个专家（已拒绝召唤，记录名字供系统提示） */
  mentionedExpertAmbiguous?: string
  /** @项目 提及（项目 id）：任务未绑定项目时视为对该项目发起任务（节点/工作区/项目指令/专家全继承） */
  mentionedProjectId?: string
  cleanText: string
}

// ---------- 项目 ----------

/**
 * 项目：捆绑 DSH 节点 / 工作区 / 指令 / 专家 / 连接器 / 技能 的一等实体。
 * 项目内发起的任务自动继承全部上下文；专家与节点解耦（专家可在任意项目节点执行）。
 */
export interface Project {
  id: string
  name: string
  /** 项目 DSH 节点 */
  dshRef: DshRef
  /** 节点鉴权（direct 直连时可填） */
  apiKey?: string
  /** 项目工作目录（会话 cwd 与工作区） */
  workspace?: string
  /** 项目指令（注入任务系统提示词最前） */
  instruction?: string
  /** 项目专家 */
  expertIds: string[]
  /** 连接器：'ssh:<资源id>' | 'map:<mappingId>' | 'app:<appId>' */
  connectorIds: string[]
  /** 项目技能（以 /名 手势自动加载） */
  skillNames: string[]
  createdAt: number
  updatedAt: number
}

// ---------- 任务会话（多轮） ----------

export type TaskMode = 'chat' | 'orchestrate'
export type TaskStatus = 'draft' | 'running' | 'completed' | 'failed' | 'partial_success' | 'success' | 'cancelled'

export interface TaskSessionBinding {
  remoteSessionId: string
  baseUrl: string
  /** 建会话时使用的工作目录（用于检测 agent.workDir 变更后重建会话） */
  cwd?: string
  /** 主智能体最后一次对齐到会话的主调度模型（planner.model，空串=默认）；用于检测切换后重新对齐 */
  plannerModel?: string
  /** 最后一次经 PUT /sessions/:id/permission 原生下发成功的运行权限 preset；与期望不一致时重新下发 */
  permission?: string
  createdAt: number
}


export interface TaskTurn {
  id: string
  seq: number
  role: 'user' | 'agent' | 'system'
  agentId?: string
  agentName?: string
  text: string
  /** 执行中的排队消息：当前轮结束后自动补发（立即发送/插话后清除） */
  queued?: boolean
  reasoning?: string
  /** 本轮工具调用过程（对齐 DSH ui-chat 的 turn-process 展示） */
  tools?: TurnToolCall[]
  /** 本轮远端返回的真实 token 账本（含缓存命中），供前端展示缓存率 */
  usage?: Record<string, number>
  streaming?: boolean
  subtaskIds?: string[]
  at: number
}

export interface TurnToolCall {
  id: string
  name: string
  /** 参数摘要（字符串，截断） */
  args?: string
  /** 结果摘要（字符串，截断） */
  result?: string
  status: 'running' | 'done' | 'error'
  at: number
  /** 耗时 ms（结果到达时计算） */
  ms?: number
}

export interface PlanSubtask {
  id: string
  title: string
  prompt: string
  agentId: string
  dependsOn: string[]
  /** 一句话目标（规划器产出，进派工任务合同） */
  objective?: string
  /** 验收标准清单（规划器产出，进派工任务合同；执行者末尾须逐条对照） */
  acceptance?: string[]
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  remoteSessionId?: string
  result?: { content: string; reasoning?: string }
  error?: string
  logs: SubtaskLogEntry[]
  startedAt?: number
  completedAt?: number
}

export interface TaskPlan {
  strategy: 'parallel' | 'sequential' | 'dag'
  plannerModel?: string
  createdAt: number
  subtasks: PlanSubtask[]
}

export interface TaskSummary {
  status: 'success' | 'partial_success' | 'failed'
  overview: string
  subtaskSummaries: Array<{ id: string; title: string; status: string; keyPoints: string }>
  finalConclusion: string
  completedAt: number
  /** 成员返回覆盖度（移植 dsh-agency-agents coverage）：只代表返回覆盖情况，不代表结论已通过验证 */
  coverage?: TaskCoverage
}

/** 成员返回覆盖度：逐成员职责对照缺失归因（五段回传核对由主调度按合同执行） */
export interface TaskCoverage {
  status: 'complete' | 'partial' | 'failed'
  completed: number
  total: number
  missing: Array<{ id: string; name: string; duty?: string; error?: string }>
}

export interface WorkTask {
  id: string
  title: string
  mode: TaskMode
  status: TaskStatus
  memberAgentIds: string[]
  /** 创建者（'tool' = AI 工具通道 / 'console' = 控制台人工）。工具通道显式指定的成员受保护，不被主智能体改写 */
  creator?: 'tool' | 'console'
  /** 最近一轮的路由模式：明确 @ 单人时为 direct（定向直通），无 @ 主会话为 chat+source=node（节点直发） */
  lastRoute?: { kind: 'direct' | 'orchestrate' | 'chat'; agentId?: string; agentName?: string; source?: 'member' | 'main' | 'project' | 'node' }
  turns: TaskTurn[]
  /** 任务级引擎日志（规划器结果/成员问题/会话创建等，持久化） */
  taskLogs?: SubtaskLogEntry[]
  /** (taskId, subAgentId) → 远端长持会话（D3 会话长持） */
  sessions: Record<string, TaskSessionBinding>
  plan?: TaskPlan
  summary?: TaskSummary
  createdAt: number
  updatedAt: number
  /** 归档时间戳（参考 DSH web 归档语义：仅从列表隐藏，不影响数据与继续对话） */
  archivedAt?: number
  /** 会话附件（上传到各成员远端工作区后的登记） */
  attachments?: TaskAttachment[]
  /** 由定时任务派生时记录来源（调度删除/滚动出窗口后类型标识仍可恢复） */
  scheduleId?: string
  scheduleName?: string
  /** 所属项目：任务继承项目的节点/工作区/指令/专家/连接器/技能 */
  projectId?: string
  /** 单独任务直接指定的执行节点（项目任务走项目节点） */
  nodeRef?: DshRef
  /** 任务级模型（provider/model）：定时任务实例配置；主会话（__node__）优先于全局调度模型 */
  model?: string
  /** 任务级推理强度（配合 model 使用；无会话时的落点，建会话时随 createPayload 透传） */
  reasoningEffort?: string
  /** 任务级模式预设 agentPreset（聊天窗切换的持久化落点）：建会话时优先于智能体实体默认 */
  agentPreset?: string
  /** 任务级运行权限（如 danger-full-access / workspace-write / ask）：派发时注入提示词，优先于智能体实体默认 */
  permission?: string
  /** 执行中的排队消息（轮次结束自动补发；「立即发送」= steer 插话到运行中回合）；teamId = 排队消息携带的专家团意图 */
  queue?: Array<{ text: string; at: number; turnId: string; teamId?: string }>
  /** 任务级连接器覆盖（单独任务临时加挂） */
  connectorIds?: string[]
  /** 任务级技能覆盖（单独任务临时加挂） */
  skillNames?: string[]
  /** 专家团任务来源：记录创建团队，编排/派工/汇总按团队合同注入 */
  teamId?: string
  /** 专家库动态成员（expert-<expertId> → 展示名）：编排启动时登记，供花名册/子任务/轨迹解析成员名，不落子智能体实体 */
  expertMembers?: Array<{ id: string; name: string }>
  /** 挂起的 ask_user_question 提问：远端 run 悬停在工具内部等待答复（会话状态恒 running、后续 prompt 经 followup 排队永不被处理）。
   *  用户下一条自由文本消息将被路由到 /answers 桥作为答复解锁，而不是发新 prompt。 */
  pendingAsk?: {
    agentId: string
    sessionId: string
    batchId?: string
    questions: Array<Record<string, any>>
    turnId: string
    at: number
  }
}

export interface TaskAttachment {
  /** 落盘文件名（可能与上传名不同：同名去重后缀） */
  name: string
  /** 成员远端工作区中的绝对路径 */
  path: string
  size: number
  mimeType?: string
  agentId: string
  agentName: string
  remoteSessionId: string
  uploadedAt: number
}

// ---------- 定时任务 ----------

/**
 * 触发规则（简单规则优先，Host 本地时区）：
 *  daily    每天 fixed 时刻（可多个，HH:mm）
 *  weekly   每周勾选星期（0=周日）+ 时刻 HH:mm
 *  hourly   每小时的第 N 分（0-59）
 *  monthly  每月勾选日期（1-31，当月不存在的日期自动跳过）+ 时刻 HH:mm
 *  interval 每 N 分钟
 *  once     指定时刻一次性（触发后自动停用）
 */
export type ScheduleRule =
  | { kind: 'daily'; times: string[] }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'hourly'; minute: number }
  | { kind: 'monthly'; days: number[]; time: string }
  | { kind: 'interval'; minutes: number }
  | { kind: 'once'; at: number }

/** 一次触发中单个子智能体的派发结果 */
export interface ScheduleRunItem {
  agentId: string
  agentName: string
  /** 派发生成的任务会话（可回看流式过程与产出） */
  taskId?: string
  taskTitle?: string
  error?: string
  /** 实际尝试的次数（含失败重试）；成功时 ≥1，失败时 = 重试上限 */
  attempts?: number
}

/** 一次触发记录 */
export interface ScheduleRun {
  id: string
  triggeredAt: number
  /** true = 手动「立即执行」 */
  manual?: boolean
  /** 整次触发（全部目标派发完成）耗时毫秒 */
  durationMs?: number
  items: ScheduleRunItem[]
}

/** 内置定时任务模板（一键创建：预填名称/描述/任务文本/规则，可再改） */
export interface ScheduleTemplate {
  id: string
  name: string
  icon?: string
  description: string
  message: string
  rule: ScheduleRule
}

export interface ScheduledTask {
  id: string
  name: string
  description?: string
  /** 目标子智能体（一个或多个；触发时各自独立建会话派发同一份任务文本）。新模型下可空：任务在节点上直发，@ sub agent 写在指令里 */
  agentIds: string[]
  /** 主 DSH 节点（mappingId）：新模型下任务在该节点上直发；为空时回退首个 agentIds 的绑定节点（存量兼容） */
  nodeMappingId?: string
  /** 实例级模型（provider/model，可选）：留空跟随全局调度模型；无人值守任务建议固定为稳定模型 */
  model?: string
  /** 固定任务文本（触发时原样派发） */
  message: string
  rule: ScheduleRule
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  /** 下次触发时间戳（Host 本地时区计算；停用时为空；错过的触发点不补跑） */
  nextRunAt?: number
  /** 触发历史（新→旧，最多保留 50 条） */
  runs: ScheduleRun[]
  /** 历史触发总次数（含手动；不受 runs 50 条滚动窗口影响） */
  totalRuns?: number
  /** 其中至少派发成功一个子智能体的次数 */
  successRuns?: number
}

export interface SubtaskLogEntry {
  ts: number
  level: 'info' | 'warn' | 'error' | 'tool'
  msg: string
}

// ---------- 引擎事件（SSE 网关转发给聊天窗口） ----------

export type TaskEvent =
  | { type: 'turn_start'; turn: TaskTurn }
  | { type: 'turn_delta'; turnId: string; delta: string; seq: number }
  | { type: 'turn_reasoning'; turnId: string; delta: string; seq: number }
  | { type: 'turn_tool'; turnId: string; tool: TurnToolCall; seq: number }
  | { type: 'turn_usage'; turnId: string; usage: Record<string, number>; seq: number }
  | { type: 'turn_end'; turn: TaskTurn }
  | { type: 'plan_update'; plan: TaskPlan }
  | { type: 'subtask_status'; subtask: PlanSubtask }
  | { type: 'log'; subtaskId?: string; level: SubtaskLogEntry['level']; msg: string }
  | { type: 'task_status'; status: TaskStatus }
  | { type: 'task_end'; task: WorkTask }

/** 单个流式内容块（对齐 DSH ui-chat 的 assistant block 序列；按流式到达顺序排列） */
export type StreamBlock =
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; tool: TurnToolCall }
  | { kind: 'text'; text: string }

// ---------- 存储 ----------

export interface WorkBuddySettings {
  onenat: {
    baseUrl: string
    apiKey: string
    autoRefreshMs: number
  }
  planner: {
    /** 主任务拆解调用的子智能体；空 = 自动挑选（优先本地子智能体，否则列表第一个） */
    agentId?: string
    /** 主调度模型（provider/model-id，透传 /chat/completions 的 model 选择；聊天窗可选） */
    model?: string
  }
  /** 小智语音助手 MCP 接入（桥接客户端把工具通道注册为小智 MCP 工具，支持多平台实例） */
  xiaozhi?: {
    /** 旧版单接入点（已迁移到 endpoints） */
    endpoint?: string
    /** 接入点列表 */
    endpoints?: XiaozhiEndpoint[]
  }
}

/** 一个小智平台 MCP 接入点 */
export interface XiaozhiEndpoint {
  id: string
  name?: string
  /** MCP 接入点 WebSocket 地址（ws:// / wss://，平台「MCP 插件」页可查） */
  endpoint: string
  enabled: boolean
}

export interface StorageData {
  agents: SubAgent[]
  tasks: WorkTask[]
  schedules: ScheduledTask[]
  projects: Project[]
  teams: ExpertTeam[]
  settings: WorkBuddySettings
}

// ---------- 专家团（合同式团队配置，移植 dsh-agency-agents ExpertTeam） ----------

/** 专家团成员：引用已有子智能体（agentId）或专家库角色（expertId）+ 团队内的分工（对齐 dsh-agent-teams Member.role） */
export interface ExpertTeamMember {
  /** 子智能体成员：既有实体，在其绑定节点执行 */
  agentId?: string
  /** 专家库成员：编排时动态实例化在任务发起节点（主 DSH），persona 用专家档案提示词，不落持久实体 */
  expertId?: string
  /** 职责边界一句话：进规划花名册与派工提示词「职责边界」 */
  duty: string
  /** 执行指示：角色专属工作方法与产出结构（仅团队任务派工时注入） */
  instructions?: string
}

/** 专家库动态成员在任务账本中的伪 agentId 前缀（<前缀><expertId>），与 teamMemberKey 同源 */
export const EXPERT_AGENT_ID_PREFIX = 'expert-'

/** 团队成员的稳定键：子智能体用 agentId；专家库成员用合成 pseudo id（expert-<expertId>），与编排花名册/子任务 agentId 同源 */
export function teamMemberKey(m: Pick<ExpertTeamMember, 'agentId' | 'expertId'>): string {
  return m.agentId ? m.agentId : `${EXPERT_AGENT_ID_PREFIX}${m.expertId}`
}

/**
 * 专家团：目标/约束/交付要求 + 成员分工的合同式配置。
 * 编排时注入 Planner 花名册与主调度规则、派工提示词与汇总核对；
 * 成员引用子智能体 id 或专家库 id —— 删除子智能体时由 store 级联摘除 agentId 成员。
 */
export interface ExpertTeam {
  id: string
  name: string
  description?: string
  /** 共同目标（注入每个成员的派工提示词与主调度规划） */
  goal: string
  /** 共同约束（可空） */
  constraints?: string
  /** 共同交付要求（可空） */
  deliveryRequirements?: string
  /** 2~8 名成员；成员键（agentId / expertId）不得重复 */
  members: ExpertTeamMember[]
  /** 主理人补充规则（注入规划与汇总提示词；空 = 仅默认协作规范） */
  coordinatorPrompt?: string
  /** 领域主理人模板（对齐 dsh-agency-agents coordinatorTemplateId）：决定规划准备材料、验收清单与专属汇总规范 */
  templateId?: TeamTemplateId
  /** 内置团（随版本种子提供，只读，可复制为自定义） */
  builtin?: boolean
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** 领域主理人模板标识（general = 通用兜底） */
export type TeamTemplateId = 'general' | 'product' | 'technical' | 'content' | 'data' | 'research'
