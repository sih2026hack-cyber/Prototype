import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT,settings} from './lib/config.mjs';
import {readLocal,saveLocal,upsert} from './lib/storage.mjs';
import {ServiceError} from './lib/providers.mjs';
import {moderate,inspectDraft} from './lib/moderation.mjs';
import {redact} from './lib/privacy.mjs';
import {chat} from './lib/chat.mjs';
import {aggregate,civicEntities} from './lib/analytics.mjs';
import {createAnalysisService} from './lib/analysis-service.mjs';
import {reportPDF} from './lib/report.mjs';
const service=createAnalysisService();
const decisions=readLocal('moderation',[]);
function json(res,value,code=200){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
async function body(req){let value='';for await(const chunk of req){value+=chunk;if(value.length>24000)throw new ServiceError('Request too large.',413);}try{return JSON.parse(value||'{}');}catch{throw new ServiceError('Invalid JSON.',400);}}
function textInput(value,max=4000){if(typeof value!=='string'||!value.trim()||value.length>max)throw new ServiceError('Enter a nonempty value within the allowed length.',400);return redact(value.trim());}
async function saveDecision(item){try{await upsert('moderation_logs',[{id:item.id,created_at:item.created_at,payload:item}],'id');item.storage='Supabase + local';}catch{item.storage='Local only - cloud sync needed';}saveLocal('moderation',decisions.slice(0,300));return item.storage;}
const filters=url=>Object.fromEntries(['run','from','to','group'].map(k=>[k,url.searchParams.get(k)||'']));
async function api(req,res,url){
  const route=url.pathname;
  if(req.method==='GET'){
    if(route==='/api/health'||route==='/api/ingest/status')return json(res,{ok:true,running:service.status().busy,ingest:service.status().job,supabase_configured:!!settings.supabaseKey,minimax_configured:!!settings.miniKey});
    if(route==='/api/analysis/runs'||route==='/api/analysis/status')return json(res,service.status());
    if(route==='/api/discovery/status')return json(res,service.discoveryStatus());
    if(route==='/api/channels'){const status=service.discoveryStatus();const run=url.searchParams.get('run');return json(res,{channels:run?service.view({run}).run.selection||[]:status.selection,stale:status.stale});}
    if(route==='/api/plugin/decisions'||route==='/moderate/analytics')return json(res,{enabled:true,decisions:decisions.slice(0,30)});
    const params=filters(url);params.group||='combined';
    if(['/api/view','/api/report.pdf','/api/network','/api/overview','/api/sentiment','/api/topics','/api/entities','/api/audience','/api/posts','/api/videos','/api/pipeline'].includes(route)){
      const {posts,run,data}=service.view(params);
      if(route==='/api/view')return json(res,data);
      if(route==='/api/report.pdf'){const pdf=await reportPDF(data);res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="ARGUS-report.pdf"','Cache-Control':'no-store'});res.end(pdf);return;}
      if(route==='/api/network')return json(res,data.network);
      if(route==='/api/overview')return json(res,{...data.summary,source:'live',provider:'youtube',ingest:{...run,state:run.status,mode:'live'},moderator_enabled:false});
      if(route==='/api/sentiment')return json(res,{points:posts.filter(p=>p.content_kind!=='video').map(p=>({date:p.created_at,...p.sentiment,severity:p.event_polarity?.severity??null}))});
      if(route==='/api/topics')return json(res,{topics:data.topics});
      if(route==='/api/entities')return json(res,{entities:data.entities});
      if(route==='/api/audience')return json(res,{segments:Object.entries(data.summary.languages).map(([name,count])=>({name,count})),report:data.audienceReport});
      if(route==='/api/posts')return json(res,{posts:posts.filter(p=>p.content_kind!=='video').map(({embedding,nlp_row,author_ref,...p})=>({...p,entities:civicEntities(p)}))});
      if(route==='/api/videos')return json(res,{videos:data.videos});
      if(route==='/api/pipeline')return json(res,{...data.coverage,total:posts.length,topic_count:data.topics.length,stored:run.storage?.verified_rows||0,metadata_stored:run.storage?.metadata_verified||0,running:service.status().busy,state:run.status});
    }
  }
  if(req.method==='POST'){
    const input=await body(req);
    if(route==='/api/analysis/run')return json(res,service.start({url:input.url}),202);
    if(route==='/api/ingest/run'){const run=service.view({run:input.run}).run;if(!run.url)throw new ServiceError('Paste a YouTube link to start a new analysis.',400);return json(res,service.start({url:run.url}),202);}
    if(route==='/api/analysis/live')return json(res,service.live(input));
    if(route==='/api/discovery/run')return json(res,service.start({mode:'discovery'}),202);
    if(route==='/api/discovery/settings')return json(res,service.discoveryEnabled(input.enabled));
    if(route==='/api/storage/sync')return json(res,await service.sync(input.run));
    if(route==='/api/audience/import')return json(res,await service.importAudience(input));
    if(route==='/api/chat'){
      const {posts,run,data}=service.view({run:input.run,from:input.from,to:input.to,group:input.group||'combined'});
      const context={run:{id:run.id,label:run.label,collection:run.completed_at},filters:data.filters,topics:data.topics,emotions:data.emotions,audience:data.audienceReport,network:{leaders:data.network.leaders,limits:data.network.limitations},growth:data.growth,selection:run.selection||[],limitations:data.limitations};
      return json(res,await chat(textInput(input.question),input.history,posts,run,context));
    }
    if(route==='/api/plugin/preview')return json(res,inspectDraft(textInput(input.text,2000)));
    if(['/api/plugin/check','/moderate','/moderate/rewrite'].includes(route)){const text=textInput(input.text,2000),result=await moderate(text);const item={...result,id:crypto.randomUUID(),original_text:text,created_at:new Date().toISOString(),accepted:false};decisions.unshift(item);item.storage=await saveDecision(item);return json(res,item);}
    if(route==='/api/plugin/accept'){const item=decisions.find(x=>x.id===input.id);if(!item?.corrected_text||!item.complete)throw new ServiceError('No verified suggestion to accept.',400);item.accepted=true;item.accepted_at=new Date().toISOString();item.storage=await saveDecision(item);return json(res,{text:item.corrected_text,storage:item.storage});}
  }
  return json(res,{error:'Not found'},404);
}
const assets=new Map([['/',['frontend/index.html','text/html']],['/frontend/index.html',['frontend/index.html','text/html']],['/frontend/app.js',['frontend/dashboard.js','text/javascript']],['/frontend/styles.css',['frontend/styles.css','text/css']],['/frontend/chat.css',['frontend/chat.css','text/css']],['/setup.sql',['supabase/live-extension.sql','text/plain']]]);
assets.set('/frontend/insights.css',['frontend/insights.css','text/css']);
http.createServer(async(req,res)=>{
  try{
    if(![`localhost:${settings.port}`,`127.0.0.1:${settings.port}`].includes(req.headers.host))return json(res,{error:'Invalid host'},403);
    if(req.headers.origin&&![`http://localhost:${settings.port}`,`http://127.0.0.1:${settings.port}`].includes(req.headers.origin))return json(res,{error:'Cross-origin requests are not allowed'},403);
    const url=new URL(req.url,`http://127.0.0.1:${settings.port}`);
    if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/moderate'))return await api(req,res,url);
    const asset=assets.get(url.pathname);if(!asset||req.method!=='GET')return json(res,{error:'Not found'},404);
    res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"});res.end(fs.readFileSync(path.join(ROOT,asset[0])));
  }catch(error){json(res,{error:error.status?error.message:'Operation failed. Check service availability and retry.'},error.status||500);}
}).listen(settings.port,'127.0.0.1',()=>{console.log(`ARGUS http://localhost:${settings.port}`);service.tick();});
setInterval(()=>service.tick(),30000).unref();
