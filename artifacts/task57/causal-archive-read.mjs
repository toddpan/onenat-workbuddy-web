import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { OnenatDirectory } from '../../dist/onenat.js'
import { DshClient } from '../../dist/remote-client.js'
const settings = JSON.parse(await readFile(join(homedir(), '.dsh/dsh-onenat/store.json'), 'utf8')).settings.onenat
const directory = new OnenatDirectory(settings.baseUrl, settings.apiKey)
const secrets = new Set([settings.apiKey])
const report = { at: new Date().toISOString(), node: '5602f2c2', sessionId: 'session-01ddb29a-952e-47b3-b390-816bf1b39ca3', mode: 'read-only archived history; no prompt or upload sent' }
const redact = value => {
  let text = String(value)
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]')
  return text.replace(/Bearer [A-Za-z0-9._-]+/g, 'Bearer [redacted]')
}
try {
  await directory.refresh(true)
  const targets = new Map()
  for (const id of ['5602f2c2', '6cc2987d']) {
    const endpoint = directory.resolveMapping(id)
    assert.ok(endpoint?.online && endpoint.baseUrl, 'Authorized node offline: ' + id)
    const credential = await directory.fetchMappingCredentials(id)
    assert.ok(credential.ok && (credential.apiKey || credential.token))
    const key = credential.apiKey || credential.token
    secrets.add(key)
    targets.set(id, { baseUrl: endpoint.baseUrl, apiKey: key })
  }
  const history = await new DshClient().getHistory(targets.get(report.node), report.sessionId, 200)
  assert.equal(history.ok, true, history.error)
  report.requestPath = '/sessions/' + report.sessionId + '/history?maxMessages=200'
  report.messageCount = history.messages.length
  const first = history.messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[项目工作区跨机访问]'))
  assert.ok(first, 'Archived workspace prompt not found')
  const text = first.content
  const section = text.slice(text.indexOf('[项目工作区跨机访问]'), text.indexOf('[当前子任务指令]'))
  report.firstPrompt = { role: first.role, seq: first.seq, length: text.length, sha256: createHash('sha256').update(text).digest('hex'), originalRoot: text.includes('/tmp/wb-task57-37e2ba6368bb09f1-owner'), workspaceSection: true, stableOwner: text.includes("--node-ref 'mapping:6cc2987d'"), readOnlyFallback: text.includes('远程操作工具未能安装'), excerpt: redact(section) }
  assert.equal(report.firstPrompt.originalRoot, true)
  assert.equal(report.firstPrompt.stableOwner, false)
  assert.equal(report.firstPrompt.readOnlyFallback, true)
  report.verdict = 'Original archived child first prompt confirms fallback; helper upload response remains unavailable in original report'
} catch (error) { report.error = redact(error.message); process.exitCode = 1 }
finally {
  directory.stopAutoRefresh()
  await writeFile('artifacts/task57/causal-original-archive.json', redact(JSON.stringify(report, null, 2)) + '\n')
  console.log(JSON.stringify({ sessionId: report.sessionId, messages: report.messageCount, seq: report.firstPrompt?.seq, fallback: report.firstPrompt?.readOnlyFallback, error: report.error }))
}
