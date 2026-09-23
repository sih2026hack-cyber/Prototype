import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'argus-api-test-'));
const fixture={id:'youtube:test-only',source:'youtube',content_kind:'comment',text:'Rain in Chennai',created_at:'2026-01-01T00:00:00Z',lang:'en',nlp_row:{lang_confidence:.95,is_code_mixed:false},sentiment:{label:'neutral',score:0,source:'transformer'},entities:[{text:'Chennai',label:'GPE',source:'gazetteer'},{text:'Mars',label:'LOC',source:'model'}]};
fs.writeFileSync(path.join(temp,'corpus.json'),JSON.stringify([fixture]));
const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:'8799',ARGUS_DATA_DIR:temp,AUTO_INGEST:'false',MINIMAX_API_KEY:'',YOUTUBE_API_KEY:'',SUPABASE_SERVICE_ROLE_KEY:'',SUPABASE_SERVICE_KEY:''}});
const base='http://localhost:8799';
try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Test server did not start')),10000);child.once('error',reject);child.once('exit',code=>reject(new Error('Test server exited '+code)));child.stdout.once('data',()=>{clearTimeout(timer);resolve();});});
  const get=route=>fetch(base+route).then(r=>r.json());
  const overview=await get('/api/overview');assert.equal(overview.total_posts,1);assert.equal(overview.sentiment.neutral,1);
  const entities=await get('/api/entities');assert.deepEqual(entities.entities.map(e=>e.text),['Chennai']);
  const pipeline=await get('/api/pipeline');assert.equal(pipeline.embeddings,0);assert.equal(pipeline.topic_count,0);
  const threat=await fetch(base+'/api/plugin/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'I will kill him'})}).then(r=>r.json());assert.equal(threat.verdict,'high_risk');
  const crossOrigin=await fetch(base+'/api/overview',{headers:{Origin:'https://untrusted.example'}});assert.equal(crossOrigin.status,403);
  const chat=await fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'Summarize the comments'})});assert.equal(chat.status,503);
  console.log('Isolated API checks passed; no external services contacted.');
}finally{child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));fs.rmSync(temp,{recursive:true,force:true});}
