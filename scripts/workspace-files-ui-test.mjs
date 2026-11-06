#!/usr/bin/env node
/** task-59: execute the rendered console upload flow with a small DOM/fetch fixture. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/web-ui.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
const moduleContext = { exports: {} }; vm.runInNewContext(compiled.outputText, moduleContext)
const html = moduleContext.exports.renderWebUi('/workbuddy')
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))
new vm.Script(script)
const ast = ts.createSourceFile('ui.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(n => [n.name.text, n.getText(ast)]))

class Element {
  style = {}; children = []; slots = new Map(); classList = { toggle() {} }
  value = ''; textContent = ''; innerHTML = ''; className = ''
  addEventListener() {}
  appendChild(child) { this.children.push(child) }
  querySelector(selector) { if (!this.slots.has(selector)) this.slots.set(selector, new Element()); return this.slots.get(selector) }
  focus() {}
}

let checks = 0
for (const [name, status, body] of [
  ['create appends owner file path without requesting node credentials', 200, { ok: true, data: { results: [{ ok: true, files: [{ path: '/owner/project/new.txt' }] }] } }],
  ['same-name conflict is visible and never retried as blind upload', 428, { ok: false, error: '同名文件未覆盖：更新须先读取并携带 expectedSha256' }],
  ['read-only member sees the server denial', 403, { ok: false, error: '仅项目 owner 或管理员可写入项目工作区' }],
]) {
  const elements = new Map([['upload-panel', new Element()], ['up-close', new Element()], ['input', new Element()]])
  const calls = []; let complete
  const finished = new Promise(resolve => { complete = resolve })
  const context = {
    state: { currentTaskId: 'task-project' }, API: '/workbuddy/api', FormData,
    $: id => elements.get(id), document: { createElement: () => new Element() },
    isAdminUi: () => false, fmtSize: n => String(n), setTimeout() {}, pulseComposer() {},
    hintComposer: text => complete(text), toast: text => complete(text),
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: status < 300, status, json: async () => body } },
  }
  vm.createContext(context)
  vm.runInContext(['uploadAttachments', 'appendAttachmentLine'].map(n => functions.get(n)).join('\n'), context)
  context.uploadAttachments([new File(['new'], 'new.txt')])
  await finished
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/workbuddy/api/tasks/task-project/attachments')
  assert.equal(calls[0].options.body.get('files').name, 'new.txt')
  const row = elements.get('upload-panel').querySelector('.up-rows').children[0]
  if (status === 200) {
    assert.equal(elements.get('input').value, '[附件] /owner/project/new.txt')
    assert.match(row.querySelector('.up-status').textContent, /已上传/)
  } else {
    assert.equal(elements.get('input').value, '')
    assert.ok(row.querySelector('.up-status').textContent.includes(body.error))
  }
  checks++; console.log('PASS ' + name)
}
console.log(`PASS task-59 rendered upload UI: ${checks}/${checks}; DOM fixture, not a browser acceptance`)
