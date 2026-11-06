#!/usr/bin/env node
/** task-58 regressions at the emitted console function boundary. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/web-ui.ts', import.meta.url), 'utf8')
const mod = { exports: {} }
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, mod)
const html = mod.exports.renderWebUi('/onenat-workbuddy')
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))
const ast = ts.createSourceFile('console.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(n => [n.name.text, n.getText(ast)]))
function load(names, state) {
  const context = vm.createContext(state)
  vm.runInContext(names.map(n => { assert.ok(functions.has(n), n); return functions.get(n) }).join('\n'), context)
  return context
}

test('task-58: switching execution nodes refreshes file access status without discarding owner tree', async () => {
  const elements = new Map([['ws-files-root', {}]])
  let ctx = { node: { kind: 'mapping', mappingId: 'files' }, projectId: 'project', root: '/owner/project', rootSrc: '执行：Remote；跨节点远程访问' }
  let resets = 0, renders = 0
  const state = { wsFiles: { loaded: true, ...ctx, levels: { '/owner/project': { entries: ['README.md'], open: true } } }, $: id => elements.get(id), wsTaskFileCtx: async () => ctx, wsFilesReset: () => { resets++ }, wsFilesRenderAll: () => { renders++ } }
  const ui = load(['wsFilesMount'], state)
  const levels = ui.wsFiles.levels
  ctx = { ...ctx, rootSrc: '执行：Files；同节点直接访问' }
  await ui.wsFilesMount()
  assert.equal(ui.wsFiles.rootSrc, ctx.rootSrc)
  assert.equal(ui.wsFiles.levels, levels)
  assert.equal(resets, 0)
  assert.equal(renders, 1)
})

function popupContext(width, height, menuHeight, anchorTop, anchorBottom) {
  const pop = { className: '', style: {}, offsetWidth: Math.min(350, width - 24), offsetHeight: menuHeight, addEventListener() {} }
  const anchor = { getBoundingClientRect: () => ({ left: 50, top: anchorTop, bottom: anchorBottom }) }
  const state = { placeState: {}, window: { innerWidth: width, innerHeight: height }, document: { createElement: () => pop, body: { appendChild() {} } }, closePlacePop() {}, normalizePlace: p => p, renderPlacePop() {}, refreshCatalogIfStale() {} }
  const ui = load(['openPlacePop', ...(functions.has('positionPlacePop') ? ['positionPlacePop'] : [])], state)
  ui.openPlacePop(anchor, { projectId: 'project', nodeMappingId: 'exec' })
  return { pop, ui }
}
function bounds(pop, height) {
  const top = pop.style.top && pop.style.top !== 'auto' ? parseFloat(pop.style.top) : height - parseFloat(pop.style.bottom) - pop.offsetHeight
  return { top, bottom: top + pop.offsetHeight }
}
test('task-58: mobile node menu uses actual height and stays inside viewport', () => {
  const { pop } = popupContext(390, 844, 293, 550, 565)
  const rect = bounds(pop, 844)
  assert.ok(rect.top >= 12 && rect.bottom <= 832, JSON.stringify({ rect, style: pop.style }))
})
test('task-58: node menu remains inside visual viewport when keyboard narrows visible area', () => {
  const { pop, ui } = popupContext(390, 844, 293, 550, 565)
  ui.window.visualViewport = { width: 390, height: 400, offsetLeft: 0, offsetTop: 80 }
  pop.offsetHeight = 280
  ui.positionPlacePop()
  const top = parseFloat(pop.style.top)
  assert.ok(top >= 92 && top + pop.offsetHeight <= 468)
  assert.equal(pop.style.maxHeight, '304px')
})
test('task-58: node menu remains bounded after asynchronous catalog growth', () => {
  const { pop, ui } = popupContext(390, 844, 180, 460, 480)
  pop.offsetHeight = 360
  // Catalog/probe rendering must repeat positioning after rebuilding the list.
  const render = functions.get('renderPlacePop')
  assert.match(render, /positionPlacePop\(\)/)
  ui.positionPlacePop()
  const rect = bounds(pop, 844)
  assert.ok(rect.top >= 12 && rect.bottom <= 832, JSON.stringify({ rect, style: pop.style }))
})
