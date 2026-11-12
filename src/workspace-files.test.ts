/**
 * requireWorkspacePath（src/workspace-files.ts）单测：项目工作区路径越权校验。
 *
 * 回归背景（2026-11-12 线上事故）：节点上一个项目工作区配成了用户主目录上层
 * （如 /Users/tsbj、/Users/tsbj/feyanggit/DHS-test），其后所有子孙项目（如安卓客户端项目
 * /Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-android）的附件上传在「项目 multipart 通道」
 * 被 requireWorkspacePath 判为 WORKSPACE_PATH_DENIED——用户对自己项目有编辑权，
 * 但对祖先项目（宽容模式项目：写面仅管理员）无编辑权。修复 = 祖先工作区豁免：
 * target 恒由 projectFilePath 约束在本项目根内，祖先项目根只是把本项目包在里面，
 * 重叠区完全属于本项目自己的文件，不应因无权编辑祖先而拒绝。
 * 嵌套保护方向不变：嵌套在本项目根内的其他项目（other ⊊ project）仍受保护。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OnenatDirectory } from './onenat.js'
import type { DshRef, Project } from './types.js'
import { requireWorkspacePath, workspaceContains } from './workspace-files.js'

const NODE: DshRef = { kind: 'mapping', mappingId: 'node-1' }
const OTHER_NODE: DshRef = { kind: 'mapping', mappingId: 'node-2' }

const endpoints = [{
  mappingId: 'node-1', tunnelId: 't1', tunnelName: 't1', online: true, proto: 'tcp' as const, host: 'h', local: '127.0.0.1:1',
}, {
  mappingId: 'node-2', tunnelId: 't2', tunnelName: 't2', online: true, proto: 'tcp' as const, host: 'h', local: '127.0.0.1:2',
}]
const directory = { listEndpoints: () => endpoints } as unknown as OnenatDirectory

const user = { userId: 'u-owner', role: 'user' as const }
const admin = { userId: 'u-admin', role: 'admin' as const }

/** 当前项目：隔离模式，u-owner 是 owner（对本项目有编辑权——能走到本函数说明 requireProjectFiles 已放行） */
const own = (workspace: string, dshRef: DshRef = NODE): Project => ({
  id: 'proj-own', name: 'own', owner: 'u-owner', dshRef, workspace,
  expertIds: [], connectorIds: [], skillNames: [], createdAt: 0, updatedAt: 0,
})
/** 其他项目：宽容模式存量项目（无 owner/成员：view 全员，写面仅管理员） */
const legacy = (id: string, workspace: string, dshRef: DshRef = NODE, extra: Partial<Project> = {}): Project => ({
  id, name: id, dshRef, workspace,
  expertIds: [], connectorIds: [], skillNames: [], createdAt: 0, updatedAt: 0,
  ...extra,
})

const denied = (fn: () => void) => {
  try {
    fn()
    assert.fail('expected WORKSPACE_PATH_DENIED')
  } catch (err) {
    assert.equal((err as { code?: string }).code, 'WORKSPACE_PATH_DENIED')
  }
}

test('workspaceContains：posix 前缀包含语义', () => {
  assert.equal(workspaceContains('/ws', '/ws/proj-a/f.png'), true)
  assert.equal(workspaceContains('/ws/proj-a', '/ws/proj-a/f.png'), true)
  assert.equal(workspaceContains('/ws/proj-a', '/ws/proj-a2/f.png'), false)
  assert.equal(workspaceContains('/ws', '/ws'), true)
})

test('回归：祖先项目工作区（宽容模式、无编辑权）不再拦截本项目内的附件上传', () => {
  const projects = [own('/ws/proj-a'), legacy('proj-home', '/ws'), legacy('proj-dev', '/ws/proj')]
  // 真祖先 /ws 与 /ws/proj（严格包含本项目根 /ws/proj-a）→ 豁免
  requireWorkspacePath(user, projects[0], projects, directory, '/ws/proj-a/截图.png', true)
  requireWorkspacePath(user, projects[0], projects, directory, '/ws/proj-a/截图.png', false)
})

test('回归：祖先项目即使已归档也不拦截本项目内写入（重叠区=本项目自身文件）', () => {
  const projects = [own('/ws/proj-a'), legacy('proj-arch', '/ws', NODE, { archivedAt: 1 })]
  requireWorkspacePath(user, projects[0], projects, directory, '/ws/proj-a/f.png', true)
})

test('嵌套保护补充：本项目根内的深层嵌套项目目录同样拒绝写入（豁免只对真祖先生效）', () => {
  // other = /ws/proj-a/home 嵌套在本项目根内（other ⊊ project）：非祖先 → 走常规包含校验 → 拒绝
  const projects = [own('/ws/proj-a'), legacy('proj-home', '/ws/proj-a/home')]
  denied(() => requireWorkspacePath(user, projects[0], projects, directory, '/ws/proj-a/home/f.png', true))
})

test('嵌套保护保持：本项目根内的其他项目（宽容模式、无编辑权）依然拒绝写入', () => {
  const projects = [own('/ws/proj-a'), legacy('proj-nested', '/ws/proj-a/nested')]
  denied(() => requireWorkspacePath(user, projects[0], projects, directory, '/ws/proj-a/nested/f.png', true))
  // 目标在嵌套项目外：不受影响
  requireWorkspacePath(user, projects[0], projects, directory, '/ws/proj-a/other.txt', true)
})

test('嵌套保护保持：recursive 场景（项目根包含其他项目根）依然拒绝', () => {
  const projects = [own('/ws/proj-a'), legacy('proj-nested', '/ws/proj-a/nested')]
  denied(() => requireWorkspacePath(user, projects[0], projects, directory, '/ws/proj-a', true, true))
})

test('同根双项目保持原行为：无另一项目编辑权时写入仍拒绝（不因双向包含误判为祖先）', () => {
  const projects = [own('/ws/shared'), legacy('proj-same-root', '/ws/shared')]
  denied(() => requireWorkspacePath(user, projects[0], projects, directory, '/ws/shared/f.png', true))
})

test('对其他项目有编辑权（隔离模式 owner）时写入放行', () => {
  const projects = [own('/ws/proj-a'), legacy('proj-nested', '/ws/proj-a/nested', NODE, { owner: 'u-owner' })]
  requireWorkspacePath(user, projects[0], projects, directory, '/ws/proj-a/nested/f.png', true)
})

test('跨节点项目不参与校验', () => {
  const projects = [own('/ws/proj-a', NODE), legacy('proj-other-node', '/ws/proj-a', OTHER_NODE)]
  requireWorkspacePath(user, projects[0], projects, directory, '/ws/proj-a/f.png', true)
})

test('平台管理员直接放行（早返回不变）', () => {
  const projects = [own('/ws/proj-a'), legacy('proj-nested', '/ws/proj-a/nested')]
  requireWorkspacePath(admin, projects[0], projects, directory, '/ws/proj-a/nested/f.png', true)
})
