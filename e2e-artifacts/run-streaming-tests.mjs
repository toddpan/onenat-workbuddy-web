#!/usr/bin/env node
/**
 * 流式内容完整性回归一键跑：渲染当前 UI → 跑三组测试 → 汇总。
 *
 *   node e2e-artifacts/run-streaming-tests.mjs
 *   npm run test:streaming
 *
 * 三组：
 *   1) mock 远端健壮性（CRLF / 多行 data: / 心跳 / 掐断 / 引擎兜底 / 落盘合并）
 *   2) 客户端渲染回归（jsdom 驱动真实 UI；中途加入 / 断线丢帧 / 重连回源 / 折叠轮次）
 *   3) markdown 渲染无损性（代码块 / 表格 / 超长正文）
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// 渲染当前构建产物里的控制台 UI，供客户端回归直接加载
const { renderWebUi } = await import(join(root, 'dist/web-ui.js'))
const uiPath = join(mkdtempSync(join(tmpdir(), 'wb-ui-')), 'ui.html')
writeFileSync(uiPath, renderWebUi('/onenat-workbuddy', { auth: false }), 'utf-8')
console.log(`[run] UI 快照: ${uiPath}\n`)

const suites = [
  ['mock 远端健壮性', ['e2e-artifacts/mock-remote-robustness-test.mjs', []]],
  ['客户端渲染回归', ['e2e-artifacts/client-streaming-test.mjs', [uiPath]]],
  ['markdown 渲染无损', ['e2e-artifacts/md-lossless-test.mjs', [uiPath]]],
]

const results = []
for (const [name, [script, args]] of suites) {
  console.log(`\n════════ ${name} ════════`)
  const r = spawnSync(process.execPath, [join(root, script), ...args], { stdio: 'inherit', cwd: root })
  results.push([name, r.status === 0])
}

console.log('\n════════ 汇总 ════════')
let fail = 0
for (const [name, ok] of results) {
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok) fail++
}
console.log(fail ? `\n❌ ${fail} 组未通过` : '\n✅ 全部通过')
process.exit(fail ? 1 : 0)
