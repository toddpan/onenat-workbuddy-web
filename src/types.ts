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
  cleanText: string
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
  createdAt: number
}


export interface TaskTurn {
  id: string
  seq: number
  role: 'user' | 'agent' | 'system'
  agentId?: string
  agentName?: string
  text: string
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
}

export interface WorkTask {
  id: string
  title: string
  mode: TaskMode
  status: TaskStatus
  memberAgentIds: string[]
  /** 最近一轮的路由模式：明确 @ 单人时为 direct（定向直通），否则为编排/默认 */
  lastRoute?: { kind: 'direct' | 'orchestrate' | 'chat'; agentId?: string; agentName?: string }
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
  /** 目标子智能体（一个或多个；触发时各自独立建会话派发同一份任务文本） */
  agentIds: string[]
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
  settings: WorkBuddySettings
}
