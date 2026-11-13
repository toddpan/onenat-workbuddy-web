#!/usr/bin/env node
/**
 * WorkBuddy CLI（wb.mjs）— AI 通过 HTTP + APIKEY 管理 OneNat WorkBuddy 的零依赖命令行。
 *
 * 配置优先级：环境变量 WORKBUDDY_BASE_URL / WORKBUDDY_TOKEN > ~/.workbuddy-skill.json
 * 一键安装（推荐，自动写配置）：
 *   curl -fsSL <服务地址>/onenat-workbuddy/install-skill.sh | bash -s -- \
 *     --base-url <服务地址>/onenat-workbuddy --token wbk-xxxx
 *
 * 所有命令都是 WorkBuddy HTTP 工具通道（POST /api/tools/:name）的薄封装。
 * Node >= 18，无第三方依赖。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------- 配置 ----------

function loadConfig() {
  let file = {}
  // 与 wbmcp.sh 同名同语义：WORKBUDDY_CONFIG 可覆盖配置路径（自定义 --dir 安装、多账号共享 HOME）
  const cfgPath = process.env.WORKBUDDY_CONFIG || join(homedir(), '.workbuddy-skill.json')
  try {
    if (existsSync(cfgPath)) file = JSON.parse(readFileSync(cfgPath, 'utf-8'))
  } catch { /* 忽略坏配置 */ }
  const base = (process.env.WORKBUDDY_BASE_URL || file.baseUrl || '').replace(/\/+$/, '')
  const token = process.env.WORKBUDDY_TOKEN || file.token || ''
  return { base, token, cfgPath }
}

const CFG = loadConfig()

function die(msg) {
  console.error('错误: ' + msg)
  if (!CFG.base || !CFG.token) {
    console.error('配置缺失。两种方式任选：')
    console.error('  1) 一键安装: curl -fsSL <服务地址>/onenat-workbuddy/install-skill.sh | bash -s -- --base-url <...> --token wbk-xxx')
    console.error('  2) 环境变量: export WORKBUDDY_BASE_URL=<...> WORKBUDDY_TOKEN=wbk-xxx（也可用 WORKBUDDY_CONFIG 指向配置文件）')
    console.error('配置文件路径: ' + CFG.cfgPath)
  }
  process.exit(1)
}

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else { flags[key] = next; i++ }
    } else pos.push(a)
  }
  return { pos, flags }
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }

// ---------- 工具通道调用 ----------

async function toolRaw(name, args) {
  if (!CFG.base) die('缺少 WORKBUDDY_BASE_URL')
  if (!CFG.token) die('缺少 WORKBUDDY_TOKEN（控制台「设置 → AI APIKEY」生成）')
  let res
  try {
    res = await fetch(CFG.base + '/api/tools/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.token },
      body: JSON.stringify(args || {}),
    })
  } catch (e) {
    die('网络错误: ' + (e && e.message ? e.message : e))
  }
  let json
  try { json = await res.json() } catch { json = { ok: false, error: 'HTTP ' + res.status } }
  if (res.status === 401 || res.status === 403) {
    die('鉴权失败（HTTP ' + res.status + '）：APIKEY 无效或未配置。到控制台「设置 → AI APIKEY」生成后重试。')
  }
  return json
}

/**
 * 工具业务结果：HTTP 工具通道回包是 {ok,tool,result} 信封，外层 ok 只表示传输成功，
 * 真正的业务成败在 result.ok。同时兼容两种历史形状：直接返回工具结果、以及字符串结果。
 */
function toolResult(json) {
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const inner = json.result
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && 'ok' in inner) return inner
    if ('ok' in json) return json
    const structured = json.structuredContent
    if (structured && typeof structured === 'object' && 'ok' in structured) return structured
  }
  return undefined
}

async function tool(name, args) {
  const json = await toolRaw(name, args)
  console.log(typeof json === 'string' ? json : JSON.stringify(json, null, 2))
  // 外层 ok 恒为 true，必须下钻业务结果，否则业务失败会被误判为成功（task-102/106）
  const result = toolResult(json)
  if (result && result.ok === false) process.exit(2)
}

