/**
 * Backlog 派发服务单测（docs/design-backlog-mcp-tool.md §7.1「派发失败的不可重试语义」）。
 *
 * 覆盖两个最容易出事的时序：
 *  1. **建任务与写待办之间文件被改**（人在节点上编辑 / 上一条任务回写）→ 冲突后重读最新内容
 *     重试一次追加，最终仍成功，且不丢失并发写入的内容；
 *  2. **建任务后写待办彻底失败**（节点抖动）→ 抛出的错误必须带 taskId/taskCreated，
 *     让调用方（工具通道）能提示「任务已创建，勿重复派发」，而不是让 AI 重试造出重复任务。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchBacklogItem } from './backlog-service.js'
import type { DshClient, DshTarget } from './remote-client.js'
import type { TaskEngine } from './engine.js'
import type { Project } from './types.js'

const WS = '/tmp/bl-svc-ws'
const TASKS = `${WS}/backlog/tasks`
const TARGET = { baseUrl: 'http://stub/api/v1' } as DshTarget
const PROJECT = { id: 'proj-1', name: '演示项目', dshRef: { kind: 'direct', apiBaseUrl: 'http://stub/api/v1' }, workspace: WS, connectorIds: [], skillNames: [], expertIds: [], createdAt: 0, updatedAt: 0 } as unknown as Project

const ITEM = `---
id: TASK-1
title: 接入支付回调
status: To Do
assignee:
created_date: '2026-10-31T06:20:00Z'
updated_date: '2026-10-31T06:20:00Z'
labels:
dependencies:
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
校验签名并重试
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 签名校验通过
<!-- AC:END -->
`

/** 内存假节点：fsList/fsDownload/fsUpload/fsRemove，行为对齐真实 DSH 的「同名生成副本」语义 */
function makeNode(files: Map<string, string>) {
  const dirs = new Set([WS, `${WS}/backlog`, TASKS])
  const client = {
    async fsList(_t: DshTarget, dir: string) {
      if (!dirs.has(dir.replace(/\/+$/, ''))) return { ok: false, error: `no such file or directory: ${dir}` }
      const prefix = dir.replace(/\/+$/, '') + '/'
      const entries = [...files.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map((k) => ({ name: k.slice(prefix.length), path: k, type: 'file' }))
      return { ok: true, data: { path: dir, home: '', entries, truncated: false } }
    },
    async fsDownload(_t: DshTarget, p: string) {
      if (!files.has(p)) return { ok: false, error: 'no such file' }
      return { ok: true, res: new Response(files.get(p)!) }
    },
    async fsUpload(_t: DshTarget, dir: string, fs: Array<{ filename: string; data: Buffer }>) {
      for (const f of fs) {
        let name = f.filename
        if (files.has(`${dir}/${name}`)) {
          const m = /^(.*?)(\.[^.]+)?$/.exec(name)!
          name = `${m[1]}-1${m[2] || ''}`
        }
        files.set(`${dir}/${name}`, f.data.toString('utf8'))
      }
      return { ok: true }
    },
    async fsRemove(_t: DshTarget, p: string) {
      if (!files.delete(p)) return { ok: false, error: 'no such file' }
      return { ok: true }
    },
  }
  return client as unknown as DshClient
}

function makeEngine(onCreate: (taskId: string) => void, taskId = 'task-abc12345') {
  let n = 0
  const engine = {
    async createTask() {
      // 模拟「建任务之后、写待办之前」这个窗口里发生的事
      onCreate(taskId)
      n++
      return { id: taskId, title: '接入支付回调', mode: 'chat', status: 'running', memberAgentIds: [], turns: [], sessions: {}, createdAt: 0, updatedAt: 0 }
    },
  }
  return { engine: engine as unknown as TaskEngine, calls: () => n }
}

test('dispatch：建任务后待办被并发修改 → 重读重试，追加记录不丢并发内容', async () => {
  const files = new Map<string, string>([[`${TASKS}/task-1 - 接入支付回调.md`, ITEM]])
  const client = makeNode(files)
  const { engine } = makeEngine(() => {
    // 人在节点上同时改了这个文件（模拟并发写）
    files.set(`${TASKS}/task-1 - 接入支付回调.md`, ITEM.replace('校验签名并重试', '校验签名并重试（人补充：重试最多 3 次）'))
  })

  const out = await dispatchBacklogItem({ client, engine }, PROJECT, TARGET, WS, 'TASK-1')

  assert.equal(out.task.id, 'task-abc12345')
  assert.equal(out.item.status, 'In Progress')
  const written = files.get(`${TASKS}/task-1 - 接入支付回调.md`)!
  assert.match(written, /status: In Progress/)
  assert.match(written, /### .* 派发为任务/)
  assert.match(written, /task-abc12345/)
  // 并发写入的内容必须保留（重试基于最新内容，而不是拿旧 base 覆盖）
  assert.match(written, /人补充：重试最多 3 次/)
})

test('dispatch：建任务后写待办彻底失败 → 抛错带 taskId/taskCreated（禁止调用方重试）', async () => {
  const files = new Map<string, string>([[`${TASKS}/task-1 - 接入支付回调.md`, ITEM]])
  const client = makeNode(files)
  // 建任务后让第一次上传失败（节点抖动）；写回滚（第二次上传原文）仍可用
  const { engine } = makeEngine(() => {
    const real = (client as any).fsUpload.bind(client)
    let n = 0
    ;(client as any).fsUpload = async (...args: any[]) => {
      n++
      if (n === 1) return { ok: false, error: 'boom: 节点写入失败' }
      return real(...args)
    }
  })

  let caught: any
  await assert.rejects(
    () => dispatchBacklogItem({ client, engine }, PROJECT, TARGET, WS, 'TASK-1'),
    (err: any) => {
      caught = err
      return true
    },
  )
  assert.equal(caught.code, 'WRITEBACK_FAILED')
  assert.equal(caught.taskCreated, true)
  assert.equal(caught.taskId, 'task-abc12345')
  assert.match(String(caught.message), /已创建/)

  // 写失败后必须回滚原文：条目不能被「删了没写回」吞掉，且状态仍是原值
  const restored = files.get(`${TASKS}/task-1 - 接入支付回调.md`)
  assert.ok(restored, '写失败后应回滚原文件')
  assert.match(restored!, /status: To Do/)
  assert.doesNotMatch(restored!, /派发为任务/)
})
