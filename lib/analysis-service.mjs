import crypto from 'node:crypto';
import {readLocal,saveLocal,persistCorpus,upsert,readRows,removeLocal} from './storage.mjs';
import {collectYouTube,ServiceError} from './providers.mjs';
import {resolveYouTube,parseYouTubeURL} from './youtube-url.mjs';
import {discoverYouTube,collectSelection,youtubeClient} from './youtube-discovery.mjs';
import {automaticDue,istClock,nextSchedule} from './discovery-core.mjs';
import {worker} from './worker.mjs';
import {enrich} from './enrichment.mjs';
import {scopeRecords,insights,network} from './insights.mjs';
import {validateDemographics} from './demographics.mjs';
import {measuredTopicGrowth} from './trend-history.mjs';
import {settings} from './config.mjs';
import {maskRecord,maskText} from './profanity.mjs';
import {attachSegments,segmentPosts} from './enrichment.mjs';
const successful=r=>['complete','partial'].includes(r.status);
export function createAnalysisService(deps={}){
  const read=deps.read||readLocal,save=deps.save||saveLocal,clock=deps.clock||(()=>new Date()),process=deps.worker||worker;
  const state=read('analysis-index',{runs:[],live:{enabled:false},discovery:{enabled:false,runs:[],budgets:{},snapshots:{},channels:{}}});
  let busy=false,job=null;const now=()=>clock().toISOString(),persist=()=>save('analysis-index',state);
  for(const r of state.runs)if(['running','queued'].includes(r.status)){r.status='failed';r.message='Interrupted when the local server stopped.';}
  for(const r of state.discovery.runs)if(r.status==='running'){r.status='failed';r.message='Interrupted; retry manually.';}
  if(!state.runs.length){const old=read('corpus',[]);if(old.length){const ingest=read('ingest',{});const r={id:'legacy',source_key:'legacy',label:'Original saved analysis',mode:'legacy',status:'complete',started_at:ingest.started_at||now(),completed_at:ingest.completed_at||now(),storage:ingest.storage||{},warnings:[],record_count:old.length};state.runs.push(r);save('analysis-legacy',{run:r,posts:old});}}
  // Daily trending discovery is on by default (AUTO_DISCOVERY=false turns it off); applied once to existing state.
  if(state.discovery.auto_default===undefined){state.discovery.enabled=settings.autoDiscovery;state.discovery.auto_default=true;}
  persist();
  const get=deps.get||youtubeClient(state.discovery,persist,clock);
  const progress=(stage,message)=>{if(job){job.stage=stage;job.message=message;job.updated_at=now();persist();}};
  function select(runId){const r=runId?state.runs.find(r=>r.id===runId):[...state.runs].reverse().find(successful);if(!r||!successful(r))throw new ServiceError('No completed analysis exists for this selection.',404);return r;}
  function view(params={}){const run=select(params.run);const snapshot=read('analysis-'+run.id,null);if(!snapshot)throw new ServiceError('Analysis snapshot unavailable.',404);const posts=(deps.attachSegments||attachSegments)(scopeRecords(snapshot.posts,params)).map(maskRecord);const report=read('audience-'+run.source_key.replace(/[^\w-]/g,'_'),null);const shown={...run,label:maskText(run.label)};const data=insights(posts,shown,params,report);data.growth=measuredTopicGrowth({run,posts},state.runs.filter(r=>successful(r)&&r.source_key===run.source_key).map(r=>read('analysis-'+r.id,null)).filter(Boolean),params);return {posts,run,data};}
  async function persistRun(run,posts){
    const status=await (deps.persistCorpus||persistCorpus)(posts);
    status.verified_rows=0;status.metadata_verified=0;
    for(const [table,field] of [['posts_nlp','verified_rows'],['argus_post_details','metadata_verified']]){
      if(!(table==='posts_nlp'?status.nlp_written:status.metadata_written))continue;
      try{for(let i=0;i<posts.length;i+=50){const ids=posts.slice(i,i+50).map(p=>JSON.stringify(p.id)).join(',');status[field]+=(await (deps.readRows||readRows)(table,'select=post_id&post_id=in.('+encodeURIComponent(ids)+')')).length;}}catch(e){status.errors.push(e.message);}
    }
    const write=deps.upsert||upsert;
    for(const [table,rows,conflict] of [
      ['analysis_runs',[{id:run.id,source_key:run.source_key,created_at:run.started_at,payload:{...run,storage:status}}],'id'],
      ['analysis_records',posts.map(p=>({run_id:run.id,post_id:p.id,payload:p})),'run_id,post_id'],
      ['interaction_edges',network(posts).edges.map(e=>({run_id:run.id,edge_id:e.id,payload:e})),'run_id,edge_id']
    ])try{status[table]=await write(table,rows,conflict);}catch(e){status.errors.push(e.message);status[table]=0;}
    return status;
  }
  async function execute(run,input){
    let discovery;
    try{
      let result;
      if(run.mode==='trending'){
        // Hourly refresh of today's selection: new comments only, no search quota.
        progress('collecting','Refreshing comments from today’s trending channels…');result=await (deps.collectSelection||collectSelection)(state.discovery.selection,get);run.selection=state.discovery.selection;
      }else if(run.mode==='discovery'){
        discovery=await (deps.discover||discoverYouTube)({state:state.discovery,persist,progress,clock,get});
        for(const s of discovery.snapshots){const list=state.discovery.snapshots[s.video_id]||[];list.push(s);state.discovery.snapshots[s.video_id]=list;}
        persist();progress('collecting','Collecting the selected channels and up to 200 comments/replies.');
        result=await (deps.collectSelection||collectSelection)(discovery.selection,get);run.selection=discovery.selection;run.warnings.push(...discovery.warnings);
      }else{
        progress('resolving','Resolving YouTube source…');const source=await resolveYouTube(input.url,get);Object.assign(run,{source_key:source.key,url:source.url,label:source.label,video_ids:source.videoIds});persist();
        progress('collecting','Collecting public video metadata, comments and replies…');result=await (deps.collect||collectYouTube)({videoIds:source.videoIds,maxComments:settings.maxComments,get});
        if(source.kind==='video'&&result.videos[0])run.label=result.videos[0].title;
      }
      // Display names are used only for the in-memory audience estimate and never stored.
      const names=new Map(result.posts.filter(p=>p.author_name).map(p=>[p.id,p.author_name]));result.posts=result.posts.map(({author_name,...p})=>p);
      run.warnings.push(...result.warnings);if(!result.posts.length)throw new ServiceError('No public videos were returned; previous analysis retained.');
      run.video_ids=result.videos.map(v=>v.id).sort();
      const cache=new Map(read('corpus',[]).map(p=>[p.id,p]));for(const r of state.runs.filter(successful)){for(const p of read('analysis-'+r.id,{posts:[]}).posts)cache.set(p.id,p);}
      let posts=result.posts.map(p=>{const old=cache.get(p.id);return old?.text===p.text&&old?.nlp_row?{...old,...p,nuance:old.nuance}:{...p};});
      const missing=posts.filter(p=>!p.nlp_row);
      for(let i=0;i<missing.length;i+=40){progress('analysing',`NLP and sentiment ${Math.min(i+40,missing.length)}/${missing.length} new or changed records`);try{const analysed=await process('analyze',{posts:missing.slice(i,i+40)});const map=new Map(analysed.map(p=>[p.id,p]));posts=posts.map(p=>map.get(p.id)||p);}catch(e){run.warnings.push('NLP batch unavailable: '+e.message);}}
      if(!posts.some(p=>p.nlp_row))throw new ServiceError('NLP could not analyse any records; previous analysis retained.');
      const processed=[];for(const group of [...new Set(posts.map(p=>p.source_group||'manual'))]){
        const batch=posts.filter(p=>(p.source_group||'manual')===group);progress('topics',`Embedding and clustering ${batch.length} records (${group})`);
        try{const output=await process('topics',{posts:batch});processed.push(...output.posts);if(!output.posts.every(p=>p.topic_source==='BERTopic'))run.warnings.push(output.status);}catch(e){for(const p of batch){delete p.topic;delete p.topic_id;delete p.topic_source;delete p.topic_summary;}processed.push(...batch);run.warnings.push('Topic stage unavailable: '+e.message);}
      }
      const enriched=await (deps.enrich||enrich)(processed,progress,undefined,{names});posts=enriched.posts;run.warnings.push(...enriched.warnings);run.warnings=[...new Set(run.warnings)];
      run.completed_at=now();run.record_count=posts.length;run.status=run.warnings.length?'partial':'complete';
      save('analysis-'+run.id,{run:structuredClone(run),posts}); // Frozen analysis evidence; later syncs do not modify it.
      progress('storing','Saving records and historical evidence to Supabase…');run.storage=await persistRun(run,posts);
      if(run.storage.errors.length){run.status='partial';run.warnings.push('Some cloud history tables could not be synced. Full results are saved locally; run the setup migration and retry sync.');}
      if(discovery){state.discovery.selection=discovery.selection;state.discovery.last_success=run.id;for(const c of discovery.selection)state.discovery.channels[c.id]=c;
        for(const [table,rows,conflict] of [['channels',discovery.selection.map(c=>({id:c.id,name:c.name,payload:c,updated_at:now()})),'id'],['video_metric_snapshots',discovery.snapshots,'video_id,observed_at'],['discovery_runs',[{id:run.id,day:run.day,payload:{...run,selection:discovery.selection}}],'id']])try{await (deps.upsert||upsert)(table,rows,conflict);}catch(e){run.warnings.push(e.message);run.status='partial';}
      }
      prune();run.stage='finished';run.message=`${posts.filter(p=>p.content_kind==='video').length} videos and ${posts.filter(p=>p.content_kind!=='video').length} comments/replies analysed.`;
      if(run.mode==='live')state.live.last_at=now();
    }catch(e){run.status='failed';run.stage='failed';run.message=e.message;run.completed_at=now();}
    finally{if(run.mode==='discovery'){const item=state.discovery.runs.find(r=>r.id===run.id);Object.assign(item,{status:run.status,message:run.message});}busy=false;job=null;persist();const next=queue.shift();if(next)launch(next.run,next.input);}
  }
  // Links the user submits while a background refresh is running wait here and start next (before any other refresh).
  const queue=[];
  function start(input={}){
    const mode=['discovery','live','trending'].includes(input.mode)?input.mode:'manual';
    if(busy&&mode!=='manual')throw new ServiceError('Another collection or sync is already running.',409);
    if(!['discovery','trending'].includes(mode))parseYouTubeURL(input.url);
    if(mode==='trending'&&!state.discovery.selection?.length)throw new ServiceError('No trending selection yet.',409);
    const day=istClock(clock()).day;
    if(mode==='discovery'){
      const today=state.discovery.runs.filter(r=>r.day===day);const done=today.find(successful);if(done)return {accepted:false,run_id:done.id,message:'Today’s discovery is already complete.'};
      if(today.length>=3)throw new ServiceError('Daily discovery retry limit reached; previous selection retained.',429);
    }
    const run={id:crypto.randomUUID(),mode,day,source_key:['discovery','trending'].includes(mode)?'discovery':'pending',label:mode==='discovery'?'India daily discovery':mode==='trending'?'Trending today (refreshed)':'Resolving source',url:input.url||null,started_at:now(),status:'running',stage:'queued',warnings:[]};
    if(busy){
      if(queue.some(q=>q.input.url===input.url))return {accepted:true,queued:true,run_id:queue.find(q=>q.input.url===input.url).run.id};
      Object.assign(run,{status:'queued',stage:'queued',message:'Waiting for the current refresh to finish…'});state.runs.push(run);queue.push({run,input});persist();return {accepted:true,queued:true,run_id:run.id};
    }
    state.runs.push(run);launch(run,input);return {accepted:true,run_id:run.id};
  }
  function launch(run,input){
    Object.assign(run,{status:'running',stage:'queued',started_at:now()});busy=true;job=run;if(run.mode==='discovery')state.discovery.runs.push({id:run.id,day:run.day,status:'running'});persist();void execute(run,input);
  }
  async function sync(runId){if(busy)throw new ServiceError('Collection or sync is already running.',409);busy=true;try{const runs=runId?[select(runId)]:state.runs.filter(successful);let result;
    for(const run of runs){const posts=read('analysis-'+run.id,{posts:[]}).posts;run.storage=await persistRun(run,posts);result=run.storage;}
    for(const [table,file] of [['moderation_logs','moderation'],['chat_evidence','chat-evidence']]){let rows=read(file,[]);if(table==='moderation_logs')rows=rows.map(p=>({id:p.id,created_at:p.created_at,payload:p}));try{if(result)result[table]=await (deps.upsert||upsert)(table,rows,'id');}catch(e){result?.errors.push(e.message);}}
    // These are historical records, not replacements of the current source selection.
    for(const r of state.runs.filter(r=>successful(r)&&r.mode==='discovery')){const snap=read('analysis-'+r.id,null);if(!snap)continue;for(const [table,rows,conflict] of [['channels',(r.selection||[]).map(c=>({id:c.id,name:c.name,payload:c,updated_at:r.completed_at})),'id'],['discovery_runs',[{id:r.id,day:r.day,payload:r}],'id'],['video_metric_snapshots',Object.values(state.discovery.snapshots).flat(),'video_id,observed_at']])try{await (deps.upsert||upsert)(table,rows,conflict);}catch(e){result?.errors.push(e.message);}}
    for(const key of new Set(state.runs.map(r=>r.source_key))){const r=read('audience-'+key.replace(/[^\w-]/g,'_'),null);if(r)try{await (deps.upsert||upsert)('audience_reports',[{id:key,payload:r}],'id');}catch(e){result?.errors.push(e.message);}}
    persist();return result||{errors:[],verified_rows:0};}finally{busy=false;}}
  function live(input){if(typeof input.enabled!=='boolean')throw new ServiceError('enabled must be boolean.',400);if(input.enabled){const run=select(input.run);if(!run.url||run.mode==='discovery')throw new ServiceError('Choose a URL analysis before enabling live refresh.',400);state.live={enabled:true,url:run.url,source_key:run.source_key,last_at:now()};}else state.live.enabled=false;persist();return state.live;}
  function discoveryEnabled(enabled){if(typeof enabled!=='boolean')throw new ServiceError('enabled must be boolean.',400);state.discovery.enabled=enabled;persist();return discoveryStatus();}
  function discoveryStatus(){const lastTrend=Math.max(Date.parse(state.discovery.last_refresh_at||0),Date.parse(state.runs.find(r=>r.id===state.discovery.last_success)?.completed_at||0));return {enabled:state.discovery.enabled,next_at:nextSchedule(clock()),refresh_minutes:deps.refreshMinutes??settings.trendingRefreshMinutes,last_refresh_at:lastTrend?new Date(lastTrend).toISOString():null,next_refresh_at:lastTrend&&state.discovery.selection?.length?new Date(lastTrend+(deps.refreshMinutes??settings.trendingRefreshMinutes)*60000).toISOString():null,budget:state.discovery.budgets[istClock(clock()).day]||{search:0,total:0},runs:state.discovery.runs,selection:state.discovery.selection||[],last_success:state.discovery.last_success||null,stale:!state.discovery.last_success||state.runs.find(r=>r.id===state.discovery.last_success)?.day<istClock(clock()).day};}
  async function importAudience(input){const run=select(input.run);const report=validateDemographics(input);report.source_key=run.source_key;save('audience-'+run.source_key.replace(/[^\w-]/g,'_'),report);try{await (deps.upsert||upsert)('audience_reports',[{id:run.source_key,payload:report}],'id');report.storage='Supabase + local';}catch{report.storage='Local only; migration/sync needed';}return report;}
  // Backfills self-described segments for a saved run; writes only to the enrichment cache.
  async function refreshSegments(runId){if(busy)throw new ServiceError('Collection or sync is already running.',409);const run=select(runId);const snapshot=read('analysis-'+run.id,null);if(!snapshot)throw new ServiceError('Analysis snapshot unavailable.',404);
    busy=true;job={id:run.id,stage:'segments',message:'Estimating audience segments…',updated_at:now()};
    try{const r=await (deps.segmentPosts||segmentPosts)(snapshot.posts,(stage,message)=>{job.message=message;});if(!r.estimated&&r.warnings.length)throw new ServiceError(r.warnings[0],502);return {estimated:r.estimated,total:r.total,warnings:r.warnings};}finally{busy=false;job=null;}}
  // Keep only the newest refresh runs per source so hourly/5-minute refreshes don't grow storage forever.
  function prune(){const keep=deps.keepRefreshRuns??settings.keepRefreshRuns;const bySource=new Map();
    for(const r of [...state.runs].reverse()){if(!['live','trending'].includes(r.mode)||r.status==='running')continue;const list=bySource.get(r.source_key)||[];list.push(r);bySource.set(r.source_key,list);}
    const drop=new Set([...bySource.values()].flatMap(list=>list.slice(keep)).map(r=>r.id));
    if(!drop.size)return;for(const id of drop)(deps.remove||removeLocal)('analysis-'+id);state.runs=state.runs.filter(r=>!drop.has(r.id));persist();}
  function tick(){if(busy||queue.length)return;try{if(state.discovery.enabled&&automaticDue(state.discovery,clock())){start({mode:'discovery'});return;}if(state.live.enabled&&clock()-new Date(state.live.last_at)>=300000){state.live.last_at=now();persist();start({mode:'live',url:state.live.url});return;}
    const lastTrend=Math.max(Date.parse(state.discovery.last_refresh_at||0),Date.parse(state.runs.find(r=>r.id===state.discovery.last_success)?.completed_at||0));
    if(state.discovery.enabled&&state.discovery.selection?.length&&clock()-lastTrend>=(deps.refreshMinutes??settings.trendingRefreshMinutes)*60000){state.discovery.last_refresh_at=now();persist();start({mode:'trending'});}}catch{/* Explicit job errors appear in status; no background retry storm. */}}
  return {start,view,sync,live,refreshSegments,discoveryEnabled,discoveryStatus,importAudience,tick,status:()=>({busy,job,runs:[...state.runs].reverse().map(r=>({...r,label:maskText(r.label)})),live:state.live}),withLock:async(fn)=>{if(busy)throw new ServiceError('Collection or sync running.',409);busy=true;try{return await fn();}finally{busy=false;}}};
}