const flagsJson = (f, key) => {
  const v = f[key]
  if (v === undefined || v === true) return undefined
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { die('--' + key + ' 不是合法 JSON') }
}

// ---------- 命令表 ----------

const HELP = `WorkBuddy CLI — AI 管理 OneNat WorkBuddy（配置: ${CFG.cfgPath}；可用 WORKBUDDY_CONFIG 覆盖路径）

环境变量（优先级高于配置文件）:
  WORKBUDDY_BASE_URL   服务地址（含前缀）
  WORKBUDDY_TOKEN      AI APIKEY
  WORKBUDDY_CONFIG     配置文件路径（默认 ~/.workbuddy-skill.json，与 wbmcp.sh 同语义）

用法: wb.mjs <命令> [子命令] [选项]

  monitor [overview|events|history|task] [--limit n] [--since ms] [--days n] [--task id]
  resource [list|dsh|resolve|refresh] [--mapping id]
  agent    [list|upsert|delete|ping|preview|models|presets|enable|disable] [--json '{...}'] [--id x]
  task     [list|create|send|wait|status|delete|cancel|members|chat]
           create: --title t --agents a,b --message m [--mode chat|orchestrate]
                   [--node <DSH映射ID>]（任务节点：无@主会话在此执行）
                   [--project <项目ID>]（项目任务：自动继承项目节点/工作区/指令）
           send:   --id x --message m     wait: --id x [--timeout ms]
           status: [--id x]               chat: --id x --sub sid|agentId [--followup m]（--agent 为 --sub 的别名）
           members: --id x --agents a,b  （--agents 必填，至少一个非空 ID）
  project  [list|get|upsert|delete] [--id x] [--json '{name,dshRef,workspace,instruction,expertIds,...}']
  expert   [list|get|search|create|update|delete]
           list:   [--domain d] [--skill kw] [--limit n] [--offset n]（默认 50/页，含分区概览）
           get/delete: --id <专家ID>
           search: --query kw（元数据 + prompt 正文）
           create/update: --json '{id,name,systemPrompt,executionPrompt,...}'（create 必填 id+systemPrompt）
  schedule [list|get|upsert|delete|toggle|run] [--json '{...}'] [--id x]
  planner  [get|set|options] [--agent id] [--model provider/model]
  file     [list|mkdir|upload|download|delete]
           upload:   --agent a --name f.txt (--content-base64 ... | --file ./f.txt | --url https://...) [--path dir]
           download: --agent a --path p [--out ./local] [--encoding base64]
           delete:   --agent a --path p    mkdir: --agent a --path dir --name sub
  ssh      [list|get|upsert|delete|test|exec] [--json '{...}'] [--id x|name] [--command cmd]
  backlog  [list|search|view|create|edit|delete|dispatch|overview|projects|config|init|retry-writeback]
           projects/overview: 无参（overview 可带 --filter）
           list/search: --project id --filter '{status,assignee,labels,search,ready,limit}'
           create:      --project id --json '{title,description,labels,acceptance,...}'
           edit:        --project id --id itemId --json '{status,labels,...}'
           view:        --project id --id itemId
           delete:      --project id --id itemId（--force 才物理删除，否则只回二次确认提示）
           dispatch:    --project id --id TASK-1[,TASK-2…] [--force 忽略未完成依赖]
           config:      --project id
           init:        --project id [--json '{sample:true,updateInstruction:true}']
           retry-writeback: --task taskId
  tools                                     列出服务端全部工具（连通性自检）
  （协作群工具 workbuddy_group_manage 仅控制台登录会话可用；本 CLI 走 AI 令牌，调用会返回 AI_TOKEN_DENIED——群管理请用 Web 控制台「群」页签）
  help                                      本帮助`

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2))
  const cmd = pos[0]
  const sub = pos[1]
  if (!cmd || cmd === 'help' || flags.help) { console.log(HELP); return }

  if (cmd === 'tools') {
    if (!CFG.base || !CFG.token) die('配置缺失')
    const res = await fetch(CFG.base + '/api/tools', { headers: { Authorization: 'Bearer ' + CFG.token } })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json.ok) die('连通失败: HTTP ' + res.status + ' ' + (json.error || ''))
    console.log('✓ 连接正常: ' + CFG.base)
    for (const t of json.tools || []) console.log('  - ' + t.name + ' — ' + (t.description || '').slice(0, 60))
    return
  }

  switch (cmd) {
    case 'monitor': {
      const action = sub || 'overview'
      const args = { action }
      if (action === 'events') { args.limit = num(flags.limit, 50); if (flags.since) args.since = num(flags.since, 0) }
      if (action === 'history') args.days = num(flags.days, 7)
      if (action === 'task') args.taskId = flags.task || flags.id
      await tool('workbuddy_monitor_read', args)
      return
    }
    case 'resource': {
      const args = { action: sub || 'list' }
      if (flags.mapping) args.mappingId = flags.mapping
      await tool('workbuddy_resource_manage', args)
      return
    }
    case 'agent': {
      const action = sub || 'list'
      const args = { action }
      if (action === 'upsert') args.agent = flagsJson(flags, 'json')
      if (['delete', 'ping', 'preview', 'models', 'presets', 'enable', 'disable'].includes(action)) args.agentId = flags.id
      await tool('workbuddy_agent_manage', args)
      return
    }
    case 'task': {
      const action = sub || 'list'
      if (action === 'status') {
        await tool('workbuddy_task_status', flags.id ? { taskId: flags.id } : {})
        return
      }
      if (action === 'chat') {
        if (!flags.id) die('chat 需要 --id <taskId>')
        const sub = flags.sub !== undefined ? flags.sub : flags.agent
        if (sub === undefined || sub === true || sub === '') die('chat 需要 --sub <sid|agentId>（--agent 为其别名）')
        await tool('workbuddy_task_chat', { taskId: flags.id, subtaskId: sub, followupMessage: flags.followup })
        return
      }
      const args = { action, taskId: flags.id }
      if (action === 'create') {
        args.title = flags.title
        args.message = flags.message
        args.mode = flags.mode
        if (flags.agents) args.memberAgentIds = String(flags.agents).split(',').map((s) => s.trim()).filter(Boolean)
        // 环境切换：--node 指定任务节点（主 DSH，主会话在此执行）；--project 归属项目（自动继承项目上下文）
        if (flags.node) args.nodeRef = { kind: 'mapping', mappingId: String(flags.node) }
        if (flags.project) args.projectId = String(flags.project)
      }
      if (action === 'send') args.message = flags.message
      if (action === 'wait') args.timeoutMs = num(flags.timeout, 120000)
      if (action === 'members') {
        if (!flags.agents) die('members 需要 --agents <id,id>（成员子智能体 ID，至少一个）')
        const memberIds = String(flags.agents).split(',').map((s) => s.trim()).filter(Boolean)
        if (!memberIds.length) die('members 需要 --agents <id,id>（--agents 解析后为空，请提供至少一个非空 ID）')
        args.memberAgentIds = memberIds
      }
      await tool('workbuddy_task_manage', args)
      return
    }
    case 'schedule': {
      const action = sub || 'list'
      const args = { action }
      if (action === 'upsert') {
        args.schedule = flagsJson(flags, 'json')
        if (args.schedule && flags.model) args.schedule.model = String(flags.model)
      }
      if (['get', 'delete', 'toggle', 'run'].includes(action)) args.scheduleId = flags.id
      await tool('workbuddy_schedule_manage', args)
      return
    }
    case 'planner': {
      const action = sub || 'get'
      const args = { action }
      if (action === 'set') { if (flags.agent !== undefined) args.agentId = String(flags.agent); if (flags.model !== undefined) args.model = String(flags.model) }
      await tool('workbuddy_planner_manage', args)
      return
    }
    case 'file': {
      const action = sub || 'list'
      const args = { action, agent: flags.agent, path: flags.path, name: flags.name, encoding: flags.encoding }
      if (action === 'upload') {
        if (flags.file) {
          const buf = readFileSync(String(flags.file))
          if (buf.length > 1024 * 1024) die('--file 超过 1MB，请改用 --url 由服务器拉取')
          args.contentBase64 = buf.toString('base64')
          if (!args.name) args.name = String(flags.file).split('/').pop()
        } else if (flags['content-base64']) {
          args.contentBase64 = String(flags['content-base64'])
        } else if (flags.url) {
          args.url = String(flags.url)
        }
      }
      if (action === 'download' && flags.out) {
        const json = await toolRaw('workbuddy_file_manage', args)
        // 回包是 {ok,tool,result} 信封；内容/编码在 result 里（task-103）
        const payload = (json && typeof json === 'object' && json.result && typeof json.result === 'object') ? json.result : json
        if (payload && payload.ok === true && typeof payload.content === 'string') {
          const buf = payload.encoding === 'base64' ? Buffer.from(payload.content, 'base64') : Buffer.from(payload.content, 'utf-8')
          writeFileSync(String(flags.out), buf)
          console.log('✓ 已保存 ' + String(flags.out) + '（' + buf.length + ' 字节，来自 ' + args.path + '）')
          return
        }
        console.log(JSON.stringify(json, null, 2))
        process.exit(2)
      }
      await tool('workbuddy_file_manage', args)
      return
    }
    case 'ssh': {
      const action = sub || 'list'
      const args = { action }
      if (action === 'upsert') args.resource = flagsJson(flags, 'json')
      if (['get', 'delete', 'test', 'exec'].includes(action)) args.resourceId = flags.id
      if (action === 'exec') args.command = flags.command
      await tool('workbuddy_ssh_resource_manage', args)
      return
    }
    case 'backlog': {
      const action = sub || 'list'
      const args = { action }
      if (flags.project !== undefined) args.projectId = String(flags.project)
      if (flags.task !== undefined) args.taskId = String(flags.task)
      if (action === 'create' || action === 'edit') args.item = flagsJson(flags, 'json')
      if (['list', 'search', 'overview'].includes(action)) {
        const filter = flagsJson(flags, 'filter')
        if (filter !== undefined) args.filter = filter
      }
      if (action === 'init') {
        // init 的开关在工具契约里是字符串 'true'（工具参数只有 string/json 两种类型）
        const extra = flagsJson(flags, 'json')
        if (extra && extra.sample) args.sample = 'true'
        if (extra && extra.updateInstruction) args.updateInstruction = 'true'
      }
      if (action === 'delete' && flags.force) args.force = 'true'
      if (action === 'dispatch') {
        if (flags.force) args.force = 'true'
        // --id 支持逗号分隔批量：多个 → itemIds（JSON 数组），单个 → itemId
        const ids = flags.id !== undefined ? String(flags.id).split(',').map((s) => s.trim()).filter(Boolean) : []
        if (ids.length > 1) args.itemIds = ids
        else if (ids.length === 1) args.itemId = ids[0]
      } else if (['view', 'edit', 'delete'].includes(action) && flags.id !== undefined) {
        args.itemId = String(flags.id)
      }
      await tool('workbuddy_backlog_manage', args)
      return
    }
    case 'project': {
      const action = sub || 'list'
      const args = { action }
      if (action === 'upsert') args.project = flagsJson(flags, 'json')
      if (['get', 'delete'].includes(action)) args.projectId = flags.id
      await tool('workbuddy_project_manage', args)
      return
    }
    case 'expert': {
      const action = sub || 'list'
      const args = { action }
      if (action === 'list') {
        if (flags.domain) args.domain = String(flags.domain)
        if (flags.skill) args.skill = String(flags.skill)
        if (flags.limit) args.limit = num(flags.limit, 50)
        if (flags.offset) args.offset = num(flags.offset, 0)
      }
      if (action === 'search') args.query = flags.query
      if (action === 'create' || action === 'update') args.expert = flagsJson(flags, 'json')
      if (action === 'get' || action === 'delete') args.expertId = flags.id
      await tool('workbuddy_expert_manage', args)
      return
    }
    default:
      console.log(HELP)
      process.exit(1)
  }
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)))
