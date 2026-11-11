/** Shared, dependency-free contracts for HTTP, MCP and model-facing tool definitions.
 * Structural checks only: existence, permissions and stored-state validation stay in business code.
 */
export interface ToolInputSchema extends Record<string, unknown> {
  type: string | string[]
  properties?: Record<string, ToolInputSchema>
  required?: string[]
  items?: ToolInputSchema
  enum?: Array<string | number | boolean>
  description?: string
  additionalProperties?: boolean
  minItems?: number
  maxItems?: number
  minimum?: number
  maximum?: number
}
export interface ToolArgError { path: string; message: string }
export interface ToolArgValidation { args: Record<string, any>; errors: ToolArgError[]; warnings: string[] }
type Parameters = Record<string, { type: string; description: string }>
// Internal flags describe legacy input forms, not extra JSON Schema keywords.
interface Field extends ToolInputSchema {
  properties?: Record<string, Field>
  items?: Field
  legacyList?: boolean
  legacyText?: boolean
  nullable?: boolean
}
const text = (description?: string): Field => ({ type: 'string', ...(description ? { description } : {}) })
const choice = (...values: string[]): Field => ({ type: 'string', enum: values })
const number = (minimum?: number, maximum?: number): Field => ({ type: 'number', ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) })
const integer = (minimum?: number, maximum?: number): Field => ({ ...number(minimum, maximum), type: 'integer' })
const bool = (): Field => ({ type: 'boolean' })
const array = (items: Field = text(), minItems?: number, maxItems?: number): Field => ({ type: 'array', items, ...(minItems === undefined ? {} : { minItems }), ...(maxItems === undefined ? {} : { maxItems }) })
const list = (): Field => ({ ...array(), legacyList: true, description: '字符串数组；兼容旧字符串单值或逗号分隔值。' })
const object = (properties: Record<string, Field>, required: string[] = []): Field => ({ type: 'object', properties, required, additionalProperties: true })
const nullable = (f: Field): Field => ({ ...f, type: [String(f.type), 'null'], nullable: true })
const strings = (...keys: string[]): Record<string, Field> => Object.fromEntries(keys.map(k => [k, text()]))
const ref = (): Field => object({ kind: choice('mapping', 'app', 'direct'), ...strings('mappingId', 'appId', 'apiBaseUrl') }, ['kind'])
const binding = object({ ref: ref(), ...strings('alias', 'note'), credentialMode: choice('inline', 'self-fetch', 'omit'), skillMode: { ...object({ names: array() }), type: ['string', 'object'], description: 'all / none 或 {names:[技能名]}' } })
const agent = object({
  ...strings('id', 'name', 'apiBaseUrl', 'apiKey', 'agentPreset', 'permission', 'provider', 'model', 'reasoningEffort', 'systemPrompt', 'role', 'executionPrompt', 'workDir', 'description', 'ownerUserId'),
  dshRef: ref(), resources: array(binding), skills: array(), tags: array(), sharedProjectIds: array(), enabled: bool(),
})
const project = object({ ...strings('id', 'name', 'apiKey', 'workspace', 'instruction'), dshRef: ref(), defaultExecutionNodeRef: nullable(ref()), defaultAgentIds: array(), expertIds: array(), connectorIds: array(), skillNames: array() })
const rule = object({ kind: choice('daily', 'weekly', 'hourly', 'monthly', 'interval', 'once'), times: array(), days: array(integer()), time: text(), minute: integer(0, 59), minutes: integer(1, 43200), at: number() }, ['kind'])
const schedule = object({ ...strings('id', 'name', 'description', 'message'), agentIds: array(text(), 1), rule, enabled: bool() })
const resource = object({ ...strings('id', 'name', 'host', 'username', 'password', 'privateKey', 'passphrase', 'description', 'ownerUserId'), port: integer(1, 65535), authType: choice('password', 'key'), tags: array(), visibility: choice('private', 'shared') })
const expert = object({ ...strings('id', 'name', 'description', 'icon', 'division', 'systemPrompt', 'executionPrompt', 'role'), tags: array() })
const team = object({ ...strings('id', 'name', 'goal', 'description', 'constraints', 'deliveryRequirements', 'coordinatorPrompt'), templateId: choice('general', 'product', 'technical', 'content', 'data', 'research'), enabled: bool(), members: array(object(strings('agentId', 'expertId', 'duty', 'instructions'), ['duty']), 2, 8) })
// 协作群 GroupRoom：字段名与 Android GroupRoom JSON 逐字一致（契约 §1）；id/createdBy/createdAt 服务端权威，room 里传了也会被覆盖
const groupRoom = object({
  ...strings('id', 'name', 'notice', 'adminAgentId', 'channelRef', 'section', 'permissionOverride'),
  mode: choice('admin', 'everyone'), notifyLevel: choice('all', 'mention', 'mute'),
  memberAgentIds: array(), projectIds: array(),
  archived: bool(), unreadCount: integer(0), lastReadSeq: integer(0),
})
const item = object({
  ...strings('title', 'description', 'status', 'instruction'),
  priority: nullable(text()), dueDate: nullable(text()), type: nullable(text()), milestone: nullable(text()), taskProject: nullable(text()), parentTaskId: nullable(text()), ordinal: number(),
  labels: list(), assignees: list(), assignee: list(), dependencies: list(), acceptance: list(), acceptanceCriteria: list(), acceptanceCriteriaSet: list(), acceptAdd: list(), acceptanceCriteriaAdd: list(),
  note: { ...object({ title: text(), lines: list() }), type: ['object', 'string'], legacyText: true },
})
const filter = object({
  ...Object.fromEntries(['status', 'statuses', 'excludeStatus', 'exclude-status', 'excludeStatuses', 'assignee', 'assignees', 'priority', 'priorities', 'type', 'types', 'taskType', 'taskTypes', 'labels', 'label', 'taskProject', 'task-project', 'project', 'projects', 'projectIds', 'project-ids'].map(k => [k, list()])),
  ...Object.fromEntries(['unassigned', 'ready', 'blocked', 'isBlocked', 'includeDone', 'include-done', 'openOnly', 'open-only', 'count'].map(k => [k, bool()])),
  ...strings('milestone', 'parent', 'parentTaskId', 'search', 'q', 'query', 'sort', 'orderBy', 'order-by'),
  labelMatch: choice('all', 'any'), 'label-match': choice('all', 'any'), order: choice('asc', 'desc'), dir: choice('asc', 'desc'),
  limit: integer(1), maxCount: integer(1), 'max-count': integer(1), skip: integer(0),
})
interface Contract { fields: Record<string, Field>; required?: string[]; defaultAction?: string }
const actionContract = (actions: string[], fields: Record<string, Field>, defaultAction = 'list'): Contract => ({ fields: { action: { ...choice(...actions), description: `操作：${actions.join(' / ')}。各分支必填字段由运行时校验；省略兼容默认 ${defaultAction}。` }, ...fields }, required: ['action'], defaultAction })
const contracts: Record<string, Contract> = {
  workbuddy_capabilities: { fields: { resource: text('可选：读取能力发现返回的版本化操作资源 URI。') }, required: [] },
  workbuddy_resource_manage: actionContract(['list', 'dsh', 'resolve', 'refresh'], strings('mappingId')),
  workbuddy_agent_manage: actionContract(['list', 'upsert', 'delete', 'ping', 'preview', 'models', 'presets', 'enable', 'disable', 'projects', 'link_project', 'unlink_project'], { agent, agentId: text(), projectId: text() }),
  workbuddy_task_manage: actionContract(['list', 'preflight', 'create', 'send', 'wait', 'delete', 'members', 'cancel'], {
    ...strings('taskId', 'keyword', 'title', 'message', 'projectId', 'creatorAgentId', 'timeoutMs', 'limit', 'offset', 'status'),
    chatAgentId: text('create：持久绑定直聊 BOT，必须显式 mode="chat"；send：仅断言既有绑定，不可添加或换绑；preflight：预览或校验绑定。'),
    teamId: text('create/send/preflight 的显式专家团路由；与直聊硬绑定互斥。'),
    memberAgentIds: array(text()), mode: choice('chat', 'orchestrate'), nodeRef: ref(),
  }),
  workbuddy_task_status: { fields: { taskId: text('可省略以列出全部任务概览。'), detail: choice('summary', 'full') }, required: [] },
  workbuddy_task_chat: { fields: strings('taskId', 'subtaskId', 'followupMessage', 'maxMessages', 'maxTextChars', 'full'), required: ['taskId'] },
  workbuddy_task_evaluate: { fields: strings('taskId'), required: ['taskId'] },
  workbuddy_task_ask_answer: { fields: { ...strings('taskId', 'agentId'), answers: array(object({ id: text(), selected: array(), custom: text() }, ['id']), 1) }, required: ['taskId', 'answers'] },
  workbuddy_ssh_resource_manage: actionContract(['list', 'get', 'upsert', 'delete', 'test', 'exec'], { ...strings('resourceId', 'command', 'timeoutMs'), resource }),
  workbuddy_group_manage: actionContract(['list', 'get', 'create', 'update', 'delete', 'sections', 'add_section', 'rename_section', 'remove_section', 'rounds', 'add_round', 'mark_read'], {
    roomId: text('群 ID（get/update/delete/rounds/add_round/mark_read 用）。'),
    room: groupRoom,
    ...strings('name', 'old', 'to', 'taskId', 'compact'),
    lastReadSeq: integer(0),
  }),
  workbuddy_monitor_read: actionContract(['overview', 'events', 'history', 'task'], strings('limit', 'since', 'days', 'taskId', 'projectId', 'section', 'compact'), 'overview'),
  workbuddy_schedule_manage: actionContract(['list', 'get', 'upsert', 'delete', 'toggle', 'run'], { schedule, scheduleId: text() }),
  workbuddy_planner_manage: actionContract(['get', 'set', 'options'], strings('agentId', 'model'), 'get'),
  workbuddy_file_manage: actionContract(['list', 'mkdir', 'upload', 'download', 'delete', 'upload_resumable_init', 'upload_register'], { ...strings('agent', 'taskId', 'path', 'name', 'size', 'mimeType', 'uploadId', 'contentBase64', 'url', 'expectedSha256'), encoding: choice('auto', 'base64') }),
  workbuddy_project_manage: actionContract(['list', 'get', 'upsert', 'delete', 'agents', 'link_agent', 'unlink_agent'], { project, ...strings('projectId', 'agentId', 'name', 'workspace', 'keyword', 'limit', 'offset', 'compact') }),
  workbuddy_expert_manage: actionContract(['list', 'get', 'search', 'create', 'update', 'delete'], { ...strings('expertId', 'domain', 'skill', 'query', 'limit', 'offset'), expert }),
  workbuddy_team_manage: actionContract(['list', 'get', 'upsert', 'delete', 'toggle'], { team, teamId: text() }),
  workbuddy_backlog_manage: actionContract(['projects', 'config', 'init', 'list', 'search', 'view', 'create', 'edit', 'delete', 'dispatch', 'overview', 'retry-writeback'], { ...strings('projectId', 'itemId', 'taskId', 'force', 'sample', 'updateInstruction'), itemIds: array(), item, filter }),
}
export const WORKBUDDY_TOOL_NAMES: readonly string[] = Object.freeze(Object.keys(contracts))

