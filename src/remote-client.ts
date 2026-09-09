/**
 * @dsh-external/onenat-workbuddy - DSH 远程客户端（面向解析后的 ResolvedDshTarget）
 *
 * 相比 dsh-remote-orchestrator 的 RemoteDshClient 升级:
 *  1. 一切调用吃 { baseUrl, apiKey }（由 ResourceDirectory 实时解析而来），不再吃裸 agent（D1）
 *  2. 新增 streamPrompt: 消费远端 /sessions/:id/prompt-stream SSE（delta/reasoning/tool_call/turn_end）
 *  3. 保留同步 prompt + waitForSessionResult 轮询兜底（远端不支持 SSE 或流中断时降级，D5）
 *  4. 新增 chat: OpenAI 兼容 /chat/completions（LLM Planner 用）
 */

import type { SubtaskLogEntry } from './types.js'

export interface DshTarget {
  baseUrl: string
  apiKey?: string
}

export interface PingResult {
  ok: boolean
  name?: string
  version?: string
  port?: number
  uptime?: number
  providers?: string[]
  error?: string
}

export interface RemoteModelEntry {
  id: string
  provider: string
  name: string
  isDefault?: boolean
  description?: string
  reasoning?: boolean
}

export interface StreamEventHandlers {
  onDelta?: (delta: string) => void
  onReasoning?: (delta: string) => void
  onToolCall?: (info: { id?: string; name?: string; arguments?: any }) => void
  onToolResult?: (info: { id?: string; name?: string; result?: any; isError?: boolean }) => void
  onLog?: (msg: string, level?: SubtaskLogEntry['level']) => void
}

export interface PromptResult {
  ok: boolean
  content?: string
  reasoning?: string
  error?: string
  timedOut?: boolean
  /** 实际生效的派发通道 */
  via?: 'sse' | 'sync' | 'poll'
  /** 远端不支持 prompt-stream（旧版）⇒ 调用方降级同步 prompt */
  sseUnsupported?: boolean
}

function clean(url: string): string {
  return url.replace(/\/+$/, '')
}

