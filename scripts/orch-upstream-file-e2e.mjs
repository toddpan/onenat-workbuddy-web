#!/usr/bin/env node
/** 场景② 跨节点文件传参 E2E：编排 DAG 上游产出 → 下游提示词注入「上游产出上下文 + 结果文件跨节点下载清单」
 *  设计理念见 docs/design-cross-node-file-passing.md。运行：node scripts/orch-upstream-file-e2e.mjs */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 18100, STUB_PORT = 18101, PREFIX = '/onenat-workbuddy', BASE = `http://127.0.0.1:${PORT}`
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}/api/v1`
const REPORT_PATH = '/tmp/wb-orch/report-final.md'
let failures = 0
const check = (n, c, d = '') => { const ok = Boolean(c); if (!ok) failures++; console.log(`${ok ? '  ✅' : '  ❌'} ${n}${d ? ` — ${d}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let upId = '', downId = ''
const prompts = []
const sse = (res, text) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(`event: delta\ndata: {"delta":${JSON.stringify(text)}}\n\n`)
  res.write('event: turn_end\ndata: {}\n\n'); res.write('event: done\ndata: {}\n\n'); res.end()
}
const stub = createServer((req, res) => {
  const url = req.url || ''
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    if (req.method === 'GET' && url === '/system/status') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, data:{ name:'stub', version:'1', port: STUB_PORT } })); return }
    if (req.method === 'POST' && url === '/api/v1/sessions') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, data:{ sessionId:`stub-s${prompts.length + 1}` } })); return }
    if (req.method === 'POST' && url.endsWith('/prompt-stream')) {
      let prompt = ''; try { prompt = JSON.parse(b).prompt || '' } catch {}
      prompts.push(prompt)
      if (prompt.includes('<<<OBJECTIVE>>>')) {
        // 主调度规划：返回双成员 DAG 计划（上游 → 下游 dependsOn）
        const plan = { strategy: 'dag', subtasks: [
          { title: '取数产出', prompt: '拉取源数据并生成数据报告，在结论中给出报告文件的绝对路径', agentId: upId, dependsOn: [] },
          { title: '核验产出', prompt: '基于上游产出完成交叉核验并输出复核意见', agentId: downId, dependsOn: ['取数产出'] },
        ] }
        sse(res, `规划完成：\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``)
      } else if (prompt.includes('生成数据报告')) {
        sse(res, `分析完成。数据报告已写入 ${REPORT_PATH}，关键指标见报告附件，请查阅。`)
      } else if (prompt.includes('交叉核验')) {
        sse(res, '复核完成：与上游报告数据一致。')
      } else {
        sse(res, 'ok')
      }
      return
    }
    if (req.method === 'POST' && url === '/chat/completions') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '汇总：全部子任务完成' } }] })); return }
    res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, error:'Endpoint not found' }))
  })
})

