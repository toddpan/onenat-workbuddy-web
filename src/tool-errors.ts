/** Channel-independent business error contract. Never infer categories from human text. */
export interface Recovery {
  kind: 'correct_parameters' | 'poll' | 'call' | 'stop' | 'authenticate'
  tool?: string
  arguments?: Record<string, unknown>
  delayMs?: number
  fields?: string[]
}
export interface ErrorContext { tool?: string; args?: Record<string, any> }

const readActions = new Set(['list', 'get', 'search', 'view', 'overview', 'events', 'history', 'task', 'config', 'projects', 'resolve', 'dsh', 'preview', 'models', 'presets', 'options', 'preflight', 'wait', 'download'])
export function isReadOnlyToolCall(tool = '', args: Record<string, any> = {}): boolean {
  if (tool === 'workbuddy_task_status') return true
  if (tool === 'workbuddy_task_chat') return !args.followupMessage
  if (!tool) return false
  return readActions.has(args.action)
}

export function errorCategory(code: string, status?: number): string {
  if (['INVALID_PARAM', 'INVALID_PARAMS', 'CHAT_TARGET_REQUIRED', 'PROJECT_FILE_TARGET'].includes(code)) return 'INVALID_PARAM'
  if (code === 'SESSION_EXPIRED' || code === 'SESSION_NOT_FOUND' || code === 'NO_SESSION') return 'SESSION_EXPIRED'
  if (code === 'AUTH_REQUIRED' || code === 'UNAUTHORIZED' || status === 401) return 'AUTH_REQUIRED'
  if (['PERMISSION_DENIED', 'FORBIDDEN', 'WORKSPACE_ROOT_PROTECTED', 'PROJECT_FILES_FORBIDDEN', 'NODE_FILES_FORBIDDEN'].includes(code) || status === 403) return 'PERMISSION_DENIED'
  if (code === 'NODE_OFFLINE' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 'NODE_OFFLINE'
  if (code.endsWith('NOT_FOUND') || code === 'NOT_FOUND' || (!code && status === 404)) return 'NOT_FOUND'
  if (!code && status === 400) return 'INVALID_PARAM'
  return code || 'EXECUTION_FAILED'
}

/** Strip credential-shaped properties and common inline authorization secrets from failures. */
function redactFailure(value: any, key = ''): any {
  if (/^(apiKey|password|privateKey|passphrase|authorization|accessToken|refreshToken|token|cookie|set-cookie)$/i.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return value.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]').replace(/\b(?:onk-|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/([?&](?:token|apiKey|api_key|key)=)[^&\s]+/gi, '$1[REDACTED]').replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@')
  if (Array.isArray(value)) return value.map(v => redactFailure(v))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactFailure(v, k)]))
  return value
}

export function toolFailure(code: string, message: string, extra: Record<string, any> = {}): Record<string, any> {
  return normalizeToolResult({ ...extra, ok: false, code, message, error: message })
}

export function normalizeToolResult(result: Record<string, any>, context: ErrorContext = {}): Record<string, any> {
  const out = { ...result }
  const args = context.args || {}
  const taskId = out.taskId || out.task?.id || args.taskId
  const poll = (tool: string, callArgs: Record<string, unknown>): Recovery => ({ kind: 'poll', tool, arguments: callArgs, delayMs: 2000 })
  // Structured receipts always point at reads; never replay create/send/dispatch/followup.
  if (!out.recovery && taskId && (out.taskCreated || out.ok !== false && (out.accepted || out.deduped || out.running || out.timedOut || out.followup?.status === 'running'))) {
    out.recovery = context.tool === 'workbuddy_task_chat'
      ? poll('workbuddy_task_chat', { taskId, ...(out.agentId || args.subtaskId ? { subtaskId: out.agentId || args.subtaskId } : {}) })
      : poll('workbuddy_task_status', { taskId })
  }
  if (out.ok !== false) return out
  const original = typeof out.code === 'string' ? out.code : undefined
  const code = original === 'INVALID_PARAMS' ? 'INVALID_PARAM' : original || errorCategory('', out.status) || 'EXECUTION_FAILED'
  out.code = code
  if (original === 'INVALID_PARAMS') out.legacyCode = original
  out.category = errorCategory(code, out.status)
  out.message = typeof out.message === 'string' ? out.message : typeof out.error === 'string' ? out.error : '工具执行失败'
  out.error = out.message // Legacy clients still consume error.
  if (!out.field && Array.isArray(out.errors) && out.errors[0]?.path) out.field = out.errors[0].path
  const readOnly = isReadOnlyToolCall(context.tool, args)
  // An unknown write outcome is never safe to auto-replay. Even explicit retryable is bounded.
  out.retryable = !out.taskCreated && readOnly && out.retryable !== false && (out.retryable === true || out.category === 'NODE_OFFLINE')
  if (out.retryable) out.retryAfterMs = Number.isFinite(out.retryAfterMs) && out.retryAfterMs >= 0 ? out.retryAfterMs : 2000
  else delete out.retryAfterMs
  if (!out.recovery) {
    if (out.category === 'INVALID_PARAM') out.recovery = { kind: 'correct_parameters', ...(context.tool ? { tool: context.tool } : {}), fields: Array.isArray(out.errors) ? [...new Set(out.errors.map((e: any) => e.path).filter(Boolean))] : out.field ? [out.field] : [] }
    else if (['AUTH_REQUIRED', 'SESSION_EXPIRED'].includes(out.category)) out.recovery = { kind: 'authenticate' }
    else if (out.retryable && context.tool) {
      // IDs and read controls only: never reflect arbitrary inputs or credentials into recovery.
      const safe = Object.fromEntries(['action', 'taskId', 'projectId', 'agentId', 'subtaskId', 'resourceId', 'mappingId', 'scheduleId', 'teamId', 'expertId'].filter(k => typeof args[k] === 'string').map(k => [k, args[k]]))
      out.recovery = poll(context.tool, safe)
    } else out.recovery = { kind: 'stop' }
  }
  return redactFailure(out)
}
