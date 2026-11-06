import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OnenatDirectory } from '../../dist/onenat.js'
const s = JSON.parse(await readFile(join(homedir(), '.dsh/dsh-onenat/store.json'), 'utf8')).settings.onenat
const directory = new OnenatDirectory(s.baseUrl, s.apiKey)
const report = JSON.parse(await readFile('artifacts/task57/live-acceptance.json', 'utf8'))
try {
  for (const id of [report.ownerId, report.executorId]) {
    await directory.refresh(true)
    const ep = directory.resolveMapping(id), c = await directory.fetchMappingCredentials(id)
    if (!ep?.online || !ep.baseUrl || !c.ok) { console.log({ id, unavailable: true }); continue }
    const get = async route => {
      const r = await fetch(ep.baseUrl + route, { headers: { Authorization: 'Bearer ' + (c.apiKey || c.token) }, signal: AbortSignal.timeout(10000) })
      return (await r.json()).data
    }
    const list = await get('/sessions'), sessions = Array.isArray(list) ? list : list.sessions || list.items || []
    console.log(JSON.stringify({ node: id, listKeys: Object.keys(list || {}).slice(0,10), count: sessions.length, sample: sessions.slice(0,5).map(s => ({ id: s.id || s.sessionId, title: s.title, cwd: s.cwd })) }))
    for (const session of sessions) {
      if (![report.ownerRoot, report.executorRoot].includes(session.cwd) && !(session.title || '').includes(report.tag) && !(session.title || '').startsWith('workspace-remote ') && !(session.title || '').includes('task-57') && !['session-7acfc5ce-4e68-4fbb-a10a-7969d3cb6798','session-70a1fcb7-e657-44b1-9a1f-6edb2549cc28','session-d54a6218-4088-4308-8fa8-4057a26cf4d6','session-a6963e77-e80c-46f4-95ba-c524a2d86e26','session-bdd6afe8-d4ab-4929-bc5e-7bc4abce1241'].includes(session.id)) continue
      const sid = session.id || session.sessionId, info = await get('/sessions/' + sid), hist = await get('/sessions/' + sid + '/history?maxMessages=10')
      console.log(JSON.stringify({ node: id, id: sid, title: session.title, cwd: info.cwd, status: info.status, model: info.model, messages: (hist?.messages || []).map(m => ({ role: m.role, characters: typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length, sentinel: typeof m.content === 'string' && m.content.includes('WORKSPACE_REMOTE_RESULT:'), unsupported: typeof m.content === 'string' && /UNSUPPORTED|UNVERIFIED/.test(m.content), ending: m.role === 'assistant' ? String(m.content).slice(-120).replace(/(?:wba_|dsh_|onk-)[A-Za-z0-9_-]+/g,'[redacted]') : undefined })) }))
    }
  }
} finally { directory.stopAutoRefresh() }