const procs = []
function cleanup() { try { stub.close() } catch {} for (const p of procs) { try { p.kill('SIGKILL') } catch {} } }
process.on('exit', cleanup)
let COOKIE = ''
async function req(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch {}
  return { status: res.status, json: j }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-orch-file-e2e-'))
  console.log('\n== 编排 DAG 上游产出/结果文件注入 E2E ==\n')
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  const server = spawn(process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--quiet'], { cwd: ROOT, env: { ...process.env, WORKBUDDY_ALLOW_PRIVATE_DIRECT: '1' }, stdio: ['ignore','ignore','pipe'] })
  procs.push(server)
  const t0 = Date.now(); while (Date.now() - t0 < 20000) { try { if ((await fetch(`${BASE}/healthz`)).ok) break } catch {} await sleep(250) }
  const loginRes = await fetch(`${BASE}${PREFIX}/api/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username:'workbuddy', password:'workbuddy-admin' }) })
  COOKIE = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  check('登录', loginRes.ok)

  // 同一台 stub 上的两个成员（不同内网语义由 stub 基址代表）
  await req('POST', `${PREFIX}/api/agents`, { name: '取数员', dshRef: { kind:'direct', apiBaseUrl: STUB_BASE }, apiKey: 'stub-key' })
  await req('POST', `${PREFIX}/api/agents`, { name: '核验员', dshRef: { kind:'direct', apiBaseUrl: STUB_BASE }, apiKey: 'stub-key' })
  const agents = await req('GET', `${PREFIX}/api/agents`)
  upId = agents.json.data.find((a) => a.name === '取数员')?.id || ''
  downId = agents.json.data.find((a) => a.name === '核验员')?.id || ''
  check('两个成员就绪', Boolean(upId && downId))

  // mode=orchestrate：双 @ 才会走编排 DAG（chat 模式下多 @ 仍直通首个成员，见 engine 路由判定）
  const taskRes = await req('POST', `${PREFIX}/api/tasks`, { title: '编排文件传参', mode: 'orchestrate', memberAgentIds: [upId, downId] })
  const taskId = taskRes.json?.data?.id
  check('创建任务', Boolean(taskId))

  // 双 @ 触发编排 DAG：上游产出含结果文件路径 → 下游提示词应注入上下文 + 跨节点下载清单
  await req('POST', `${PREFIX}/api/tasks/${taskId}/messages`, { message: '@取数员 @核验员 先取数再交叉核验' })
  const deadline = Date.now() + 30000
  while (Date.now() < deadline && !prompts.some((p) => p.includes('[上游结果文件（跨节点下载）]'))) await sleep(300)

  const planned = prompts.find((p) => p.includes('<<<OBJECTIVE>>>'))
  const upstream = prompts.find((p) => p.includes('[当前子任务指令]') && p.includes('生成数据报告'))
  const downstream = prompts.find((p) => p.includes('[当前子任务指令]') && p.includes('交叉核验'))
  check('主调度规划已派发（花名册含双成员）', Boolean(planned && planned.includes('取数员') && planned.includes('核验员')))
  check('上游子任务已派发', Boolean(upstream))
  check('下游子任务已派发', Boolean(downstream))

  if (upstream) {
    check('上游无依赖：不注入上游产出段', !upstream.includes('[上游产出]'))
    check('上游无依赖：不注入结果文件清单', !upstream.includes('[上游结果文件'))
  }
  if (downstream) {
    check('下游提示词注入上游产出段（结果上下文）', downstream.includes('[上游产出]') && downstream.includes('上游子任务《取数产出》产出摘要'))
    check('下游提示词含上游产出原文（结果文件路径）', downstream.includes(REPORT_PATH))
    check('下游提示词注入结果文件跨节点下载清单', downstream.includes('[上游结果文件（跨节点下载）]'))
    const url = `${STUB_BASE}/fs/download?path=${encodeURIComponent(REPORT_PATH)}`
    check('下载 URL 指向上游成员节点且路径 URL 编码', downstream.includes(`curl -H 'Authorization: Bearer stub-key' '${url}' -o 'report-final.md'`))
    check('说明段明确「不在你的节点上」跨节点语义', downstream.includes('不在你的节点上'))
    check('无工作区任务不注入项目工作区段（不注空段）', !downstream.includes('[项目工作区跨机访问]'))
  } else {
    if (prompts.length) console.log('--- 已捕获提示词（诊断）---\n' + prompts.map((p, i) => `#${i} ${p.slice(0, 300)}`).join('\n\n'))
  }

  // 任务终态
  const dl = Date.now() + 15000
  let status = ''
  while (Date.now() < dl) { const t = await req('GET', `${PREFIX}/api/tasks/${taskId}`); status = t.json?.data?.status || ''; if (['success','partial_success','failed'].includes(status)) break; await sleep(400) }
  check('任务收敛为 success', status === 'success', `终态=${status}`)

  console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
  cleanup(); process.exit(failures ? 1 : 0)
}
main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
