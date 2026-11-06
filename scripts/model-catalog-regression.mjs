#!/usr/bin/env node
/** Model catalog regression: run npm run build && node --test scripts/model-catalog-regression.mjs. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { renderWebUi } from '../dist/web-ui.js'
import { WorkBuddyRouter } from '../dist/router.js'

const model = (provider) => ({ provider, id: 'model', name: `${provider} model`, isDefault: true, reasoning: { efforts: [{ id: 'high', name: 'High' }] } })
const options = (node) => ({ ok: true, data: { models: [model(node)], current: {}, node, defaultModel: { provider: node, model: 'model' } } })
function ui(fetcher, otherFetcher = () => ({ ok: true, data: [] })) {
  const html = renderWebUi('/wb').replace(/\nloadPlannerOptions\(\);/g, '\n').replace('boot();', 'window.__catalog = {state, nodeState, modelState, loadPlannerOptions, reloadCatalogIfExecNodeChanged, modelCatalogCurrent, renderModelPop, selectModel};')
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/wb/', beforeParse(window) {
    window.fetch = async (url) => ({ status: 200, ok: true, json: async () => String(url).includes('/planner/options') ? fetcher(String(url)) : otherFetcher(String(url)) })
  } })
  assert.ok(dom.window.__catalog, 'real UI script initialized')
  return { dom, ...dom.window.__catalog }
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('switching nodes during a pending catalog request loads only the latest node', async () => {
  const first = deferred(); const calls = []
  const u = ui(url => { calls.push(url); return calls.length === 1 ? first.promise : options('node-b') })
  try {
    u.nodeState.cur = 'node-a'
    const loading = u.loadPlannerOptions()
    u.nodeState.cur = 'node-b'
    const switched = u.loadPlannerOptions()
    first.resolve(options('node-a'))
    await Promise.all([loading, switched])
    assert.equal(u.modelState.loadedForNode, 'node-b', 'node A response must not become node B catalog')
    assert.deepEqual(Object.keys(u.modelState.groups), ['node-b'])
    assert.equal(u.modelCatalogCurrent(), true)
    assert.equal(u.dom.window.document.getElementById('chat-model-btn').disabled, false)
  } finally { u.dom.window.close() }
})

test('switching tasks while loading discards the former task catalog', async () => {
  const first = deferred(); let calls = 0
  const u = ui(() => ++calls === 1 ? first.promise : options('node-b'))
  try {
    u.state.currentTaskId = 'task-a'
    const loading = u.loadPlannerOptions()
    u.state.currentTaskId = 'task-b'
    const switched = u.loadPlannerOptions()
    first.resolve(options('node-a'))
    await Promise.all([loading, switched])
    assert.equal(u.modelState.loadedForTask, 'task-b')
    assert.deepEqual(Object.keys(u.modelState.groups), ['node-b'])
  } finally { u.dom.window.close() }
})

test('changing context immediately removes the preceding node catalog', async () => {
  const pending = deferred(); let calls = 0
  const u = ui(() => ++calls === 1 ? options('node-a') : pending.promise)
  try {
    u.nodeState.cur = 'node-a'; await u.loadPlannerOptions()
    u.nodeState.cur = 'node-b'; const next = u.loadPlannerOptions()
    assert.deepEqual(Object.keys(u.modelState.groups), [], 'old models must not remain selectable while loading')
    pending.resolve(options('node-b')); await next
  } finally { pending.resolve(options('node-b')); await new Promise(r => setImmediate(r)); u.dom.window.close() }
})

async function plannerOptions({ node = '', task = false, online = true, modelError = '', query: explicitQuery, unboundTask = false } = {}) {
  const requested = []; const credentials = []; const resolvedNodes = []; let payload
  const router = Object.create(WorkBuddyRouter.prototype)
  const target = { baseUrl: 'http://selected.example/api/v1', apiKey: 'selected-fixture', online, mappingId: 'selected' }
  Object.assign(router, {
    store: { getSettings: () => ({ planner: {} }), getAgents: () => [], getTask: () => ({ id: 'task' }) },
    planner: { plannerTarget: async () => ({ baseUrl: 'http://planner.example/api/v1', apiKey: 'fixture', auto: true }) },
    directory: { resolveMapping: () => online ? { ...target, appName: 'selected' } : undefined, fetchMappingCredentials: async () => ({ ok: true, apiKey: 'fixture' }) },
    resolver: { resolveRef: async ref => { resolvedNodes.push(ref.mappingId); return target } },
    engine: { resolveExecTarget: async () => unboundTask ? undefined : target, taskExec: () => unboundTask ? {} : {dshRef:{kind:'mapping',mappingId:'selected'}} },
    taskForView: () => ({ id: 'task' }),
    client: { getModels: async target => { requested.push(target.baseUrl); credentials.push(target.apiKey); if (modelError) return { ok: false, error: modelError }; return { ok: true, models: [model(target.baseUrl.includes('selected') ? 'selected' : 'planner')], defaultModel: { provider: 'selected', model: 'model' } } } },
  })
  const query = explicitQuery ?? (task ? '?taskId=task' : node ? `?node=${node}` : '')
  const res = { setHeader() {}, end(text) { payload = JSON.parse(text) } }
  const handled = await router.dispatch({ url: `/wb/api/planner/options${query}`, method: 'GET' }, res, '/wb')
  assert.equal(handled, true)
  return { ...payload, requested, credentials, resolvedNodes }
}

for (const task of [false, true]) test(`unavailable ${task ? 'task' : 'selected'} node never substitutes the planner catalog`, async () => {
  const result = await plannerOptions({ node: 'selected', task, online: false })
  assert.deepEqual(result.data.models, [], 'must not return another DSH node models')
  assert.ok(result.data.modelError)
  assert.deepEqual(result.requested, [], 'must not query the unrelated planner node')
})

test('planner catalog preserves the same model metadata as node/task endpoints', async () => {
  const result = await plannerOptions({ node: 'selected' })
  assert.deepEqual(result.data.models, [model('selected')])
  assert.deepEqual(result.data.defaultModel, { provider: 'selected', model: 'model' })
  assert.deepEqual(result.credentials, ['selected-fixture'], 'must use selected node credentials')
  assert.deepEqual(result.resolvedNodes, ['selected'], 'same mapping resolver as Android')
})

test('task-authoritative node wins over a conflicting node query', async () => {
  const result = await plannerOptions({ task: true, query: '?taskId=task&node=wrong-node' })
  assert.deepEqual(result.requested, ['http://selected.example/api/v1'])
  assert.deepEqual(result.resolvedNodes, [])
  assert.deepEqual(result.data.models, [model('selected')])
})

test('an unavailable task never falls back to a conflicting node query', async () => {
  const result = await plannerOptions({ task: true, online: false, query: '?taskId=task&node=wrong-node' })
  assert.deepEqual(result.requested, [])
  assert.deepEqual(result.resolvedNodes, [])
  assert.deepEqual(result.data.models, [])
})

test('remote model errors return an empty catalog without a default', async () => {
  const result = await plannerOptions({ node: 'selected', modelError: 'remote unavailable' })
  assert.deepEqual(result.data.models, [])
  assert.equal(result.data.modelError, 'remote unavailable')
  assert.equal(result.data.defaultModel, undefined)
  assert.deepEqual(result.requested, ['http://selected.example/api/v1'])
})

test('legacy unbound task uses its actual planner execution catalog', async () => {
  const result = await plannerOptions({task:true,unboundTask:true})
  assert.deepEqual(result.requested, ['http://planner.example/api/v1'])
  assert.deepEqual(result.data.models, [model('planner')])
  assert.equal(result.data.modelError, undefined)
})

test('welcome without a selected node can still use the planner catalog', async () => {
  const result = await plannerOptions()
  assert.deepEqual(result.requested, ['http://planner.example/api/v1'])
  assert.deepEqual(result.data.models, [model('planner')])
})

test('late old response cannot overwrite an already loaded new catalog', async () => {
  const first = deferred(); let calls = 0
  const u = ui(() => ++calls === 1 ? first.promise : options('node-b'))
  try {
    u.nodeState.cur = 'node-a'; const old = u.loadPlannerOptions()
    u.nodeState.cur = 'node-b'; await u.loadPlannerOptions()
    first.resolve(options('node-a')); await old
    assert.deepEqual(Object.keys(u.modelState.groups), ['node-b'])
    assert.equal(u.modelState.loading, false)
    assert.equal(u.modelCatalogCurrent(), true)
  } finally { u.dom.window.close() }
})

test('same-context concurrent callers share a single in-flight request', async () => {
  const pending = deferred(); let calls = 0
  const u = ui(() => { calls++; return pending.promise })
  try {
    u.nodeState.cur = 'node-a'
    const a = u.loadPlannerOptions(); const b = u.loadPlannerOptions(true)
    assert.equal(a, b)
    pending.resolve(options('node-a')); await a
    assert.equal(calls, 1)
  } finally { u.dom.window.close() }
})

test('context discovered after request starts automatically fetches the final node', async () => {
  const first = deferred(); let calls = 0
  const u = ui(() => ++calls === 1 ? first.promise : options('node-b'))
  try {
    const initial = u.loadPlannerOptions()
    u.nodeState.cur = 'node-b'
    first.resolve(options('node-a')); await initial
    assert.equal(calls, 2)
    assert.deepEqual(Object.keys(u.modelState.groups), ['node-b'])
  } finally { u.dom.window.close() }
})

test('reopening model picker fetches changes to the same node registry', async () => {
  let calls = 0
  const u = ui(() => { calls++; return options(calls === 1 ? 'old' : 'new') })
  try {
    u.nodeState.cur = 'node-a'; await u.loadPlannerOptions()
    u.dom.window.document.getElementById('chat-model-btn').click()
    await u.loadPlannerOptions()
    assert.equal(calls, 2)
    assert.deepEqual(Object.keys(u.modelState.groups), ['new'])
    assert.ok(u.dom.window.document.getElementById('model-pop').textContent.includes('new'))
  } finally { u.dom.window.close() }
})

test('catalog cache expires and reloads instead of remaining indefinitely stale', async () => {
  let calls = 0
  const u = ui(() => { calls++; return options('node-a') })
  try {
    u.nodeState.cur = 'node-a'; await u.loadPlannerOptions()
    u.modelState.loadedAt -= 60001
    assert.equal(u.modelCatalogCurrent(), false)
    await u.loadPlannerOptions(); assert.equal(calls, 2)
  } finally { u.dom.window.close() }
})

test('failed fetch clears catalog, restores controls, and can be retried', async () => {
  let calls = 0
  const u = ui(() => ++calls === 1 ? { ok: false, error: 'offline' } : options('node-a'))
  try {
    u.nodeState.cur = 'node-a'; await u.loadPlannerOptions()
    assert.equal(u.modelState.loaded, false)
    assert.equal(u.modelState.error, 'offline')
    assert.equal(u.dom.window.document.getElementById('chat-model-btn').disabled, false)
    await u.loadPlannerOptions(); assert.equal(u.modelState.loaded, true)
    assert.deepEqual(Object.keys(u.modelState.groups), ['node-a'])
  } finally { u.dom.window.close() }
})

test('changing a project node within the same task invalidates the cached catalog', async () => {
  let calls = 0
  const u = ui(() => { calls++; return options(calls === 1 ? 'node-a' : 'node-b') })
  try {
    u.state.currentTaskId = 'task'
    u.state.taskCache.set('task', { id: 'task', projectId: 'project', nodeRef: {kind:'mapping',mappingId:'ignored'} })
    u.state.projects = [{ id: 'project', dshRef: {kind:'mapping',mappingId:'node-a'} }]
    await u.loadPlannerOptions()
    u.state.projects[0].dshRef.mappingId = 'node-b'
    assert.equal(u.modelCatalogCurrent(), false)
    await u.loadPlannerOptions(); assert.equal(calls, 2)
    assert.deepEqual(Object.keys(u.modelState.groups), ['node-b'])
  } finally { u.dom.window.close() }
})

test('catalog refresh does not overwrite a concurrently selected default', async () => {
  const catalog = deferred(); const session = deferred()
  const u = ui(() => catalog.promise, url => url.endsWith('/session-model') ? session.promise : { ok: true, data: {} })
  try {
    u.state.currentTaskId = 'task'
    u.state.taskCache.set('task', {id: 'task', model: 'node/old'})
    u.modelState.cur = 'node/old'
    const refresh = u.loadPlannerOptions()
    const selection = u.selectModel('')
    catalog.resolve(options('node')); await refresh
    assert.equal(u.modelState.cur, '', 'catalog must not revert the optimistic selection')
    session.resolve({ok:true,data:{}}); await selection
    assert.equal(u.state.taskCache.get('task').model, undefined)
    assert.equal(u.modelState.cur, '')
  } finally { catalog.resolve(options('node')); session.resolve({ok:true,data:{}}); await new Promise(r => setImmediate(r)); u.dom.window.close() }
})

test('refresh started after a model choice preserves the pending selection', async () => {
  const session = deferred()
  const u = ui(() => options('node'), url => url.endsWith('/session-model') ? session.promise : {ok:true,data:{}})
  try {
    u.state.currentTaskId = 'task'
    u.state.taskCache.set('task', {id:'task',model:'node/old'})
    u.modelState.cur = 'node/old'
    const selection = u.selectModel('')
    await u.loadPlannerOptions()
    assert.equal(u.modelState.cur, '')
    session.resolve({ok:true,data:{}}); await selection
    assert.equal(u.modelState.cur, '')
  } finally { session.resolve({ok:true,data:{}}); await new Promise(r => setImmediate(r)); u.dom.window.close() }
})



test('picker displays and searches remote model names while preserving provider/id values', async () => {
  const named = {id:'deepseek-flash',provider:'deepseek-account',name:'DeepSeek-V4.1-Flash'}
  const fallback = {id:'raw-model',provider:'other'}
  const u = ui(() => ({ok:true,data:{models:[named,fallback],current:{}}}))
  try {
    await u.loadPlannerOptions(); u.renderModelPop()
    const doc = u.dom.window.document
    const row = doc.querySelector('[data-v="deepseek-account/deepseek-flash"]')
    assert.ok(row.querySelector('.n').textContent.includes('DeepSeek-V4.1-Flash'))
    assert.ok(row.textContent.includes('deepseek-account/deepseek-flash'))
    assert.ok(doc.querySelector('[data-v="other/raw-model"]').querySelector('.n').textContent.includes('raw-model'))
    const input=doc.getElementById('model-search-input')
    input.value='V4.1'; input.dispatchEvent(new u.dom.window.Event('input'))
    assert.equal(doc.querySelectorAll('#model-list .model-item').length,1)
    assert.equal(doc.querySelector('#model-list .model-item').dataset.v,'deepseek-account/deepseek-flash')
    input.value='deepseek-flash'; input.dispatchEvent(new u.dom.window.Event('input'))
    assert.equal(doc.querySelectorAll('#model-list .model-item').length,1)
  } finally {u.dom.window.close()}
})

test('picker distinguishes global override from selected node default', async () => {
  const u = ui(() => ({ok:true,data:{models:[model('selected')],defaultModel:{provider:'selected',model:'model'},current:{model:'global/other'}}}))
  try {
    await u.loadPlannerOptions(); u.renderModelPop()
    const doc=u.dom.window.document
    assert.ok(doc.querySelector('#model-pop [data-v=""]').textContent.includes('全局默认'))
    assert.ok(doc.querySelector('.model-default-note').textContent.includes('selected/model'))
    assert.ok(doc.querySelector('.model-default-note').textContent.includes('全局默认'))
    assert.ok(doc.getElementById('chat-model-btn').textContent.includes('全局默认'))
  } finally {u.dom.window.close()}
})

test('node default model is displayed when no global override exists', async () => {
  const u = ui(() => options('selected'))
  try {
    u.nodeState.cur = 'selected'; await u.loadPlannerOptions(); u.renderModelPop()
    assert.ok(u.dom.window.document.getElementById('model-pop').textContent.includes('跟随默认（selected/model）'))
  } finally { u.dom.window.close() }
})

