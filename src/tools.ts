/**
 * @dsh-external/onenat-workbuddy - Model Tools（AI 自主操作工作台）
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DshClient } from './remote-client.js'
import type { OnenatDirectory } from './onenat.js'
import type { TaskEngine } from './engine.js'
import type { AgentResolver } from './resolver.js'
import type { PromptComposer } from './prompt-composer.js'
import type { Planner } from './planner.js'
import type { WorkStore } from './store.js'
import type { SshResourceStore } from './ssh-store.js'
import { execOnSshResource, maskSshResource, testSshResource } from './ssh-resources.js'
import { normalizeDshRef } from './router.js'

export function registerWorkBuddyTools(
  ctx: Context,
  store: WorkStore,
  directory: OnenatDirectory,
  resolver: AgentResolver,
  composer: PromptComposer,
  _planner: Planner,
  engine: TaskEngine,
  sshStore: SshResourceStore,
  config: { pathPrefix?: string; port?: number },
): void {
  const webServer = ctx.get('webServer') as any
  const port = config.port || webServer?.port || 3080
  const prefix = config.pathPrefix || '/onenat-workbuddy'
  const consoleUrl = `http://127.0.0.1:${port}${prefix}`

  // 1. 资源目录（只读透传 ONENAT）
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'workbuddy_resource_manage',
          description:
            '查询 OneNat 隧道资源目录（SSH / DSH / HTTP 应用，公网入口实时解析）：list 列出全部资源、dsh 只列 DSH 算力节点、resolve 解析单个映射当前入口、refresh 强制刷新',
          parameters: {
            action: { type: 'string', description: '操作: list / dsh / resolve / refresh' },
            mappingId: { type: 'string', description: '映射 ID（resolve 操作用）' },
          },
          output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
          async execute(args: any) {
            const action = args.action || 'list'
            try {
              if (action === 'refresh') {
                const snap = await directory.refresh(true)
                return JSON.stringify({ ok: true, fetchedAt: snap.fetchedAt, count: directory.listEndpoints().length })
              }
              if (action === 'resolve') {
                await directory.refresh(true)
                const ep = directory.resolveMapping(String(args.mappingId || ''))
                return JSON.stringify({ ok: Boolean(ep), endpoint: ep }, null, 2)
              }
              await directory.refresh(false)
              const endpoints = action === 'dsh' ? directory.listDshEndpoints() : directory.listEndpoints()
              return JSON.stringify(
                {
                  ok: true,
                  fetchedAt: directory.current()?.fetchedAt,
                  count: endpoints.length,
                  endpoints: endpoints.map((e) => ({
                    mappingId: e.mappingId,
                    name: e.appName ?? e.note,
                    kind: e.kind,
                    online: e.online,
                    entry: e.kind === 'ssh' ? `ssh -p ${e.port} @${e.host}` : e.baseUrl || `${e.proto}://${e.host}:${e.port}`,
                    tunnel: e.tunnelName,
                    skills: e.appSkills?.map((s) => s.name),
                  })),
                  consoleUrl,
                },
                null,
                2,
              )
            } catch (err: any) {
              return JSON.stringify({ ok: false, error: err?.message || String(err) })
            }
          },
        }),
      ),
    '@dsh-external/onenat-workbuddy: resource tool',
  )

  // 2. 子智能体管理
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'workbuddy_agent_manage',
          description:
            '管理 WorkBuddy 子智能体（绑定 ONENAT 上 DSH 实体，端口漂移免疫）: list / upsert / delete / ping / preview（资源提示词预览）',
          parameters: {
            action: { type: 'string', description: '操作: list / upsert / delete / ping / preview' },
            agent: {
              type: 'json',
              description:
                '子智能体配置（upsert 用）: { id?, name, dshRef: {kind:"mapping",mappingId} | {kind:"app",appId} | {kind:"direct",apiBaseUrl}, apiKey?, agentPreset?, provider?, model?, systemPrompt?, resources?: [{ref:{kind:"mapping",mappingId}, alias?, credentialMode:"inline|self-fetch|omit", skillMode:"all|none|{names}", note?}] }',
            },
            agentId: { type: 'string', description: '目标子智能体 ID（delete/ping/preview 用）' },
          },
          output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
          async execute(args: any) {
            const action = args.action || 'list'
            if (action === 'list') {
              return JSON.stringify({ ok: true, agents: store.getAgents(), consoleUrl }, null, 2)
            }
            if (action === 'upsert') {
              const agent: any = typeof args.agent === 'string' ? JSON.parse(args.agent) : args.agent
              if (!agent?.name) return JSON.stringify({ ok: false, error: '缺少 name' })
              const dshRef = normalizeDshRef(agent.dshRef || (agent.apiBaseUrl ? { kind: 'direct', apiBaseUrl: agent.apiBaseUrl } : undefined))
              if ('error' in dshRef) return JSON.stringify({ ok: false, error: dshRef.error })
              const saved = store.upsertAgent({ ...agent, dshRef })
              return JSON.stringify({ ok: true, message: '子智能体已保存', agent: saved }, null, 2)
            }
            const id = String(args.agentId || '')
            const agent = store.getAgent(id)
            if (action === 'delete') {
              return JSON.stringify({ ok: true, deleted: store.deleteAgent(id) })
            }
            if (!agent) return JSON.stringify({ ok: false, error: '子智能体不存在' })
            if (action === 'ping') {
              const { target, ping } = await resolver.resolveWithPing(agent)
              return JSON.stringify({ ok: true, agent: agent.name, ping, resolved: target?.baseUrl }, null, 2)
            }
            if (action === 'preview') {
              await directory.refresh(true).catch(() => {})
              const composed = await composer.compose(agent, { resolvedAt: Date.now(), mask: true })
              return JSON.stringify({ ok: true, resourceBlock: composed.block, warnings: composed.warnings }, null, 2)
            }
            return JSON.stringify({ ok: false, error: `不支持的 action: ${action}` })
          },
        }),
      ),
    '@dsh-external/onenat-workbuddy: agent tool',
  )

  // 3. 任务管理
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'workbuddy_task_manage',
          description:
            '管理 WorkBuddy 任务会话（每任务一个聊天窗口，多轮对话）: list / create（可带首条消息立即发起）/ send（多轮发言）/ delete / members（变更成员）/ cancel',
          parameters: {
            action: { type: 'string', description: '操作: list / create / send / delete / members / cancel' },
            taskId: { type: 'string', description: '任务 ID（send/delete/members/cancel 用）' },
            title: { type: 'string', description: '任务标题（create 可选）' },
            memberAgentIds: { type: 'json', description: '成员子智能体 ID 数组（create/members 必填）' },
            mode: { type: 'string', description: '模式: chat（单成员直通）或 orchestrate（多成员编排），缺省按成员数推断' },
            message: { type: 'string', description: '消息内容（create 可选首条消息；send 必填）' },
          },
          output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
          async execute(args: any) {
            const action = args.action || 'list'
            if (action === 'list') {
              const tasks = store.getTasks().map((t) => ({
                id: t.id,
                title: t.title,
                mode: t.mode,
                status: t.status,
                running: engine.isRunning(t.id),
                members: t.memberAgentIds,
                turns: t.turns.length,
                updatedAt: t.updatedAt,
              }))
              return JSON.stringify({ ok: true, tasks, consoleUrl }, null, 2)
            }
            if (action === 'create') {
              const memberIds: string[] = typeof args.memberAgentIds === 'string' ? JSON.parse(args.memberAgentIds) : args.memberAgentIds
              const task = await engine.createTask({
                title: args.title,
                memberAgentIds: memberIds,
                mode: args.mode,
                message: args.message,
              })
              return JSON.stringify({ ok: true, taskId: task.id, task }, null, 2)
            }
            const taskId = String(args.taskId || '')
            if (action === 'send') {
              if (!args.message) return JSON.stringify({ ok: false, error: '缺少 message' })
              const out = await engine.sendUserMessage(taskId, String(args.message))
              return JSON.stringify(out, null, 2)
            }
            if (action === 'delete') return JSON.stringify({ ok: true, deleted: await engine.deleteTask(taskId) })
            if (action === 'cancel') {
              await engine.cancelTask(taskId)
              return JSON.stringify({ ok: true })
            }
            if (action === 'members') {
              const memberIds: string[] = typeof args.memberAgentIds === 'string' ? JSON.parse(args.memberAgentIds) : args.memberAgentIds
              const t = engine.updateMembers(taskId, memberIds)
              return JSON.stringify({ ok: Boolean(t), task: t }, null, 2)
            }
            return JSON.stringify({ ok: false, error: `不支持的 action: ${action}` })
          },
        }),
      ),
    '@dsh-external/onenat-workbuddy: task tool',
  )

  // 4. 任务状态
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'workbuddy_task_status',
          description: '查询 WorkBuddy 任务进度: 任务状态、编排计划（子任务列表与状态）、各子任务工作日志、汇总结论',
          parameters: { taskId: { type: 'string', description: '任务 ID（缺省列出全部任务概览）' } },
          output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
          async execute(args: any) {
            if (!args.taskId) {
              return JSON.stringify({
                ok: true,
                tasks: store.getTasks().map((t) => ({ id: t.id, title: t.title, status: t.status, running: engine.isRunning(t.id), subtasks: t.plan?.subtasks.length || 0 })),
              }, null, 2)
            }
            const task = store.getTask(String(args.taskId))
            if (!task) return JSON.stringify({ ok: false, error: '任务不存在' })
            return JSON.stringify({ ok: true, running: engine.isRunning(task.id), task }, null, 2)
          },
        }),
      ),
    '@dsh-external/onenat-workbuddy: task status tool',
  )

  // 5. 任务聊天（远端会话记录 / 追问）
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'workbuddy_task_chat',
          description:
            '查看 WorkBuddy 任务中某个子任务（或成员会话）在远端 DSH 的完整聊天记录；或向该远端会话发送追问消息（发送后可再调用本工具查看回复）',
          parameters: {
            taskId: { type: 'string', description: '任务 ID' },
            subtaskId: { type: 'string', description: '子任务 ID（编排任务的子任务）或成员 agentId（chat 模式）' },
            followupMessage: { type: 'string', description: '可选的追问消息；提供后发送给远端会话并等待回复' },
          },
          output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
          async execute(args: any) {
            const task = store.getTask(String(args.taskId || ''))
            if (!task) return JSON.stringify({ ok: false, error: '任务不存在' })
            const subId = String(args.subtaskId || '')
            const sub = task.plan?.subtasks.find((s) => s.id === subId)
            const agentId = sub?.agentId || subId
            const binding = task.sessions[agentId]
            const agent = store.getAgent(agentId)
            if (!agent) return JSON.stringify({ ok: false, error: '未找到该 ID 对应的子任务/成员' })
            if (!binding?.remoteSessionId) return JSON.stringify({ ok: false, error: '该成员尚未创建远程会话' })
            const target = await resolver.resolve(agent)
            if (!target.online) return JSON.stringify({ ok: false, error: target.error })
            const client = new DshClient()
            if (args.followupMessage) {
              const reply = await client.prompt(target, binding.remoteSessionId, String(args.followupMessage), { timeoutMs: 120_000 })
              return JSON.stringify({ ok: reply.ok, reply: reply.content, error: reply.error }, null, 2)
            }
            const hist = await client.getHistory(target, binding.remoteSessionId)
            return JSON.stringify({ ok: hist.ok, messages: hist.messages, error: hist.error }, null, 2)
          },
        }),
      ),
    '@dsh-external/onenat-workbuddy: task chat tool',
  )

  // 6. 汇总评估 + SSH 资源
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'workbuddy_task_evaluate',
          description: '对 WorkBuddy 编排任务重新评估并生成/刷新汇总报告（success/partial_success/failed + 各子任务要点 + 最终结论）',
          parameters: { taskId: { type: 'string', description: '任务 ID' } },
          output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
          async execute(args: any) {
            const task = store.getTask(String(args.taskId || ''))
            if (!task?.plan) return JSON.stringify({ ok: false, error: '任务不存在或无编排计划' })
            const summary = task.summary
            return JSON.stringify({ ok: true, summary, running: engine.isRunning(task.id) }, null, 2)
          },
        }),
      ),
    '@dsh-external/onenat-workbuddy: evaluate tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'workbuddy_ssh_resource_manage',
          description:
            '管理 WorkBuddy 本地 SSH 连接资源池（补充 ONENAT 之外的直连主机）: list(脱敏) / get(取完整凭据) / upsert / delete / test(真实连接测试) / exec(远程执行命令)',
          parameters: {
            action: { type: 'string', description: '操作: list / get / upsert / delete / test / exec' },
            resource: { type: 'json', description: 'SSH 资源对象（upsert 用）: { id?, name, host, port?, authType: "password"|"key", username, password?, privateKey?, passphrase?, description?, tags? }' },
            resourceId: { type: 'string', description: '资源 ID（get/delete/test/exec 用；test/exec 也接受 name）' },
            command: { type: 'string', description: 'exec 要执行的 shell 命令' },
            timeoutMs: { type: 'string', description: '超时毫秒（默认 exec 30000）' },
          },
          output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
          async execute(args: any) {
            const action = args.action || 'list'
            if (action === 'list') return JSON.stringify({ ok: true, resources: sshStore.list().map(maskSshResource) }, null, 2)
            if (action === 'upsert') {
              const input: any = typeof args.resource === 'string' ? JSON.parse(args.resource) : args.resource
              const existing = input?.id ? sshStore.get(input.id) : undefined
              const { normalizeSshResource } = await import('./ssh-resources.js')
              try {
                const saved = sshStore.upsert(normalizeSshResource(input, existing))
                return JSON.stringify({ ok: true, resource: maskSshResource(saved) }, null, 2)
              } catch (err: any) {
                return JSON.stringify({ ok: false, error: err?.message })
              }
            }
            const key = String(args.resourceId || '')
            const r = sshStore.get(key) || sshStore.list().find((x) => x.name === key)
            if (!r) return JSON.stringify({ ok: false, error: 'SSH 资源不存在' })
            if (action === 'get') return JSON.stringify({ ok: true, resource: r }, null, 2)
            if (action === 'delete') return JSON.stringify({ ok: true, deleted: sshStore.delete(r.id) })
            if (action === 'test') {
              const result = await testSshResource(r, Number(args.timeoutMs) || 8000)
              sshStore.update(r.id, { lastTestedAt: result.testedAt, lastTestOk: result.ok, lastTestError: result.ok ? undefined : result.error })
              return JSON.stringify({ ok: true, result }, null, 2)
            }
            if (action === 'exec') {
              if (!args.command) return JSON.stringify({ ok: false, error: '缺少 command' })
              const result = await execOnSshResource(r, String(args.command), Number(args.timeoutMs) || 30000)
              return JSON.stringify({ ok: true, result }, null, 2)
            }
            return JSON.stringify({ ok: false, error: `不支持的 action: ${action}` })
          },
        }),
      ),
    '@dsh-external/onenat-workbuddy: ssh tool',
  )
}