export class DshClient {
  private headers(apiKey?: string): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
    if (apiKey && apiKey.trim()) h.Authorization = `Bearer ${apiKey.trim()}`
    return h
  }

  /** 无 Content-Type 的鉴权头（FormData/流式场景） */
  private headersAuth(apiKey?: string): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' }
    if (apiKey && apiKey.trim()) h.Authorization = `Bearer ${apiKey.trim()}`
    return h
  }

  /** 上传文件到远端会话工作区（远端 DSH 需 dsh-web-service >= 0.1.0） */
  public async uploadFiles(
    target: DshTarget,
    sessionId: string,
    files: Array<{ filename: string; data: Buffer; mimeType?: string }>,
  ): Promise<{ ok: boolean; files?: Array<{ name: string; path: string; size: number; mimeType?: string }>; cwd?: string; error?: string }> {
    try {
      const fd = new FormData()
      for (const f of files) {
        const blob = new Blob([new Uint8Array(f.data)], { type: f.mimeType || 'application/octet-stream' })
        fd.append('files', blob, f.filename)
      }
      const res = await fetch(`${clean(target.baseUrl)}/sessions/${sessionId}/files`, {
        method: 'POST',
        headers: this.headersAuth(target.apiKey),
        body: fd,
        signal: AbortSignal.timeout(120_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, files: json.data?.files || [], cwd: json.data?.cwd }
    } catch (err: any) {
      return { ok: false, error: err?.message || '上传失败' }
    }
  }

  /** 远端目录浏览（对齐 DSH directory-picker-browse：只返回目录行，hidden 标记） */
  public async fsList(target: DshTarget, dirPath?: string): Promise<{
    ok: boolean
    error?: string
    data?: { path: string; home: string; parent?: string; entries: Array<{ name: string; path: string; hidden: boolean }>; truncated: boolean }
  }> {
    try {
      const url = `${clean(target.baseUrl)}/fs/list${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''}`
      const res = await fetch(url, { headers: this.headers(target.apiKey), signal: AbortSignal.timeout(15_000) })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, data: json.data }
    } catch (err: any) {
      return { ok: false, error: err?.message || '目录浏览失败' }
    }
  }

  /** 远端新建目录 */
  public async fsMkdir(target: DshTarget, parent: string, name: string): Promise<{ ok: boolean; error?: string; data?: { path: string; name: string } }> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/fs/mkdir`, {
        method: 'POST',
        headers: this.headers(target.apiKey),
        body: JSON.stringify({ path: parent, name }),
        signal: AbortSignal.timeout(15_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, data: json.data }
    } catch (err: any) {
      return { ok: false, error: err?.message || '新建目录失败' }
    }
  }

  /** 查询远端会话信息（cwd 用于把 AI 报告的绝对路径换算成工作区相对路径） */
  public async getSessionInfo(target: DshTarget, sessionId: string): Promise<{ ok: boolean; cwd?: string; title?: string; status?: string; error?: string }> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/sessions/${sessionId}`, {
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(10_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, cwd: json.data?.cwd, title: json.data?.title, status: json.data?.status }
    } catch (err: any) {
      return { ok: false, error: err?.message || '查询会话失败' }
    }
  }

  /** 下载远端会话工作区文件，返回原始 Response 供流式转发 */
  public async downloadFile(target: DshTarget, sessionId: string, relPath: string): Promise<{ ok: boolean; res?: Response; name?: string; error?: string }> {
    try {
      const url = `${clean(target.baseUrl)}/sessions/${sessionId}/files/download?path=${encodeURIComponent(relPath)}`
      const res = await fetch(url, { headers: this.headersAuth(target.apiKey), signal: AbortSignal.timeout(120_000) })
      if (!res.ok || !res.body) {
        const json: any = await res.json().catch(() => ({}))
        return { ok: false, error: json?.error || `HTTP ${res.status}` }
      }
      return { ok: true, res, name: relPath.split('/').pop() }
    } catch (err: any) {
      return { ok: false, error: err?.message || '下载失败' }
    }
  }

  public async ping(target: DshTarget): Promise<PingResult> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/system/status`, {
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(10_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return {
        ok: true,
        name: json.data?.name,
        version: json.data?.version,
        port: json.data?.port,
        uptime: json.data?.uptime,
        providers: json.data?.providers || [],
      }
    } catch (err: any) {
      return { ok: false, error: err?.message || '连接失败' }
    }
  }

  public async getModels(target: DshTarget): Promise<{ ok: boolean; defaultModel?: any; models: RemoteModelEntry[]; error?: string }> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/models`, {
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(10_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, models: [], error: json?.error || `HTTP ${res.status}` }
      return { ok: true, defaultModel: json.data?.defaultModel, models: Array.isArray(json.data?.models) ? json.data.models : [] }
    } catch (err: any) {
      return { ok: false, models: [], error: err?.message || '获取模型失败' }
    }
  }

  public async getPresets(target: DshTarget): Promise<{ ok: boolean; presets: Array<{ id: string; name?: string; description?: string }>; error?: string }> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/presets`, {
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(10_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, presets: [], error: json?.error || `HTTP ${res.status}` }
      return { ok: true, presets: Array.isArray(json.data?.presets) ? json.data.presets : [] }
    } catch (err: any) {
      return { ok: false, presets: [], error: err?.message || '获取预设失败' }
    }
  }

  public async createSession(
    target: DshTarget,
    title: string,
    options?: { agentPreset?: string; provider?: string; model?: string; cwd?: string },
  ): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    const payload: Record<string, any> = { title, agentPreset: options?.agentPreset || 'cordis' }
    if (options?.provider) payload.provider = options.provider
    if (options?.model) payload.model = options.model
    if (options?.cwd) payload.cwd = options.cwd
    try {
      const res = await fetch(`${clean(target.baseUrl)}/sessions`, {
        method: 'POST',
        headers: this.headers(target.apiKey),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, sessionId: json.data?.sessionId }
    } catch (err: any) {
      return { ok: false, error: err?.message || '创建会话失败' }
    }
  }

  public async cancelSession(target: DshTarget, sessionId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      // 1. 尝试专用的 /cancel 路由
      const cancelRes = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/cancel`, {
        method: 'POST',
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(6000),
      }).catch(() => null)
      if (cancelRes && cancelRes.ok) return { ok: true }

      // 2. 尝试标准 RESTful DELETE /sessions/:id 终止远端会话
      const delRes = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(6000),
      }).catch(() => null)
      if (delRes && delRes.ok) return { ok: true }

      return { ok: false, error: '远端会话未响应终止请求' }
    } catch (err: any) {
      return { ok: false, error: err?.message || '中止失败' }
    }
  }

  public async getSession(target: DshTarget, sessionId: string): Promise<{ ok: boolean; status?: string; error?: string }> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}`, {
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(10_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, status: json.data?.status }
    } catch (err: any) {
      return { ok: false, error: err?.message || '查询会话失败' }
    }
  }

  /**
   * SSE 流式派发 prompt。解析 `event: X\ndata: Y` 帧。
   * 远端返回 404/501（旧版无此路由）时返回 sseUnsupported=true 供调用方降级。
   */
  public async streamPrompt(
    target: DshTarget,
    sessionId: string,
    prompt: string,
    handlers: StreamEventHandlers,
    options?: { remoteTimeoutMs?: number; signal?: AbortSignal },
  ): Promise<PromptResult> {
    let content = ''
    let reasoning = ''
    try {
      const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/prompt-stream`, {
        method: 'POST',
        headers: this.headers(target.apiKey),
        body: JSON.stringify({ prompt, timeoutMs: options?.remoteTimeoutMs ?? 1_800_000 }),
        signal: options?.signal,
      })
      if (res.status === 404 || res.status === 501) {
        return { ok: false, error: `远端不支持 prompt-stream (HTTP ${res.status})`, sseUnsupported: true }
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        return { ok: false, error: `prompt-stream HTTP ${res.status}: ${text.slice(0, 200)}` }
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let done = false
      let sawTurnEnd = false
      let loggedFirstReasoning = false
      handlers.onLog?.('远端 SSE 流已连接，指令已提交', 'info')
      while (!done) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const evName = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim()
          const dataRaw = /^data:\s*([\s\S]*)$/m.exec(frame)?.[1] ?? ''
          let data: any = dataRaw
          try {
            data = JSON.parse(dataRaw)
          } catch {
            /* 保留原始字符串（如 [DONE]） */
          }
          switch (evName) {
            case 'delta':
              if (typeof data?.delta === 'string' && data.delta) {
                content += data.delta
                handlers.onDelta?.(data.delta)
              }
              break
            case 'reasoning':
              if (typeof data?.delta === 'string' && data.delta) {
                reasoning += data.delta
                if (!loggedFirstReasoning) {
                  loggedFirstReasoning = true
                  handlers.onLog?.('远端开始推理…', 'info')
                }
                handlers.onReasoning?.(data.delta)
              }
              break
            case 'tool_call':
              handlers.onToolCall?.(data || {})
              handlers.onLog?.(`工具调用: ${data?.name || 'unknown'}`, 'tool')
              break
            case 'tool_result':
              handlers.onToolResult?.(data || {})
              break
            case 'error':
              return { ok: false, content, reasoning, error: data?.message || '远端执行错误' }
            case 'turn_end': {
              const r = data?.reason
              const reason = typeof r === 'string' ? r : r && typeof r === 'object' && typeof r.kind === 'string' ? r.kind : r != null ? JSON.stringify(r) : 'completed'
              sawTurnEnd = true
              handlers.onLog?.(`远端轮次结束 (${reason})`, 'info')
              break
            }
            case 'done':
              done = true
              break
          }
          if (sawTurnEnd && evName === 'done') break
        }
      }
      if (!sawTurnEnd && !content) {
        return { ok: false, error: 'SSE 流在产出任何内容前结束', sseUnsupported: false }
      }
      return { ok: true, content, reasoning: reasoning || undefined, via: 'sse' }
    } catch (err: any) {
      if (err?.name === 'AbortError') return { ok: false, content, reasoning, error: '已中止', timedOut: true }
      return { ok: false, content, reasoning, error: err?.message || 'SSE 流失败' }
    }
  }

  /** 同步派发（降级路径，沿用 orchestrator 的双窗口超时策略） */
  public async prompt(
    target: DshTarget,
    sessionId: string,
    prompt: string,
    options?: { timeoutMs?: number; remoteTimeoutMs?: number; signal?: AbortSignal },
  ): Promise<PromptResult> {
    const localTimeoutMs = options?.timeoutMs ?? 300_000
    try {
      const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/prompt`, {
        method: 'POST',
        headers: this.headers(target.apiKey),
        body: JSON.stringify({ prompt, timeoutMs: options?.remoteTimeoutMs ?? 1_800_000 }),
        signal: options?.signal ?? AbortSignal.timeout(localTimeoutMs),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, content: json.data?.content || '', reasoning: json.data?.reasoning, via: 'sync' }
    } catch (err: any) {
      const msg = err?.message || 'prompt 失败'
      const isTimeout = err?.name === 'AbortError' || /abort|timeout/i.test(msg)
      return { ok: false, error: msg, timedOut: isTimeout }
    }
  }

  public async getHistory(
    target: DshTarget,
    sessionId: string,
    maxMessages = 100,
  ): Promise<{ ok: boolean; messages?: any[]; error?: string }> {
    try {
      const res = await fetch(
        `${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/history?maxMessages=${maxMessages}`,
        { headers: this.headers(target.apiKey), signal: AbortSignal.timeout(15_000) },
      )
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      const data = json.data
      const messages = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : []
      return { ok: true, messages }
    } catch (err: any) {
      return { ok: false, error: err?.message || '获取历史失败' }
    }
  }

  /** 轮询远端会话直到结束并提取最后一条助手回复（同步超时兜底） */
  public async waitForSessionResult(
    target: DshTarget,
    sessionId: string,
    options?: { maxMs?: number; intervalMs?: number; signal?: AbortSignal; onLog?: (msg: string, level?: SubtaskLogEntry['level']) => void },
  ): Promise<PromptResult> {
    const maxMs = options?.maxMs ?? 1_800_000
    const intervalMs = options?.intervalMs ?? 15_000
    const deadline = Date.now() + maxMs
    let lastStatus = ''
    options?.onLog?.(`转入轮询模式（最长 ${Math.round(maxMs / 60_000)} 分钟）...`, 'info')
    while (Date.now() < deadline) {
      if (options?.signal?.aborted) return { ok: false, error: '已中止' }
      await new Promise((r) => setTimeout(r, intervalMs))
      const st = await this.getSession(target, sessionId)
      if (!st.ok) return { ok: false, error: st.error }
      if (st.status !== lastStatus) {
        options?.onLog?.(`远端会话状态: ${st.status || 'unknown'}`, 'info')
        lastStatus = st.status || ''
      }
      if (st.status && st.status !== 'running') {
        const hist = await this.getHistory(target, sessionId)
        if (!hist.ok) return { ok: false, error: hist.error }
        const messages = hist.messages || []
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (m?.role !== 'assistant') continue
          const raw = m.content
          const text =
            typeof raw === 'string'
              ? raw
              : Array.isArray(raw)
                ? raw.filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('\n')
                : ''
          if (text && text.trim()) return { ok: true, content: text, reasoning: m.reasoning, via: 'poll' }
        }
        return { ok: false, error: '会话已结束但未提取到助手回复' }
      }
    }
    return { ok: false, error: `等待远程会话完成超时 (>${Math.round(maxMs / 60_000)} 分钟)` }
  }

  /** OpenAI 兼容 /chat/completions（Planner 用，非流式） */
  public async chat(
    target: DshTarget,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: { model?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ ok: boolean; content?: string; reasoning?: string; sessionId?: string; error?: string }> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: this.headers(target.apiKey),
        body: JSON.stringify({
          messages,
          stream: false,
          ...(options?.model && options.model.includes('/') ? { model: options.model } : {}),
        }),
        signal: options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? 300_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      const choice = json?.choices?.[0]
      const content: string = choice?.message?.content ?? ''
      if (!content.trim()) return { ok: false, error: 'chat/completions 返回空内容' }
      return { ok: true, content, reasoning: choice?.message?.reasoning_content, sessionId: json?.sessionId }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'chat/completions 失败' }
    }
  }
}
