import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/web-ui.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
const moduleContext = { exports: {} };
vm.runInNewContext(compiled.outputText, moduleContext);
const html = moduleContext.exports.renderWebUi('/workbuddy');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
new vm.Script(script); // Validate embedded JS after outer-template escaping.
const ast = ts.createSourceFile('ui.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(n => [n.name.text, n.getText(ast)]));
const names = ['sameNodeRef', 'nodeRefLabel', 'projectExecutionRef', 'taskExecutionRef', 'taskExecNodeId', 'taskPlaceInfo', 'normalizePlace', 'placeProjectNode', 'placeLabel', 'placeNodeProjects', 'dshNodeOptions', 'executionNodeOptions', 'draftCreateBody', 'forkTaskTo', 'taskPlaceKey', 'wsTaskDshRef', 'fsTargetForChat', 'fsTargetQuery', 'wsTaskFileCtx', 'wirePlaceNodeItems', 'renderDraftPlaceBtn', 'projectCardHtml'];
const mapping = mappingId => ({ kind: 'mapping', mappingId });
const project = { id: 'p', name: 'Project', dshRef: mapping('files'), defaultExecutionNodeRef: mapping('exec'), workspace: '/owner/project', expertIds: [], skillNames: [], connectorIds: [] };
const elements = new Map();
const calls = [];
const context = { state: { projects: [project], resources: [{ kind: 'dsh', mappingId: 'files', title: 'Files', online: true }, { kind: 'dsh', mappingId: 'exec', title: 'Exec', online: true }, { kind: 'dsh', mappingId: 'offline', online: false }, { kind: 'dsh', mappingId: 'unreachable', online: true, engine: { reachable: false } }], tasks: [], agents: [], taskEnv: {}, taskCache: new Map(), draft: null }, nodeState: { cur: 'files' }, placeState: {}, esc: s => String(s), $: id => elements.get(id), toast: () => {}, loadTasks: async () => {}, openTask: async () => {}, pjTrimSlash: s => s.replace(/\/$/, ''), currentTaskObj: () => context.task, api: async (url, req) => { calls.push({ url, body: req && JSON.parse(req.body) }); return { ok: true, data: { task: { id: 'forked' } } }; } };
vm.createContext(context);
vm.runInContext(names.map(n => { assert.ok(functions.has(n), n); return functions.get(n); }).join(String.fromCharCode(10)), context);
const plain = value => JSON.parse(JSON.stringify(value));
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('ok - ' + name); }
check('project default is execution node', () => assert.deepEqual(plain(context.normalizePlace({ projectId: 'p' })), { projectId: 'p', nodeMappingId: 'exec' }));
check('explicit project execution override survives normalization', () => assert.equal(context.normalizePlace({ projectId: 'p', nodeMappingId: 'files' }).nodeMappingId, 'files'));
check('legacy project tasks stay on file owner', () => assert.equal(context.taskExecNodeId({ projectId: 'p' }), 'files'));
check('task override controls model context and location', () => { const t = { projectId: 'p', nodeRef: mapping('exec') }; assert.equal(context.taskExecNodeId(t), 'exec'); assert.equal(context.taskPlaceInfo(t).remote, true); assert.equal(context.taskPlaceInfo(t).fileNodeLabel, 'Files'); });
check('same-node project is direct access', () => assert.equal(context.taskPlaceInfo({ projectId: 'p', nodeRef: mapping('files') }).remote, false));
check('offline nodes excluded; authorized online nodes retained', () => assert.deepEqual(plain(context.executionNodeOptions().map(n => n.mappingId)), ['files', 'exec']));
check('all projects selectable independently of file ownership', () => assert.equal(context.placeNodeProjects('exec').length, 1));
check('create sends projectId and nodeRef together', () => { const body = context.draftCreateBody({ place: { projectId: 'p', nodeMappingId: 'exec' } }, 'go'); assert.equal(body.projectId, 'p'); assert.deepEqual(plain(body.nodeRef), mapping('exec')); });
check('project grouping independent of execution node', () => assert.equal(context.taskPlaceKey({ projectId: 'p', nodeRef: mapping('files') }), context.taskPlaceKey({ projectId: 'p', nodeRef: mapping('exec') })));
check('project card has one identity and both locations', () => { const card = context.projectCardHtml(project); assert.equal((card.match(/data-proj=/g) || []).length, 1); assert.match(card, /文件归属：Files/); assert.match(card, /默认执行：Exec/); });
await context.forkTaskTo('original', { projectId: 'p', nodeMappingId: 'exec' });
check('fork sends projectId and nodeRef together', () => assert.deepEqual(calls.at(-1).body, { projectId: 'p', nodeRef: mapping('exec') }));
await context.forkTaskTo('original', { projectId: null, nodeMappingId: 'exec' });
check('fork to standalone explicitly clears project', () => assert.deepEqual(calls.at(-1).body, { projectId: null, nodeRef: mapping('exec') }));
context.task = { projectId: 'p', nodeRef: mapping('exec'), workDir: '/executor/cwd' };
check('project FS target retains project authorization identity', () => { const target = context.fsTargetForChat(); assert.equal(target.projectId, 'p'); assert.deepEqual(plain(target.node), mapping('files')); const query = new URLSearchParams(context.fsTargetQuery(target)); assert.equal(query.get('projectId'), 'p'); assert.deepEqual(JSON.parse(query.get('node')), mapping('files')); });
check('standalone FS target has no project identity', () => assert.equal(new URLSearchParams(context.fsTargetQuery({ node: mapping('exec') })).has('projectId'), false));
check('all project file operations carry project scope', () => {
  for (const n of ['wsFilesLoadLevel', 'wsFilesDownloadSelected', 'wsFilesRemoveSelected', 'wsFilesUpload', 'pjFilesLoad', 'pjFilesUpload']) {
    const fn = functions.get(n);
    if (fn) assert.match(fn, /fsTargetQuery/);
  }
  assert.doesNotMatch(source, /\?node=' \+ encodeURIComponent\(JSON\.stringify\((wsFiles|pjFilesState)\.node\)\)/);
  assert.match(functions.get('previewFile'), /fsTargetQuery\(projCtx\)/);
  assert.match(functions.get('pjOpenPreview'), /projectId: pjFilesState.projectId/);
  assert.match(source, /node: wsFiles.node, projectId: wsFiles.projectId/);
  assert.match(source, /node: pjFilesState.node, projectId: pjFilesState.projectId/);
});
const fileCtx = await context.wsTaskFileCtx();
check('file tree uses owner node and owner workspace', () => { assert.deepEqual(plain(fileCtx.node), mapping('files')); assert.equal(fileCtx.root, '/owner/project'); assert.match(fileCtx.rootSrc, /远程访问/); });
context.state.draft = { place: { projectId: 'p', nodeMappingId: 'exec' } };
context.placeState = { place: context.state.draft.place, nodeOnly: false };
let click;
let picked;
context.selectPlace = value => { picked = value; };
context.wirePlaceNodeItems({ querySelectorAll: () => [{ dataset: { mid: 'files' }, addEventListener: (_name, cb) => { click = cb; } }] });
click();
check('project node selector preserves project identity', () => assert.deepEqual(plain(picked), { nodeMappingId: 'files', projectId: 'p' }));
for (const id of ['draft-place-btn', 'draft-access-note']) elements.set(id, {});
context.renderDraftPlaceBtn();
check('draft remote warning visible without hover', () => assert.match(elements.get('draft-access-note').textContent, /跨节点远程访问；项目路径不是执行节点的原生本地 cwd/));
check('mobile and X5 style conventions preserved', () => { assert.match(html, /@media \(max-width: 768px\)/); assert.match(html, /max-width: calc\(100vw - 100px\)/); assert.match(html, /word-break: break-word/); assert.doesNotMatch(source, /if \(!proj && place\.nodeMappingId\)/); });
console.log('Passed ' + checks + ' focused UI checks; rendered embedded JavaScript parses.');