function publicField(field: Field): ToolInputSchema {
  const { legacyList: _list, legacyText: _text, nullable: _nullable, properties, items, ...plain } = field
  return { ...plain, ...(properties ? { properties: Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, publicField(v)])) } : {}), ...(items ? { items: publicField(items) } : {}) }
}
/** Fresh schema on every call. Legacy parameter descriptions enrich the explicit contract.
 * Unknown tool names throw (registration errors must not silently publish an empty contract).
 */
export function toolInputSchema(name: string, parameters: Parameters = {}): ToolInputSchema {
  const contract = contracts[name]
  if (!contract) throw new Error(`Unknown tool contract: ${name}`)
  const properties = Object.fromEntries(Object.entries(contract.fields).map(([key, field]) => {
    const schema = publicField(field)
    const description = parameters[key]?.description
    if (description) schema.description = [description, schema.description].filter(Boolean).join(' ')
    return [key, schema]
  }))
  return { type: 'object', properties, required: [...(contract.required || [])], additionalProperties: true }
}
const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)
const present = (v: unknown): boolean => v !== undefined && v !== null && (typeof v !== 'string' || Boolean(v.trim()))

/** Normalize into a fresh object; never mutate caller input. Do not execute when errors is nonempty.
 * Unknown fields (including nested fields) are warned and dropped. Numeric/boolean scalar
 * top-level values become strings, preserving the existing business layer's string interface.
 * JSON strings for structured parameters remain accepted; arrays always leave as native arrays.
 */
