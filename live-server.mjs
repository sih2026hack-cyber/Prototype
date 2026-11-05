import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT,settings,server,env} from './lib/config.mjs';
import {readLocal,saveLocal,upsert,restoreState} from './lib/storage.mjs';
import {ServiceError} from './lib/providers.mjs';
const restored=await restoreState(); // must run before any module reads runtime state
if(restored)console.log(`Restored ${restored} state files from Supabase`);
import {moderator,moderatorModel} from './lib/moderation.mjs';
import {lens,lensStatus} from './lib/lens.mjs';
import {createExtensionApi} from './lib/extension-api.mjs';
import {createModeratorService,moderatorHandler} from './ai-moderator-plugin/src/index.mjs';
import {redact} from './lib/privacy.mjs';
import {chat} from './lib/chat.mjs';
import {aggregate,civicEntities} from './lib/analytics.mjs';
import {createAnalysisService} from './lib/analysis-service.mjs';
import {reportPDF} from './lib/report.mjs';
const service=createAnalysisService();
// Writing moderator (ai-moderator-plugin/): decisions are kept locally and mirrored to Supabase.
const plugin=createModeratorService({moderator,decisions:readLocal('moderation',[]),persist:async(item,decisions)=>{let storage;try{await upsert('moderation_logs',[{id:item.id,created_at:item.created_at,payload:item}],'id');storage='Supabase + local';}catch{storage='Local only - cloud sync needed';}saveLocal('moderation',decisions.slice(0,300));return storage;}});
// Plugin routes under /api/plugin: preview, check, accept, ask, status, decisions (+ queue and resolve when ARGUS_MODERATOR_SECRET is set).
const pluginRoutes=moderatorHandler(plugin,{base:'/api/plugin',moderatorSecret:env.ARGUS_MODERATOR_SECRET||null});
// Browser extension routes (/api/ext/*: comment moderator, /api/lens/*: Argus Lens images and videos).
const extensionApi=createExtensionApi({plugin,moderator,lens});
// Local: only localhost. Public (Render): its hostname, behind HTTP Basic Auth.
const localHosts=[`localhost:${settings.port}`,`127.0.0.1:${settings.port}`];
const allowedHost=h=>localHosts.includes(h)||server.hosts.includes(String(h||'').toLowerCase().replace(/:\d+$/,''));
const allowedOrigin=(o,h)=>{try{const u=new URL(o);return u.host===h&&(u.protocol==='https:'||localHosts.includes(u.host));}catch{return false;}};
const same=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y);};
function authorized(req){
  if(!server.isPublic)return true;
  if(!server.password)return false; // never serve a public instance without a password
  const [scheme,token]=String(req.headers.authorization||'').split(' ');
  if(scheme!=='Basic'||!token)return false;
  const [user,...rest]=Buffer.from(token,'base64').toString().split(':');
  return same(user,server.user)&&same(rest.join(':'),server.password);
}
function json(res,value,code=200){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
async function body(req){let value='';for await(const chunk of req){value+=chunk;if(value.length>24000)throw new ServiceError('Request too large.',413);}try{return JSON.parse(value||'{}');}catch{throw new ServiceError('Invalid JSON.',400);}}
function textInput(value,max=4000){if(typeof value!=='string'||!value.trim()||value.length>max)throw new ServiceError('Enter a nonempty value within the allowed length.',400);return redact(value.trim());}
const filters=url=>Object.fromEntries(['run','from','to','group'].map(k=>[k,url.searchParams.get(k)||'']));
async function api(req,res,url){
  const route=url.pathname;
  if(req.method==='GET'){
    if(route==='/api/health'||route==='/api/ingest/status')return json(res,{ok:true,running:service.status().busy,ingest:service.status().job,supabase_configured:!!settings.supabaseKey,minimax_configured:!!settings.miniKey,moderator_model:moderatorModel(),lens:lensStatus()});
    if(route==='/api/analysis/runs'||route==='/api/analysis/status')return json(res,service.status());
    if(route==='/api/discovery/status')return json(res,service.discoveryStatus());
    if(route==='/api/channels'){const status=service.discoveryStatus();const run=url.searchParams.get('run');return json(res,{channels:run?service.view({run}).run.selection||[]:status.selection,stale:status.stale});}
    if(route==='/moderate/analytics')return json(res,{enabled:true,decisions:plugin.recent()});
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
      if(route==='/api/posts')return json(res,{posts:posts.filter(p=>p.content_kind!=='video').map(({embedding,nlp_row,author_ref,estimate,...p})=>({...p,entities:civicEntities(p)}))});
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
    if(route==='/api/segments/refresh')return json(res,await service.refreshSegments(input.run));
    if(route==='/api/audience/import')return json(res,await service.importAudience(input));
    if(route==='/api/chat'){
      const {posts,run,data}=service.view({run:input.run,from:input.from,to:input.to,group:input.group||'combined'});
      const context={run:{id:run.id,label:run.label,collection:run.completed_at},filters:data.filters,topics:data.topics,emotions:data.emotions,audience:data.audienceReport,audienceSegments:data.audienceSegments,audienceEstimates:data.audienceEstimates,participation:data.participation,network:{leaders:data.network.leaders,limits:data.network.limitations},growth:data.growth,selection:run.selection||[],limitations:data.limitations};
      return json(res,await chat(textInput(input.question),input.history,posts,run,context));
    }
    if(['/moderate','/moderate/rewrite'].includes(route))return json(res,await plugin.check(input.text,input.replyingTo));
  }
  return json(res,{error:'Not found'},404);
}
const assets=new Map([['/plugin/moderator-widget.js',['ai-moderator-plugin/widget/moderator-widget.js','text/javascript']],['/plugin/moderator-widget.css',['ai-moderator-plugin/widget/moderator-widget.css','text/css']],['/',['frontend/index.html','text/html']],['/frontend/index.html',['frontend/index.html','text/html']],['/frontend/app.js',['frontend/dashboard.js','text/javascript']],['/frontend/styles.css',['frontend/styles.css','text/css']],['/frontend/chat.css',['frontend/chat.css','text/css']],['/setup.sql',['supabase/live-extension.sql','text/plain']]]);
assets.set('/frontend/insights.css',['frontend/insights.css','text/css']);
// Argus Lens page: check a photo or video file (also opened from the extension's toolbar panel).
assets.set('/lens',['lens/page/index.html','text/html']);assets.set('/lens/lens.js',['lens/page/lens.js','text/javascript']);
http.createServer(async(req,res)=>{
  try{
    if(req.url==='/healthz')return json(res,{ok:true}); // Render health check, no data
    if(!allowedHost(req.headers.host))return json(res,{error:'Invalid host'},403);
    // The browser extension (extension/) may call only its own routes. With ARGUS_EXTENSION_KEY set it must
    // send that key, which also lets it past the password on a public deployment.
    const extRoute=/^\/api\/(?:ext|lens)\//.test(req.url),fromExtension=String(req.headers.origin||'').startsWith('chrome-extension://');
    const extKeyOk=!!env.ARGUS_EXTENSION_KEY&&same(req.headers['x-extension-key']||'',env.ARGUS_EXTENSION_KEY);
    if(extRoute&&fromExtension&&env.ARGUS_EXTENSION_KEY&&!extKeyOk)return json(res,{error:"This extension isn't set up for this server. Add the extension key in its settings."},401);
    if(req.headers.origin&&!(extRoute&&fromExtension)&&!allowedOrigin(req.headers.origin,req.headers.host))return json(res,{error:'Cross-origin requests are not allowed'},403);
    if(!authorized(req)&&!(extRoute&&extKeyOk)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="ARGUS", charset="UTF-8"','Content-Type':'text/plain; charset=utf-8'});res.end(server.password?'Sign in to ARGUS.':'Set ARGUS_PASSWORD in the Render environment to use this deployment.');return;}
    const url=new URL(req.url,`http://127.0.0.1:${settings.port}`);
    if(url.pathname.startsWith('/api/plugin/'))return await pluginRoutes(req,res);
    if(await extensionApi(req,res,url))return;
    const sample=url.pathname.match(/^\/lens\/samples\/([a-z-]+\.(webp|mp4))$/);
    if(sample&&req.method==='GET'&&fs.existsSync(path.join(ROOT,'lens/page/samples',sample[1]))){res.writeHead(200,{'Content-Type':sample[2]==='mp4'?'video/mp4':'image/webp','Cache-Control':'max-age=3600','X-Content-Type-Options':'nosniff'});res.end(fs.readFileSync(path.join(ROOT,'lens/page/samples',sample[1])));return;}
    if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/moderate'))return await api(req,res,url);
    const asset=assets.get(url.pathname);if(!asset||req.method!=='GET')return json(res,{error:'Not found'},404);
    // The Lens page shows the user's own files (blob: URLs) and uses the Inter web font.
    const csp=url.pathname==='/lens'?"default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self' blob: data:; img-src 'self' data: blob:; media-src 'self' blob: data:; frame-ancestors 'none'":"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'";
    res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':csp});res.end(fs.readFileSync(path.join(ROOT,asset[0])));
  }catch(error){json(res,{error:error.status?error.message:'Operation failed. Check service availability and retry.'},error.status||500);}
}).listen(settings.port,server.host,()=>{console.log(`ARGUS listening on ${server.host}:${settings.port}${server.isPublic?' (public, password '+(server.password?'set':'MISSING')+')':''}`);});
// First automatic check after 30 s, so a request made right after startup is not blocked by a background refresh.
setInterval(()=>service.tick(),30000).unref();
