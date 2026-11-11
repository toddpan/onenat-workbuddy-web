import test from 'node:test'
import assert from 'node:assert/strict'
import { queryProjects, compactProject } from './project-query.js'
import type { Project } from './types.js'

const projects = Array.from({ length: 28 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, workspace: `/work/repo${i}`, instruction: i === 7 ? 'special discovery' : 'other', dshRef: { kind: 'mapping', mappingId: `m${i}` }, defaultAgentIds: ['a'], expertIds: ['a'], connectorIds: [], skillNames: [], createdAt: 1, updatedAt: 1 }) as Project)
test('project query filters names, workspaces and all keyword terms before pagination', () => {
  assert.equal(queryProjects(projects, { name: 'PROJECT 7' }).metadata.total, 1)
  assert.equal(queryProjects(projects, { workspace: 'REPO7' }).rows[0].id, 'p7')
  assert.equal(queryProjects(projects, { keyword: 'discovery special' }).rows[0].id, 'p7')
  assert.equal(queryProjects(projects, { name: 'absent' }).metadata.total, 0)
  assert.equal(queryProjects(projects, {}).metadata.total, 28)
  const page = queryProjects(projects, { limit: '5', offset: '5' })
  assert.deepEqual(page.rows.map(p => p.id), ['p5', 'p6', 'p7', 'p8', 'p9'])
  assert.equal(page.metadata.nextOffset, 10)
  assert.equal(page.metadata.truncated, true)
  assert.equal(queryProjects(projects, { offset: '50' }).metadata.nextOffset, null)
})
test('project query only counts supplied visible projects and explicitly marks compact fields', () => {
  const result = queryProjects(projects.slice(0, 1), { compact: 'true' })
  assert.equal(result.metadata.total, 1)
  assert.ok(result.metadata.omittedFields?.includes('instruction'))
  assert.deepEqual(compactProject(result.rows[0], 2), { id: 'p0', name: 'Project 0', workspace: '/work/repo0', dshRef: { kind: 'mapping', mappingId: 'm0' }, defaultExecutionNodeRef: undefined, defaultAgentIds: ['a'], taskCount: 2 })
})
test('project query rejects invalid limits, offsets and booleans', () => {
  for (const options of [{ limit: '0' }, { limit: '201' }, { limit: '1.5' }, { offset: '-1' }, { offset: 'NaN' }, { compact: 'yes' }]) {
    assert.throws(() => queryProjects(projects, options), (err: any) => err.status === 400)
  }
})
