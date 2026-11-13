import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { OnenatDirectory } from '../../dist/onenat.js'
import { DshClient } from '../../dist/remote-client.js'
import { remote } from '../../scripts/workspace-remote.mjs'
const s=JSON.parse(await readFile(join(homedir(),'.dsh/dsh-onenat/store.json'),'utf8')).settings.onenat
const d=new OnenatDirectory(s.baseUrl,s.apiKey),client=new DshClient(),node='6cc2987d'
const tag='wb-task57-'+randomBytes(8).toString('hex'), root='/tmp/'+tag+'-owner'
const secrets=new Set([s.apiKey]), scrub=value=>{let text=String(value);for(const key of secrets)if(key)text=text.split(key).join('[redacted]');return text}
const report={at:new Date().toISOString(),node,root,requests:[],cleanup:[]}
const nativeFetch=globalThis.fetch;let sid
async function target(){await d.refresh(true);const e=d.resolveMapping(node),c=await d.fetchMappingCredentials(node);assert.ok(e?.online&&c.ok);secrets.add(c.apiKey||c.token);return{baseUrl:e.baseUrl,apiKey:c.apiKey||c.token}}
globalThis.fetch=async(url,init={})=>{const u=new URL(String(url));const r=await nativeFetch(url,init);if(u.pathname.includes('/api/v1/sessions')){report.requests.push({method:init.method||'GET',route:u.pathname,status:r.status});if(u.pathname.endsWith('/sessions')&&init.method==='POST'&&r.ok)sid=(await r.clone().json()).data?.sessionId}return r}
try{
 const t=await target();assert.equal((await client.fsMkdir(t,'/tmp',tag+'-owner')).ok,true)
 assert.equal((await client.fsUpload(t,root,[{filename:'probe.txt',data:Buffer.from(randomBytes(12).toString('hex'))}])).ok,true)
 report.result=await remote({operation:'list',root,nonce:randomBytes(24).toString('hex')},{nodeRef:'mapping:'+node,onenatBase:s.baseUrl,onenatApiKey:s.apiKey,apiKey:t.apiKey,requestTimeoutMs:180000})
 assert.equal(report.result.ok,true);assert.ok(report.result.entries.some(e=>e.name==='probe.txt'));report.ok=true
}catch(e){report.ok=false;report.error={code:e.code,message:scrub(e.message)};process.exitCode=1}
finally{
 try{const t=await target();if(sid){const r=await fetch(t.baseUrl+'/sessions/'+sid+'/history?maxMessages=30',{headers:{Authorization:'Bearer '+t.apiKey},signal:AbortSignal.timeout(10000)});const j=await r.json();report.assistantHistory=(j.data?.messages||[]).filter(m=>m.role==='assistant').map(m=>scrub(m.content));await client.cancelSession(t,sid);const deleted=await fetch(t.baseUrl+'/sessions/'+sid,{method:'DELETE',headers:{Authorization:'Bearer '+t.apiKey},signal:AbortSignal.timeout(10000)});report.cleanup.push({sessionId:sid,archived:deleted.ok})}assert.ok(/^\/tmp\/wb-task57-[a-f0-9]{16}-owner$/.test(root));report.cleanup.push({root,removed:(await client.fsRemove(t,root)).ok});assert.equal((await client.fsList(t,root,true)).ok,false)}catch(e){report.cleanup.push({error:scrub(e.message)});process.exitCode=1}
 globalThis.fetch=nativeFetch;d.stopAutoRefresh();await writeFile('artifacts/task57/owner-probe.json',JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,error:report.error,result:report.result,cleanup:report.cleanup}))
}
