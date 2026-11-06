#!/usr/bin/env node
/** Runs only inside the real executor acceptance session. No credentials are embedded. */
import assert from 'node:assert/strict'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
const [helper, ownerRef, directory, root, expectedCwd, resultName, lane] = process.argv.slice(2)
assert.ok(['main', 'child'].includes(lane))
assert.equal(process.cwd(), expectedCwd)
assert.ok(path.isAbsolute(root) && /^\/tmp\/wb-task57-[a-f0-9]{16}-owner$/.test(root))
const sha = data => createHash('sha256').update(data).digest('hex')
const common = ['--node-ref', ownerRef, '--onenat-base', directory, '--root', root, '--request-timeout-ms', '240000']
const checks = []
const invoke = (operation, args = [], expected = true) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [helper, operation, ...common, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  const out = [], err = []
  child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b))
  child.on('error', reject)
  child.on('close', code => {
    try {
      const stdout = Buffer.concat(out).toString(), stderr = Buffer.concat(err).toString()
      const value = JSON.parse(stdout || stderr)
      assert.equal(value.ok, expected, JSON.stringify(value)); assert.equal(code, expected ? 0 : 1, stderr)
      checks.push({ operation, exitCode: code, ok: value.ok, code: value.code, path: value.path, sha256: value.sha256, error: value.error, temporarySessionId: value.temporarySessionId, sessionCleanup: value.sessionCleanup })
      console.log('LIVE_STEP ' + lane + ' ' + operation + ' ' + (value.code || 'ok'))
      resolve(value)
    } catch (e) { reject(e) }
  })
})
const file = lane + '.txt', replacement = path.resolve('.replacement-' + lane)
const result = { lane, executorCwd: process.cwd(), ownerRef, root, checks, ok: false }
try {
  const listing = await invoke('list')
  assert.ok(listing.entries.some(e => e.name === file))
  const initial = await invoke('read', ['--path', file])
  const bytes = Buffer.from(initial.contentBase64, 'base64')
  assert.equal(sha(bytes), initial.sha256)
  result.initialSha256 = initial.sha256
  const text = 'task57-' + lane + '-updated-' + randomBytes(18).toString('hex')
  await writeFile(replacement, text)
  const written = await invoke('write', ['--path', file, '--file', replacement, '--expected-sha256', initial.sha256])
  assert.equal(written.sha256, sha(text)); result.finalSha256 = written.sha256
  const conflict = await invoke('write', ['--path', file, '--file', replacement, '--expected-sha256', initial.sha256], false)
  assert.equal(conflict.code, 'CAS_MISMATCH')
  const verified = await invoke('read', ['--path', file])
  assert.equal(verified.sha256, written.sha256); assert.equal(Buffer.from(verified.contentBase64, 'base64').toString(), text)
  const program = `const fs=require('node:fs'),os=require('node:os'),c=require('node:crypto');const input=fs.readFileSync(${JSON.stringify(file)});const built=input.toString().toUpperCase();fs.writeFileSync(${JSON.stringify(lane + '.built')},built);console.log(JSON.stringify({cwd:process.cwd(),hostname:os.hostname(),sha256:c.createHash('sha256').update(input).digest('hex'),builtSha256:c.createHash('sha256').update(built).digest('hex')}))`
  const executed = await invoke('exec', ['--guards', JSON.stringify([{ path: file, expectedSha256: written.sha256 }]), '--', 'node', '-e', program])
  const evidence = JSON.parse(executed.stdout.trim())
  assert.equal(evidence.cwd, root); assert.equal(evidence.sha256, written.sha256)
  result.exec = evidence
  // This result file is on the execution node, independent verification reads the owner file over HTTP.
  result.ok = true
} catch (e) { result.error = e.message; process.exitCode = 1 }
finally {
  await unlink(replacement).catch(() => {})
  await writeFile(resultName, JSON.stringify(result, null, 2))
  console.log('LIVE_ROUNDTRIP:' + Buffer.from(JSON.stringify(result)).toString('base64'))
}
