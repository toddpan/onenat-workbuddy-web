/**
 * @dsh-external/onenat-workbuddy
 * OneNat WorkBuddy —— 基于 ONENAT 资源面 + 多 DSH 算力面的多智能体协作工作台
 * 任务多轮聊天 / 子智能体（绑定 DSH 实体，端口漂移免疫）/ 资源提示词注入 / LLM 流程编排
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'

import { OnenatDirectory } from './onenat.js'
import { WorkStore } from './store.js'
import { AgentResolver } from './resolver.js'
import { PromptComposer } from './prompt-composer.js'
import { Planner } from './planner.js'
import { TaskEngine } from './engine.js'
import { WorkBuddyRouter } from './router.js'
import { SshResourceStore } from './ssh-store.js'
import { registerWorkBuddyTools } from './tools.js'
import type { PluginConfig } from './types.js'

export const name = '@dsh-external/onenat-workbuddy'
export const inject = ['webServer', 'tools']

export interface Config extends PluginConfig {}

export const Config: z<Config> = z.object({
  pathPrefix: z.string().default('/onenat-workbuddy').description('工作台与 API 路由前缀'),
  storagePath: z.string().default('').description('本地存储文件绝对路径（留空则默认 ~/.dsh/onenat-workbuddy/store.json）'),
  onenatBaseUrl: z.string().default('').description('ONENAT 服务地址（留空用存储中的设置，默认 https://onenat.sooncore.com）'),
  onenatApiKey: z.string().default('').description('ONENAT API Key（onk-…，留空用存储中的设置）'),
  autoRefreshMs: z.number().default(60_000).description('资源目录自动刷新间隔（毫秒）'),
})

export function apply(ctx: Context, config: Config): void {
  const prefix = config.pathPrefix || '/onenat-workbuddy'
  const store = new WorkStore(config.storagePath || undefined)
  const sshStore = new SshResourceStore()

  // 配置覆盖存储设置（显式配置优先）
  const settings = store.getSettings()
  if (config.onenatBaseUrl) settings.onenat.baseUrl = config.onenatBaseUrl
  if (config.onenatApiKey) settings.onenat.apiKey = config.onenatApiKey
  if (config.autoRefreshMs) settings.onenat.autoRefreshMs = config.autoRefreshMs
  store.updateSettings(settings)

  const directory = new OnenatDirectory(settings.onenat.baseUrl, settings.onenat.apiKey, (msg) =>
    console.log(`[onenat-workbuddy] ${msg}`),
  )
  directory.startAutoRefresh(settings.onenat.autoRefreshMs)

  const resolver = new AgentResolver(store, directory)
  const composer = new PromptComposer(directory)
  const planner = new Planner(store, resolver, ctx)
  const engine = new TaskEngine(store, directory, resolver, composer, planner)
  const router = new WorkBuddyRouter(store, directory, resolver, composer, planner, engine, sshStore)

  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'prefix',
      path: prefix,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const handled = await router.dispatch(req, res, prefix)
        if (!handled && !res.headersSent) {
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: false, error: `Endpoint not found: ${req.url}` }))
        }
      },
    })
  }, '@dsh-external/onenat-workbuddy: webServer route')

  registerWorkBuddyTools(ctx, store, directory, resolver, composer, planner, engine, sshStore, { pathPrefix: prefix })

  ctx.effect(() => () => {
    directory.stopAutoRefresh()
  }, 'onenat-workbuddy: auto refresh disposer')

  const webServer = ctx.get('webServer') as any
  const port = webServer?.port || 3080
  console.log(`[onenat-workbuddy] Mounted. Console: http://127.0.0.1:${port}${prefix}  ONENAT: ${directory.endpoint || '(未配置)'}`)
}
