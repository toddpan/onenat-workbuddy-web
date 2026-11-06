import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OnenatDirectory } from '../../dist/onenat.js'
const settings = JSON.parse(await readFile(join(homedir(), '.dsh/dsh-onenat/store.json'), 'utf8')).settings.onenat
const directory = new OnenatDirectory(settings.baseUrl, settings.apiKey)
const report = { at: new Date().toISOString(), nodes: [] }
try {
  for (const id of ['6cc2987d', '5602f2c2']) {
    await directory.refresh(true)
    const ep = directory.resolveMapping(id)
    if (!ep?.online || !ep.baseUrl) throw Error('Node offline: ' + id)
    const cred = await directory.fetchMappingCredentials(id)
    if (!cred.ok) throw Error('Authorized credential unavailable for ' + id)
    const headers = { Authorization: 'Bearer ' + (cred.apiKey || cred.token) }
    const call = async route => {
      const res = await fetch(ep.baseUrl + route, { headers, signal: AbortSignal.timeout(10000) })
      const j = await res.json()
      if (!res.ok || !j.ok) throw Error('DSH ' + route + ': HTTP ' + res.status)
      return j.data
    }
    const status = await call('/system/status'), models = await call('/models'), def = await call('/models/default')
    const node = { mappingId: id, name: ep.appName, baseUrl: ep.baseUrl, status: { name: status.name, version: status.version }, defaultModel: def, testModelAvailable: (models.models || models).some(m => m.provider === 'deepseek-official' && m.id === 'deepseek-v4-flash') }
    report.nodes.push(node)
    console.log(JSON.stringify(node))
  }
} finally { directory.stopAutoRefresh(); await writeFile('artifacts/task57/live-preflight.json', JSON.stringify(report, null, 2)) }
