/** Pure action ceilings shared by discovery and execution. Object ACLs remain mandatory. */
import { toolInputSchema } from './tool-contracts.js'

export interface ToolPolicyContext {
  aiTokenOnly?: boolean
  session?: { userId?: string; role?: 'admin' | 'user' }
  readOnly?: boolean
}
export interface ToolActionPolicy {
  allowed: boolean
  action: string
  risk: string[]
  reason?: string
}
export interface ToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

/** This is a ceiling, never an object permission grant or an argument validator. */
export const TOOL_POLICY_SCOPE = 'Action-level ceiling only; object ACLs and argument validation may further deny access.'

type Rules = Record<string, readonly string[]>
// Explicit allowlist: adding an action to a contract alone cannot authorize it.
const rules: Record<string, Rules> = {
  workbuddy_resource_manage: { list: ['read', 'refresh'], dsh: ['read', 'refresh'], resolve: ['read', 'refresh'], refresh: ['refresh'] },
  workbuddy_agent_manage: { projects: ['read'], link_project: ['write', 'global-management'], unlink_project: ['write', 'global-management'], list: ['read'], upsert: ['write', 'global-management'], delete: ['write', 'destructive', 'global-management'], ping: ['probe'], preview: ['read', 'refresh', 'probe'], models: ['read', 'probe'], presets: ['read', 'probe'], enable: ['write', 'global-management'], disable: ['write', 'global-management'] },
  workbuddy_task_manage: { list: ['read'], preflight: ['read'], create: ['write', 'execute'], send: ['write', 'execute'], wait: ['read'], delete: ['write', 'destructive'], members: ['write'], cancel: ['write', 'execute'] },
  workbuddy_task_status: { query: ['read'] },
  workbuddy_task_chat: { read: ['read'], followup: ['write', 'execute'] },
  // Conservatively retain the advertised write semantics even if a version returns stored summaries.
  workbuddy_task_evaluate: { evaluate: ['write'] },
  workbuddy_task_ask_answer: { answer: ['write', 'execute'] },
  workbuddy_ssh_resource_manage: { list: ['read'], get: ['read', 'credentials'], upsert: ['write', 'global-management'], delete: ['write', 'destructive', 'global-management'], test: ['probe', 'write'], exec: ['execute', 'destructive'] },
  // 协作群（契约 §3）：读写档只分 read/write/delete；群数据按登录用户隔离，AI 令牌（无身份）全 action 拒绝（见 toolActionPolicy）
  workbuddy_group_manage: { list: ['read'], get: ['read'], sections: ['read'], rounds: ['read'], create: ['write'], update: ['write'], add_section: ['write'], rename_section: ['write'], remove_section: ['write'], add_round: ['write'], mark_read: ['write'], delete: ['write', 'destructive'] },
  workbuddy_monitor_read: { overview: ['read'], events: ['read'], history: ['read'], task: ['read'] },
  workbuddy_schedule_manage: { list: ['read'], get: ['read'], upsert: ['write', 'global-management'], delete: ['write', 'destructive', 'global-management'], toggle: ['write', 'global-management'], run: ['write', 'execute', 'global-management'] },
  workbuddy_planner_manage: { get: ['read'], set: ['write', 'global-management'], options: ['read', 'probe'] },
  workbuddy_file_manage: { list: ['read'], mkdir: ['write'], upload: ['write', 'upload'], download: ['read', 'download'], delete: ['write', 'destructive'], upload_resumable_init: ['write', 'upload', 'credentials'], upload_register: ['write', 'upload'] },
  workbuddy_project_manage: { agents: ['read'], link_agent: ['write', 'global-management'], unlink_agent: ['write', 'global-management'], list: ['read'], get: ['read'], upsert: ['write', 'global-management'], delete: ['write', 'destructive', 'global-management'] },
  workbuddy_expert_manage: { list: ['read'], get: ['read'], search: ['read'], create: ['write', 'global-management'], update: ['write', 'global-management'], delete: ['write', 'destructive', 'global-management'] },
  workbuddy_team_manage: { list: ['read'], get: ['read'], upsert: ['write', 'global-management'], delete: ['write', 'destructive', 'global-management'], toggle: ['write', 'global-management'] },
  workbuddy_backlog_manage: { projects: ['read'], config: ['read'], init: ['write'], list: ['read'], search: ['read'], view: ['read'], create: ['write'], edit: ['write'], delete: ['write', 'destructive'], dispatch: ['write', 'execute'], overview: ['read'], 'retry-writeback': ['write'] },
  workbuddy_capabilities: { query: ['read'] },
}
const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)
const objectArgs = (input: unknown): Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}

