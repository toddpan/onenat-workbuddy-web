import type { SubAgent } from './types.js'

/** Display text is administrator-authored copy, never evidence of installed capabilities. */
export interface AgentDisplayConfig {
  expertise?: string
  welcomeMessage?: string
  quickActions?: AgentQuickAction[]
}

export interface AgentQuickAction {
  label: string
  text: string
}

export interface AgentDisplayProfile {
  id: string
  name: string
  description: string
  display: Required<AgentDisplayConfig>
}

export class AgentDisplayInputError extends Error {}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentDisplayInputError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: string[], field: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new AgentDisplayInputError(`${field} contains unknown fields`)
  }
}

function text(value: unknown, max: number, field: string, required = false): string {
  if (typeof value !== 'string') throw new AgentDisplayInputError(`${field} must be a string`)
  const normalized = value.trim()
  if ((required && !normalized) || [...normalized].length > max) {
    throw new AgentDisplayInputError(`${field} must contain ${required ? '1' : '0'}..${max} Unicode code points after trimming`)
  }
  return normalized
}

/** Omission preserves, null clears, objects patch fields; action arrays replace atomically. */
export function mergeAgentDisplay(input: unknown, previous?: AgentDisplayConfig): AgentDisplayConfig | undefined {
  if (input === undefined) return previous
  if (input === null) return undefined
  const raw = object(input, 'display')
  keys(raw, ['expertise', 'welcomeMessage', 'quickActions'], 'display')
  const result: AgentDisplayConfig = {
    ...previous,
    ...(previous?.quickActions ? { quickActions: previous.quickActions.map((a) => ({ ...a })) } : {}),
  }
  for (const [key, max] of [['expertise', 1000], ['welcomeMessage', 500]] as const) {
    if (Object.hasOwn(raw, key)) {
      const value = text(raw[key], max, `display.${key}`)
      if (value) result[key] = value
      else delete result[key]
    }
  }
  if (Object.hasOwn(raw, 'quickActions')) {
    if (!Array.isArray(raw.quickActions) || raw.quickActions.length > 3) {
      throw new AgentDisplayInputError('display.quickActions must be an array with at most 3 items')
    }
    result.quickActions = raw.quickActions.map((value, index) => {
      const field = `display.quickActions[${index}]`
      const action = object(value, field)
      keys(action, ['label', 'text'], field)
      return { label: text(action.label, 40, `${field}.label`, true), text: text(action.text, 2000, `${field}.text`, true) }
    })
  }
  return result
}

/** Explicit allowlist even for owners/admins: execution/credential fields never enter this DTO. */
export function agentDisplayProfile(agent: SubAgent): AgentDisplayProfile {
  const description = agent.description || ''
  return {
    id: agent.id,
    name: agent.name,
    description,
    display: {
      expertise: agent.display?.expertise || description,
      welcomeMessage: agent.display?.welcomeMessage || `你好，我是${agent.name}。你想先聊些什么？`,
      quickActions: (agent.display?.quickActions || []).map((a) => ({ label: a.label, text: a.text })),
    },
  }
}
