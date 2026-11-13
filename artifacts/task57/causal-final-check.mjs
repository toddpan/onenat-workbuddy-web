// Diagnostic evidence finalizer only; no task, prompt, deployment or source mutation.
import assert from 'node:assert/strict'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { OnenatDirectory } from '../../dist/onenat.js'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const root = process.cwd()
const docs = ['docs/task-57-acceptance.md', 'docs/project-workspace-nodes.md', 'backlog/tasks/task-57 - 工作区解耦：远程文件访问与命令通道.md']
const prior = JSON.parse(await readFile('artifacts/task57/final-manifest.json', 'utf8'))
const baseline = JSON.parse(await readFile('artifacts/task57/final-manifest-pre-chat.json', 'utf8'))
const hashes = Object.fromEntries(await Promise.all(Object.keys(prior.sha256).map(async file => [file, sha(await readFile(file))])))
assert.equal(hashes['src/engine.ts'], baseline.sha256['src/engine.ts'], 'Production engine must exactly match the pre-hypothesis baseline')
const ui = JSON.parse(await readFile('artifacts/task57/chat-scope-review.json', 'utf8'))
assert.equal(sha(await readFile('src/web-ui.ts')), ui.currentUiSha256, 'UI changed since this supplement baseline; investigate before finalizing')
const test = await readFile('src/engine.test.ts', 'utf8')
assert.ok(test.includes('首次新子会话经完整 runChatTurn'))
assert.ok(test.includes('公开单 @ 首次子派发经规划器安装编号 helper'))
assert.ok(!test.includes('structuredClone(currentTask)'))
const links = []
for (const file of docs) {
  const text = await readFile(file, 'utf8')
  const missing = []
  for (const match of text.matchAll(/\]\((<?[^\n]*?>?)\)/g)) {
    const path = match[1].replace(/^<|>$/g, '').split('#')[0]
    if (!path || /^(https?:|mailto:)/.test(path)) continue
    try { await readFile(resolve(dirname(file), decodeURIComponent(path))) }
    catch { missing.push(path) }
  }
  assert.deepEqual(missing, [], 'Missing documentation links in ' + file)
  links.push(file)
}
const sourceList = Object.keys(hashes)
const newArtifacts = ['causal-typecheck.log', 'causal-build.log', 'causal-unit.log', 'causal-workspace-tools.log', 'causal-timing-isolated.log', 'causal-workspace-tools-rerun.log', 'causal-smoke.log', 'causal-numbered-red-mutation.patch', 'causal-public-red.log', 'causal-archive-read.mjs', 'causal-original-archive.json', 'causal-project-execution.log', 'causal-project-workspace.log', 'causal-ws-inject.log', 'causal-orch-file.log', 'causal-final-check.mjs', 'public-live-acceptance.json', 'public-live-acceptance.log', 'public-live-summary.json'].map(file => 'artifacts/task57/' + file)
const settings = JSON.parse(await readFile(join(homedir(), '.dsh/dsh-onenat/store.json'), 'utf8')).settings.onenat
const directory = new OnenatDirectory(settings.baseUrl, settings.apiKey)
const secrets = new Set([settings.apiKey].filter(Boolean))
try {
  await directory.refresh(true)
  for (const id of ['6cc2987d', '5602f2c2']) {
    const cred = await directory.fetchMappingCredentials(id)
    assert.equal(cred.ok, true, 'Read-only credential check failed')
    if (cred.apiKey || cred.token) secrets.add(cred.apiKey || cred.token)
  }
} finally { directory.stopAutoRefresh() }
const files = [...new Set([...sourceList, ...newArtifacts])]
const findings = []
for (const file of files) {
  const data = await readFile(file, 'utf8')
  for (const secret of secrets) if (data.includes(secret)) findings.push({ file, kind: 'configured credential exact match' })
}
assert.deepEqual(findings, [], 'Credential found in a deliverable; do not print the credential')
await writeFile('artifacts/task57/causal-secret-scan.json', JSON.stringify({ filesScanned: files.length, configuredSecretsCompared: secrets.size, findings, noCredentialValuesPrinted: true }, null, 2) + '\n')
const live = JSON.parse(await readFile('artifacts/task57/public-live-summary.json', 'utf8'))
assert.equal(live.checks.length, 4)
assert.ok(live.checks.every(c => c.result === 'PASS'))
assert.equal(live.cleanup.sessionDeletes, 16)
const review = { at: new Date().toISOString(), productionEngineRestoredExactly: true, restoredEngineSha256: hashes['src/engine.ts'], storeSemanticsUnchanged: true, currentUiSha256: ui.currentUiSha256, uiEditedBySupplement: false, sourceScopes: ['src/engine.test.ts', 'scripts/project-workspace-live.mjs'], withdrawn: ['runChatTurn currentTask refresh', 'artificial upsert object replacement regression'], testsKept: ['normal complete-method first-child runChatTurn with in-place identity', 'public sendUserMessage single @ with real routing and numbered upload response'], codeCauseBoundary: 'Old exact-name upload predicate rejects successful numbered response; original failed session upload response was not captured', originalArchive: 'artifacts/task57/causal-original-archive.json', publicLiveReport: 'artifacts/task57/public-live-acceptance.json', realPlannerFallbackDisclosed: live.plannerUsedStaticFallback, oldPredicateRedWasIsolatedCompiledCopy: true, docsLinked: links }
await writeFile('artifacts/task57/causal-scope-review.json', JSON.stringify(review, null, 2) + '\n')
execFileSync('git', ['diff', '--check'], { cwd: root, stdio: 'pipe' })
const diff = execFileSync('git', ['diff', '--', 'src/engine.ts', 'src/engine.test.ts', 'scripts/project-workspace-live.mjs', ...docs], { cwd: root, encoding: 'utf8' })
await writeFile('artifacts/task57/causal-scope-review.patch', diff)
await copyFile('artifacts/task57/final-manifest.json', 'artifacts/task57/final-manifest-pre-causal.json')
const current = { ...prior, report: 'Task refresh withdrawn. Current engine matches pre-hypothesis baseline; unit 220/220; public REST first-child single @ real acceptance 4/4, exit 0; original archive fallback confirmed, original upload response absent', sha256: hashes, linksChecked: links, at: review.at, priorManifest: 'artifacts/task57/final-manifest-pre-causal.json', supplement: { sourceFiles: review.sourceScopes, productionEngineChangedSincePreHypothesis: false, scopeReview: 'artifacts/task57/causal-scope-review.json', archivedOriginalPrompt: review.originalArchive, liveReport: review.publicLiveReport, liveSummary: 'artifacts/task57/public-live-summary.json', oldExactNamePredicateRed: 'artifacts/task57/causal-public-red.log', unitGreen: 'artifacts/task57/causal-unit.log', secretScan: 'artifacts/task57/causal-secret-scan.json', normalMutateTaskFirstChildPassedWithoutRefresh: true, replacementHypothesisWithdrawn: true, publicSingleAtRoutesPlanner: true, realPlannerUsedStaticFallback: true, originalUploadResponseNotCaptured: true, uiEdited: false } }
await writeFile('artifacts/task57/final-manifest.json', JSON.stringify(current, null, 2) + '\n')
console.log(JSON.stringify({ engineRestored: true, uiUnchanged: true, linksChecked: links.length, filesScanned: files.length, configuredSecretsCompared: secrets.size, secretFindings: 0, publicLive: '4/4', originalFailedUpload: 'not captured' }))