export function validateToolArgs(name: string, input: unknown): ToolArgValidation {
  const result: ToolArgValidation = { args: {}, errors: [], warnings: [] }
  const { errors, warnings } = result
  const fail = (path: string, message: string) => { errors.push({ path, message }) }
  const contract = contracts[name]
  if (!contract) { fail('name', `未知工具：${name}`); return result }
  if (!isObject(input)) { fail('$', '工具参数必须是对象'); return result }
  const normalize = (value: any, field: Field, path: string): any => {
    if (value === undefined) return undefined
    if (value === null && field.nullable) return null
    const types = Array.isArray(field.type) ? field.type : [field.type]
    if ((types.includes('object') || types.includes('array')) && typeof value === 'string' && !field.legacyText && !field.legacyList && !(types.includes('string') && ['all', 'none'].includes(value))) {
      try { value = JSON.parse(value) } catch { fail(path, '必须是合法 JSON 对象/数组'); return undefined }
    }
    if (field.legacyList && typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.startsWith('[')) {
        try { value = JSON.parse(trimmed) } catch { fail(path, '必须是合法 JSON 数组'); return undefined }
      } else value = trimmed ? trimmed.split(',').map(v => v.trim()).filter(Boolean) : []
    }
    if (types.includes('array') && Array.isArray(value)) {
      if (field.minItems !== undefined && value.length < field.minItems) fail(path, `至少需要 ${field.minItems} 项`)
      if (field.maxItems !== undefined && value.length > field.maxItems) fail(path, `最多允许 ${field.maxItems} 项`)
      return value.map((v, i) => {
        if (field.items?.type === 'string' && typeof v !== 'string') { fail(`${path}[${i}]`, '数组项必须是字符串'); return undefined }
        return normalize(v, field.items || text(), `${path}[${i}]`)
      })
    }
    if (types.includes('object') && isObject(value)) {
      const out: Record<string, any> = {}
      for (const [key, v] of Object.entries(value)) {
        if (!Object.prototype.hasOwnProperty.call(field.properties || {}, key)) { warnings.push(`${path}.${key}: 未知参数，已忽略`); continue }
        out[key] = normalize(v, field.properties![key], `${path}.${key}`)
      }
      for (const key of field.required || []) if (!present(out[key])) fail(`${path}.${key}`, '必填字段')
      return out
    }
    if (types.includes('string') && (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean')) {
      const out = String(value)
      if (field.enum && !field.enum.includes(out)) fail(path, `可选值：${field.enum.join(' / ')}`)
      return out
    }
    if (types.includes('boolean')) {
      if (typeof value === 'boolean') return value
      if (typeof value === 'string' && /^(true|false|1|0|yes|no)$/i.test(value.trim())) return /^(true|1|yes)$/i.test(value.trim())
    }
    if (types.includes('number') || types.includes('integer')) {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
      if (Number.isFinite(n) && (!types.includes('integer') || Number.isInteger(n))) {
        if (field.minimum !== undefined && n < field.minimum) fail(path, `不能小于 ${field.minimum}`)
        if (field.maximum !== undefined && n > field.maximum) fail(path, `不能大于 ${field.maximum}`)
        return n
      }
    }
    fail(path, `类型错误，需要 ${types.join(' / ')}`)
    return undefined
  }
  for (const [key, value] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(contract.fields, key)) { warnings.push(`${key}: 未知参数，已忽略`); continue }
    result.args[key] = normalize(value, contract.fields[key], key)
  }
  const a = result.args
  if (contract.defaultAction && !present(a.action)) a.action = contract.defaultAction
  const need = (path: string) => {
    const v = path.split('.').reduce((o, k) => o?.[k], a)
    if (!present(v)) fail(path, '必填字段')
  }
  const needs = (...paths: string[]) => paths.forEach(need)
  for (const key of contract.required || []) need(key)
  const action = a.action
  const branch = (...actions: string[]) => actions.includes(action)
  const validateRef = (v: any, path: string) => {
    if (!isObject(v)) return
    const key = ({ mapping: 'mappingId', app: 'appId', direct: 'apiBaseUrl' } as Record<string, string>)[v.kind]
    if (key && !present(v[key])) fail(`${path}.${key}`, `kind=${v.kind} 时必填`)
  }
  const checkRefs = (v: any, path = '') => {
    if (Array.isArray(v)) { v.forEach((x, i) => checkRefs(x, `${path}[${i}]`)); return }
    if (!isObject(v)) return
    if (['dshRef', 'nodeRef', 'defaultExecutionNodeRef', 'ref'].some(k => path === k || path.endsWith(`.${k}`))) validateRef(v, path)
    for (const [k, x] of Object.entries(v)) checkRefs(x, path ? `${path}.${k}` : k)
  }
  checkRefs(a)
  switch (name) {
    case 'workbuddy_resource_manage': if (branch('resolve')) need('mappingId'); break
    case 'workbuddy_agent_manage':
      if (branch('upsert')) {
        needs('agent', 'agent.name')
        if (!a.agent?.apiBaseUrl) need('agent.dshRef')
      } else if (!branch('list')) need('agentId')
      if (branch('link_project', 'unlink_project')) need('projectId')
      if (a.agent?.resources) a.agent.resources.forEach((b: any, i: number) => {
        if (!isObject(b)) return
        if (!b.ref) fail(`agent.resources[${i}].ref`, '必填字段')
        if (typeof b.skillMode === 'string' && !['all', 'none'].includes(b.skillMode)) fail(`agent.resources[${i}].skillMode`, '可选值：all / none / {names:[]}')
      })
      break
    case 'workbuddy_task_manage':
      if (branch('send', 'wait', 'delete', 'members', 'cancel')) need('taskId')
      if (branch('send')) need('message')
      if (a.chatAgentId !== undefined) {
        if (typeof input.chatAgentId !== 'string' || !a.chatAgentId.trim() || a.chatAgentId !== a.chatAgentId.trim()) fail('chatAgentId', '必须是非空字符串 ID')
        if (!branch('create', 'send', 'preflight')) fail('chatAgentId', '仅 create/send/preflight 支持绑定参数')
        if ((branch('create') || branch('preflight') && !a.taskId) && a.mode !== 'chat') fail('mode', '新建直聊硬绑定必须显式 mode="chat"')
        if (a.mode !== undefined && a.mode !== 'chat') fail('mode', '直聊硬绑定仅支持 chat')
        if (a.teamId !== undefined) fail('teamId', '直聊硬绑定不可指定专家团')
        if (Array.isArray(a.memberAgentIds) && (a.memberAgentIds.length !== 1 || a.memberAgentIds[0] !== a.chatAgentId)) fail('memberAgentIds', '直聊成员仅可包含绑定的同一 ID')
      }
      if (branch('send') && (a.nodeRef !== undefined || a.projectId !== undefined)) fail(a.nodeRef !== undefined ? 'nodeRef' : 'projectId', 'send 不支持修改任务节点或项目；请创建新任务')
      if (branch('members')) { need('memberAgentIds'); if (Array.isArray(a.memberAgentIds) && !a.memberAgentIds.length) fail('memberAgentIds', '至少需要一个成员 ID') }
      if (Array.isArray(a.memberAgentIds)) a.memberAgentIds.forEach((id: any, i: number) => { if (typeof id !== 'string' || !id.trim()) fail(`memberAgentIds[${i}]`, '必须是非空字符串 ID') })
      break
    case 'workbuddy_ssh_resource_manage':
      if (branch('upsert')) {
        need('resource')
        if (!a.resource?.id) {
          needs('resource.name', 'resource.host', 'resource.username')
          need(a.resource?.authType === 'key' ? 'resource.privateKey' : 'resource.password')
        }
      } else if (!branch('list')) need('resourceId')
      if (branch('exec')) need('command')
      break
    case 'workbuddy_group_manage':
      if (branch('get', 'update', 'delete', 'rounds', 'add_round', 'mark_read')) need('roomId')
      if (branch('create')) need('room')
      if (branch('update') && !isObject(a.room)) fail('room', 'update 需要部分字段对象 room')
      if (branch('add_section', 'remove_section')) need('name')
      if (branch('rename_section')) needs('old', 'to')
      if (branch('add_round')) need('taskId')
      if (branch('mark_read')) need('lastReadSeq')
      break
    case 'workbuddy_monitor_read': if (branch('task')) need('taskId'); break
    case 'workbuddy_schedule_manage':
      if (branch('upsert')) {
        needs('schedule', 'schedule.name', 'schedule.agentIds', 'schedule.message', 'schedule.rule')
        const r = a.schedule?.rule
        if (isObject(r)) {
          const required: Record<string, string[]> = { daily: ['times'], weekly: ['days', 'time'], hourly: ['minute'], monthly: ['days', 'time'], interval: ['minutes'], once: ['at'] }
          for (const key of required[r.kind] || []) need(`schedule.rule.${key}`)
          for (const key of ['days', 'times']) if (Array.isArray(r[key]) && !r[key].length) fail(`schedule.rule.${key}`, '至少需要一项')
          const hhmm = (v: any) => typeof v === 'string' && /^(\d|1\d|2[0-3]):[0-5]\d$/.test(v.trim())
          if (r.time !== undefined && !hhmm(r.time)) fail('schedule.rule.time', '需要合法 HH:mm')
          if (Array.isArray(r.times)) r.times.forEach((v: any, i: number) => { if (!hhmm(v)) fail(`schedule.rule.times[${i}]`, '需要合法 HH:mm') })
          if (Array.isArray(r.days)) r.days.forEach((v: number, i: number) => { if (v < (r.kind === 'monthly' ? 1 : 0) || v > (r.kind === 'monthly' ? 31 : 6)) fail(`schedule.rule.days[${i}]`, r.kind === 'monthly' ? '日期范围 1–31' : '星期范围 0–6') })
          if (r.kind === 'once' && typeof r.at === 'number' && r.at <= Date.now()) fail('schedule.rule.at', '一次性规则需要未来的毫秒时间戳')
        }
      } else if (!branch('list')) need('scheduleId')
      break
    case 'workbuddy_planner_manage': if (branch('set') && a.agentId === undefined && a.model === undefined) fail('agentId', 'set 至少提供 agentId 或 model（允许空串恢复默认）'); break
    case 'workbuddy_file_manage':
      if (branch('upload_resumable_init', 'upload_register')) need('taskId')
      else if ((!present(a.agent) || a.agent === '__node__') && !present(a.taskId)) fail('taskId', '需要 agent（子智能体 ID）或 taskId')
      if (branch('mkdir', 'upload', 'upload_resumable_init')) need('name')
      if (branch('download', 'delete', 'upload_register')) need('path')
      if (branch('upload_register')) need('uploadId')
      if (branch('upload_resumable_init')) { need('size'); if (!(Number(a.size) > 0) || !Number.isFinite(Number(a.size)) || Number(a.size) > 2 * 1024 ** 3) fail('size', '需要 1–2GB 范围内的文件字节大小') }
      if (branch('upload') && !present(a.contentBase64) && !present(a.url)) fail('contentBase64', 'upload 需要 contentBase64 或 url')
      if (a.url !== undefined && !/^https?:\/\//i.test(a.url)) fail('url', '需要 http(s) URL')
      break
    case 'workbuddy_project_manage':
      if (branch('upsert')) { need('project'); if (!a.project?.id) needs('project.name', 'project.dshRef', 'project.workspace') }
      if (branch('get', 'delete', 'agents', 'link_agent', 'unlink_agent')) need('projectId')
      if (branch('link_agent', 'unlink_agent')) need('agentId')
      break
    case 'workbuddy_expert_manage':
      if (branch('get', 'delete')) need('expertId')
      if (branch('search')) need('query')
      if (branch('create', 'update')) needs('expert', 'expert.id')
      if (branch('create')) need('expert.systemPrompt')
      break
    case 'workbuddy_team_manage':
      if (branch('get', 'delete', 'toggle')) need('teamId')
      if (branch('upsert')) {
        needs('team', 'team.name', 'team.goal', 'team.members')
        if (Array.isArray(a.team?.members)) {
          const seen = new Set<string>()
          a.team.members.forEach((m: any, i: number) => {
            const path = `team.members[${i}]`
            if (!isObject(m)) return
            if (Boolean(present(m.agentId)) === Boolean(present(m.expertId))) fail(`${path}.agentId`, 'agentId 与 expertId 必须且只能提供一个')
            const key = m.agentId ? `agent:${m.agentId}` : `expert:${m.expertId}`
            if (seen.has(key)) fail(path, '成员重复')
            seen.add(key)
          })
        }
      }
      break
    case 'workbuddy_backlog_manage':
      if (!branch('projects', 'overview', 'retry-writeback')) need('projectId')
      if (branch('retry-writeback')) need('taskId')
      if (branch('view', 'edit', 'delete')) need('itemId')
      if (branch('create')) needs('item', 'item.title')
      if (branch('edit')) need('item')
      if (branch('search') && !present(a.filter?.search) && !present(a.filter?.q) && !present(a.filter?.query)) fail('filter.search', 'search 必填检索词')
      if (branch('dispatch') && !present(a.itemId) && !(Array.isArray(a.itemIds) && a.itemIds.length)) fail('itemId', 'dispatch 需要 itemId 或非空 itemIds')
      if (a.filter?.unassigned && (a.filter?.assignee?.length || a.filter?.assignees?.length)) fail('filter.assignee', 'assignee 与 unassigned=true 互斥')
      if (a.filter?.parent !== undefined && !present(a.filter.parent)) fail('filter.parent', 'parent 不能为空；省略表示不过滤')
      break
  }
  return result
}