/** Contract actions, or semantic actions for tools without an action parameter. Fresh array. */
export function toolActions(name: string): string[] {
  if (!own(rules, name)) return []
  if (name === 'workbuddy_capabilities') return ['query']
  const actions = toolInputSchema(name).properties?.action?.enum
  return actions ? actions.filter((value): value is string => typeof value === 'string') : Object.keys(rules[name])
}

function effectiveAction(name: string, args: Record<string, unknown>): string {
  if (name === 'workbuddy_task_chat') return args.followupMessage ? 'followup' : 'read'
  const actions = toolActions(name)
  const schemaActions = name !== 'workbuddy_capabilities' && own(rules, name) ? toolInputSchema(name).properties?.action?.enum : undefined
  if (!schemaActions) return actions[0] || ''
  // Match validated legacy defaults, but do not trim/case-fold a supplied unknown action.
  return args.action === undefined || args.action === null || args.action === '' ? actions[0] || '' : typeof args.action === 'string' ? args.action : String(args.action)
}

/**
 * Caller context must come from the authenticated channel, never tool arguments.
 * Existing AI write scope is retained; SSH plaintext/exec remain forbidden for AI tokens.
 * Global management is labelled for audit, while existing console/object ACLs still apply.
 */
export function toolActionPolicy(name: string, input: unknown = {}, ctx: ToolPolicyContext = {}): ToolActionPolicy {
  const args = objectArgs(input)
  const action = effectiveAction(name, args)
  const deny = (risk: string[], reason: string): ToolActionPolicy => ({ allowed: false, action, risk, reason })
  if (!own(rules, name)) return deny(['unknown'], 'Unknown tool')
  const actions = toolActions(name)
  if (!actions.includes(action) || !own(rules[name], action)) return deny(['unknown'], 'Unknown action')
  // Fixed-action tools also fail closed on unexpected action fields rather than ignoring them.
  if (!toolHasActionParameter(name) && args.action !== undefined && args.action !== action) return deny(['unknown'], 'Unknown action')
  const risk = [...rules[name][action]]
  // Full status can mint a signed export credential and append an audit log.
  if (name === 'workbuddy_task_status' && String(args.detail || 'summary') === 'full') risk.push('credentials', 'write')
  if (ctx.aiTokenOnly && name === 'workbuddy_ssh_resource_manage' && ['get', 'exec'].includes(action)) return deny(risk, 'AI tokens cannot reveal SSH credentials or execute SSH commands')
  // 群数据按登录用户 scope（v1 无共享桶）：AI 令牌拿不到 userId，全部 action（含只读）一律拒绝，防互见互改（P5/裁定④）
  if (ctx.aiTokenOnly && name === 'workbuddy_group_manage') return deny(risk, 'AI tokens cannot access groups; group data is scoped to individual console users')
  if (ctx.readOnly && (!risk.includes('read') || risk.some(value => !['read', 'download'].includes(value)))) return deny(risk, 'Read-only credentials allow only conservative read actions')
  return { allowed: true, action, risk }
}

function toolHasActionParameter(name: string): boolean {
  return name !== 'workbuddy_capabilities' && own(rules, name) && Boolean(toolInputSchema(name).properties?.action)
}

/** Discover action ceilings. Conditional actions use their riskiest representative arguments. */
export function toolActionRisks(name: string, ctx: ToolPolicyContext = {}): ToolActionPolicy[] {
  return toolActions(name).map(action => toolActionPolicy(name,
    name === 'workbuddy_task_chat' ? (action === 'followup' ? { followupMessage: '<message>' } : {}) : { action }, ctx))
}

/** MCP annotations describe the entire tool, not the least risky branch or current caller. */
export function toolAnnotations(name: string): ToolAnnotations {
  const risks = toolActionRisks(name).flatMap(policy => policy.risk)
  // Status's full branch can issue a credential; chat has an executable followup branch.
  const readOnlyHint = risks.length > 0 && risks.every(risk => ['read', 'download'].includes(risk)) && name !== 'workbuddy_task_status'
  return {
    readOnlyHint,
    destructiveHint: !own(rules, name) || risks.includes('destructive'),
    idempotentHint: readOnlyHint,
    openWorldHint: !own(rules, name) || !['workbuddy_capabilities', 'workbuddy_expert_manage', 'workbuddy_team_manage'].includes(name),
  }
}
