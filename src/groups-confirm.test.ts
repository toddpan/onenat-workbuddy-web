/**
 * groups-confirm.test.ts - ⛔ 回归测试（G-W-P1-6/7-R1，数据丢失级）
 *
 * 场景：群设置保存的破坏性确认门（P1-6 归档 / P1-7 移除成员）会替换销毁 #modal-body 内的设置表单 DOM。
 * 曾发生：确认回调重跑 collectGroupSettingsPatch 重读已销毁 DOM → memberIds 空数组落库清零成员。
 * 铁律：patch 必须在开门前快照（collect 是唯一 DOM 读取点），确认回调只允许应用闭包快照；
 *       取消路径闭包置空。本测试以「DOM 销毁后确认」强制触发历史回归路径：
 *       任何二次 collect / DOM 重读都会抛 'DOM destroyed' → PUT 不发生 → 断言失败。
 *
 * 实现：从 web-ui.ts 源文本提取 saveGroupSettings/collectGroupSettingsPatch/applyGroupSettingsPatch
 * 三个函数（锚点漂移即测试失败，天然防静默失护），以桩 document/api 注入做沙箱直测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// 源文件定位：编译产物在 dist-test/ 下运行时回溯 ../src/，源码树直跑用本目录
const srcCandidates = [
  join(here, 'web-ui.ts'),
  join(here, '..', 'src', 'web-ui.ts'),
  join(process.cwd(), 'src', 'web-ui.ts'),
]
const srcPath = srcCandidates.find((p) => existsSync(p))
assert.ok(srcPath, '定位 web-ui.ts 失败：' + srcCandidates.join(' , '))
const src = readFileSync(srcPath, 'utf8')
const start = src.indexOf('async function saveGroupSettings')
const end = src.indexOf('function openGroupDeleteConfirm')
assert.ok(start >= 0, '锚点缺失：saveGroupSettings')
assert.ok(end > start, '锚点缺失：openGroupDeleteConfirm')
const block = src.slice(start, end)

function makeHarness(fixture: { inputs: Record<string, any>; checked: Record<string, any[]>; room: any }) {
  const calls: Array<{ path: string; method: string; body: any }> = []
  const modals: Array<{ title: string; actions: Array<{ label: string; danger?: boolean; act: () => any }> }> = []
  let destroyed = false
  const documentStub = {
    getElementById(id: string) { if (destroyed) throw new Error('DOM destroyed'); return fixture.inputs[id] || null },
    querySelectorAll(sel: string) { if (destroyed) throw new Error('DOM destroyed'); return fixture.checked[sel] || [] },
  }
  const esc = (s: any) => String(s == null ? '' : s)
  const state = { agents: [{ id: 'a1', name: '成员一' }, { id: 'a2', name: '成员二' }, { id: 'a3', name: '成员三' }] }
  const groupAgentName = (id: string) => { const a = state.agents.find((x) => x.id === id); return a ? a.name : id }
  const api = async (path: string, opts?: any) => {
    calls.push({ path, method: opts && opts.method ? opts.method : 'GET', body: opts && opts.body ? JSON.parse(opts.body) : undefined })
    return { ok: true, data: {} }
  }
  const toast = () => {}
  const closeModal = () => { destroyed = true }
  const openModal = (title: string, bodyHtml: string, actions: any[]) => {
    // 确认门打开即替换销毁 #modal-body（真实 DOM 行为：设置表单不复存在）
    destroyed = true
    modals.push({ title, actions })
  }
  const factory = new Function('document', 'api', 'toast', 'closeModal', 'esc', 'openModal', 'state', 'groupAgentName', 'loadGroups',
    block + '\nreturn { saveGroupSettings, collectGroupSettingsPatch, applyGroupSettingsPatch };')
  const loadGroups = async () => { calls.push({ path: 'loadGroups', method: 'local', body: undefined }) }
  const fns = factory(documentStub, api, toast, closeModal, esc, openModal, state, groupAgentName, loadGroups)
  return { fns, calls, modals, destroy: () => { destroyed = true } }
}

const baseInputs = () => ({
  'gs-name': { value: '群A' },
  'gs-notice': { value: '公告' },
  'gs-mode': { value: 'admin' },
  'gs-notify': { value: 'all' },
  'gs-admin': { value: 'a1' },
  'gs-active': { value: 'p1' },
  'gs-perm': { value: '' },
  'gs-section': { value: '研发' },
  'gs-section-new': { value: '' },
  'gs-archived': { checked: true },
})
const baseChecked = () => ({
  'input[name="gs-member"]:checked': [{ value: 'a1' }, { value: 'a2' }],
  'input[name="gs-proj"]:checked': [{ value: 'p1' }],
})

test('G-W-P1-6/7-R1: 确认后落库 patch 与开门前快照深等（DOM 销毁下任何二次 collect 即失败）', async () => {
  const room = { id: 'g1', name: '群A', memberAgentIds: ['a1', 'a2', 'a3'], archived: false }
  const h = makeHarness({ inputs: baseInputs(), checked: baseChecked(), room })
  await h.fns.saveGroupSettings(room)
  // 归档（false→true）+ 移除成员（a3）→ 必须弹破坏性确认门
  assert.equal(h.modals.length, 1, '破坏性确认门弹出')
  const confirm = h.modals[0].actions.find((a) => a.label === '确认保存')
  assert.ok(confirm, '确认保存动作存在')
  assert.equal(confirm.danger, true, '确认键破坏色（P1-8）')
  await confirm.act()
  const put = h.calls.find((c) => c.path === '/groups/g1' && c.method === 'PUT')
  assert.ok(put, '确认后 PUT 发生')
  // 深等断言（lead 指令④）：落库 patch 与开门前快照逐字段一致——
  // 成员保留 a1/a2（仅移除 a3）、归档 true、其余字段不被销毁 DOM 清空
  assert.deepEqual(put.body, {
    name: '群A',
    notice: '公告',
    mode: 'admin',
    notifyLevel: 'all',
    adminAgentId: 'a1',
    memberAgentIds: ['a1', 'a2'],
    projectIds: ['p1'],
    activeProjectId: 'p1',
    permissionOverride: '',
    section: '研发',
    archived: true,
  })
})

test('G-W-P1-6/7-R1: 取消路径闭包置空，不发生任何落库', async () => {
  const room = { id: 'g1', name: '群A', memberAgentIds: ['a1', 'a2', 'a3'], archived: false }
  const h = makeHarness({ inputs: baseInputs(), checked: baseChecked(), room })
  await h.fns.saveGroupSettings(room)
  const cancel = h.modals[0].actions.find((a) => a.label === '取消')
  assert.ok(cancel, '取消动作存在')
  cancel.act()
  await new Promise((r) => setImmediate(r))
  assert.ok(!h.calls.some((c) => c.path === '/groups/g1' && c.method === 'PUT'), '取消后无落库')
})

test('G-W-P1-6/7-R1: 无破坏性动作时不弹确认门直接落库', async () => {
  const room = { id: 'g1', name: '群A', memberAgentIds: ['a1', 'a2'], archived: true }
  const inputs = baseInputs()
  inputs['gs-archived'] = { checked: true }   // 归档态未变化
  const h = makeHarness({ inputs, checked: baseChecked(), room })
  await h.fns.saveGroupSettings(room)
  assert.equal(h.modals.length, 0, '无破坏性动作不弹门')
  assert.ok(h.calls.some((c) => c.path === '/groups/g1' && c.method === 'PUT'), '直接落库')
})
