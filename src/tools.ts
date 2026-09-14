/**
 * @dsh-external/onenat-workbuddy - Model Tools（AI 自主操作工作台）
 *
 * DSH 插件模式适配层：把 src/tool-ops.ts 的宿主无关能力定义注册为 DSH 模型工具。
 * 独立部署模式走 src/server.ts 的 HTTP 通道，复用同一份 tool-ops 定义。
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { OnenatDirectory } from './onenat.js'
import type { TaskEngine } from './engine.js'
import type { AgentResolver } from './resolver.js'
import type { PromptComposer } from './prompt-composer.js'
import type { Planner } from './planner.js'
import type { WorkStore } from './store.js'
import type { SshResourceStore } from './ssh-store.js'
import { createWorkBuddyToolDefs } from './tool-ops.js'

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

  const defs = createWorkBuddyToolDefs({ store, directory, resolver, composer, engine, sshStore, consoleUrl })

  for (const def of defs) {
    ctx.effect(
      () =>
        ctx.tools.register(
          defineTool({
            name: def.name,
            description: def.description,
            parameters: def.parameters as any,
            output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
            async execute(args: any) {
              return def.execute(args || {})
            },
          }),
        ),
      `@dsh-external/onenat-workbuddy: ${def.name}`,
    )
  }
}
