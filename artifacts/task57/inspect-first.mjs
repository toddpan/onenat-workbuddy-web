import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OnenatDirectory } from '../../dist/onenat.js'
const s=JSON.parse(await readFile(join(homedir(),'.dsh/dsh-onenat/store.json'),'utf8')).settings.onenat
const d=new OnenatDirectory(s.baseUrl,s.apiKey), report=JSON.parse(await readFile(process.env.TASK57_REPORT || 'artifacts/task57/live-acceptance-first.json','utf8'))
const out=[]
try {
for(const node of [report.ownerId,report.executorId]){
 await d.refresh(true);const ep=d.resolveMapping(node),c=await d.fetchMappingCredentials(node)
 for(const rec of report.cleanup.filter(x=>x.node===node&&x.sessionId)){
 const r=await fetch(ep.baseUrl+'/sessions/'+rec.sessionId+'/history?maxMessages=50',{headers:{Authorization:'Bearer '+(c.apiKey||c.token)},signal:AbortSignal.timeout(15000)})
 const j=await r.json();const scrub=v=>String(v).split(s.apiKey).join('[directory-key]').split(c.apiKey||c.token||'__missing__').join('[node-key]').replace(/(?:wba_|dsh_|onk-)[A-Za-z0-9_-]+/g,'[redacted]');out.push({node,sessionId:rec.sessionId,status:r.status,data:r.ok?{messages:(j.data?.messages||[]).filter(m=>m.role==='assistant').map(m=>({role:m.role,content:scrub(m.content)}))}:{error:j.error}})
 }
}
}finally{d.stopAutoRefresh();await writeFile(process.env.TASK57_HISTORY_OUT || 'artifacts/task57/first-histories.json',JSON.stringify(out,null,2));console.log(out.map(x=>({node:x.node,id:x.sessionId,status:x.status,messages:x.data?.messages?.length}))) }
