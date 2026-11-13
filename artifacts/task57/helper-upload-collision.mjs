import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { OnenatDirectory } from '../../dist/onenat.js'
import { DshClient } from '../../dist/remote-client.js'
import { WORKSPACE_ACCESS_CLI_NAME } from '../../dist/workspace-access.js'
const settings = JSON.parse(await readFile(join(homedir(), '.dsh/dsh-onenat/store.json'), 'utf8')).settings.onenat
const directory = new OnenatDirectory(settings.baseUrl, settings.apiKey), client = new DshClient()
const root = '/tmp/wb-task57-' + randomBytes(8).toString('hex') + '-executor', ids = []
const report = { at: new Date().toISOString(), root, uploads: [], cleanup: [] }
async function target() {
  await directory.refresh(true)
  const ep = directory.resolveMapping('5602f2c2'), cred = await directory.fetchMappingCredentials('5602f2c2')
  assert.ok(ep?.online && cred.ok)
  return { baseUrl: ep.baseUrl, apiKey: cred.apiKey || cred.token }
}
try {
  assert.equal((await client.fsMkdir(await target(), '/tmp', root.split('/').pop())).ok, true)
  for (let i = 0; i < 2; i++) {
    const session = await client.createSession(await target(), 'task57 upload collision probe', { cwd: root })
    assert.ok(session.ok && session.sessionId); ids.push(session.sessionId)
    const upload = await client.uploadFiles(await target(), session.sessionId, [{ filename: WORKSPACE_ACCESS_CLI_NAME, data: await readFile('scripts/workspace-remote.mjs'), mimeType: 'text/javascript' }])
    assert.equal(upload.ok, true)
    report.uploads.push({ sessionId: session.sessionId, files: upload.files, exactOriginalName: upload.files.some(f => f.name === WORKSPACE_ACCESS_CLI_NAME) })
  }
} catch (e) { report.error = e.message; process.exitCode = 1 }
finally {
  for (const id of ids) {
    const t = await target()
    const res = await fetch(t.baseUrl + '/sessions/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + t.apiKey }, signal: AbortSignal.timeout(15000) })
    report.cleanup.push({ sessionId: id, archived: res.ok })
  }
  assert.match(root, /^\/tmp\/wb-task57-[a-f0-9]{16}-executor$/)
  report.cleanup.push({ directory: root, removed: (await client.fsRemove(await target(), root)).ok })
  assert.equal((await client.fsList(await target(), root, true)).ok, false)
  directory.stopAutoRefresh()
  await writeFile('artifacts/task57/helper-upload-collision.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
