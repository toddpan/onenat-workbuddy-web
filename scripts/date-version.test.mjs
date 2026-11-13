import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Run after npm run build: exercise the shipped artifact, not a mocked resolver.
test('copied standalone dist retains its release version without package.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-version-'))
  try {
    const dist = join(root, 'platform-dist')
    mkdirSync(dist)
    const entry = join(dist, 'date-version.mjs')
    copyFileSync(new URL('../dist/date-version.js', import.meta.url), entry)
    const { readPackageVersion } = await import(pathToFileURL(entry).href)
    const release = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
    assert.equal(readPackageVersion(), release)
    // A containing app or stale deployment manifest must not relabel built code.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1999.1.1' }))
    assert.equal(readPackageVersion(), release)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
