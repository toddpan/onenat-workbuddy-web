#!/usr/bin/env node
/** Portable Ego bridge: its Node process has cwd=/ and does not inherit shell env. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
const mode = process.argv[2] || 'mock'
assert.ok(['mock', 'live'].includes(mode), 'Usage: node scripts/project-console-browser-run.mjs [mock|live]')
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')
const file = mode === 'live' ? 'project-console-live-browser.mjs' : 'project-console-browser.mjs'
const artifacts = resolve(process.env.WORKBUDDY_CONSOLE_ARTIFACTS || root + '/artifacts/task58/' + mode)
const space = process.env.WORKBUDDY_BROWSER_SPACE || 'workbuddy task58 console acceptance'
const script = 'const task58RepoRoot = ' + JSON.stringify(root) + ';\nconst task58Artifacts = ' + JSON.stringify(artifacts) + ';\nconst task58BrowserSpace = ' + JSON.stringify(space) + ';\n' + await readFile(new URL(file, import.meta.url), 'utf8')
const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'inherit', 'inherit'] })
child.on('error', e => { console.error(e.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
child.stdin.end(script)
