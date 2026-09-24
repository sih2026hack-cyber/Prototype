import assert from 'node:assert/strict';
import {parseYouTubeURL,resolveYouTube} from '../lib/youtube-url.mjs';
import {network,scopeRecords,insights} from '../lib/insights.mjs';
import {automaticDue,rankChannels,reserveRequest,viewRate} from '../lib/discovery-core.mjs';
import {createAnalysisService} from '../lib/analysis-service.mjs';
import {validateDemographics} from '../lib/demographics.mjs';
import {collectYouTube} from '../lib/providers.mjs';
const video='abcdefghijk';
for(const url of [`https://youtu.be/${video}`,`https://www.youtube.com/watch?v=${video}&t=20`,`https://youtube.com/shorts/${video}`])assert.equal(parseYouTubeURL(url).id,video);
for(const url of ['https://evil.test/watch?v=abcdefghijk','https://youtube.com.evil.test/watch?v=abcdefghijk','file:///youtube.com/watch?v=abcdefghijk','https://youtube.com:444/watch?v=abcdefghijk','https://youtube.com/playlist?list=test','http://127.0.0.1:80'])assert.throws(()=>parseYouTubeURL(url));
assert.equal(parseYouTubeURL('https://youtube.com/@news/videos').forHandle,'@news');
const channel='UC'+'x'.repeat(22);
const resolved=await resolveYouTube('https://youtube.com/@news',async(resource,params)=>resource==='channels'?{items:[{id:channel,snippet:{title:'Renamed'},contentDetails:{relatedPlaylists:{uploads:'playlist'}}}]}:{items:[{contentDetails:{videoId:video}}]});assert.equal(resolved.key,'channel:'+channel);
const date='2026-09-23T04:00:00Z';
const records=[{id:'youtube:p',video_id:video,author_ref:'hash1',content_kind:'comment',created_at:date,text:'hello',metrics:{like_count:null}},{id:'youtube:r',video_id:video,author_ref:'hash2',content_kind:'reply',parent_id:'youtube:p',created_at:date,text:'reply',metrics:{like_count:3}}];
const net=network(records);assert.equal(net.edges.filter(e=>e.type==='reply').length,1);assert.equal(net.leaders[0].unique_incoming_repliers,1);assert.equal(net.leaders[0].likes,null);
assert.equal(network([records[1]]).edges.filter(e=>e.type==='reply').length,0);
assert.throws(()=>scopeRecords(records,{from:'2026-02-31'}));assert.equal(scopeRecords(records,{from:'2026-09-24'}).length,0);
assert.equal(insights([{...records[0],topic_source:'BERTopic',topic_id:-1}],{}).topics.length,0);
const report=validateDemographics({source:'opt_in_survey',aggregate_only:true,population:'Voluntary survey',sample_size:100,dimensions:{age:[{label:'18-24',percent:5,count:5},{label:'25-34',percent:95,count:95}]}});assert.equal(report.dimensions.age[0].percent,null);assert.equal(report.dimensions.age[1].percent,95);
assert.equal(automaticDue({runs:[]},new Date('2026-09-23T03:29:00Z')),false);assert.equal(automaticDue({runs:[]},new Date('2026-09-23T03:30:00Z')),true);assert.equal(automaticDue({runs:[{day:'2026-09-23'}]},new Date(date)),false);
assert.equal(automaticDue({runs:[{day:'2026-09-20'}]},new Date('2026-09-23T01:00:00Z')),true);
const budget={};for(let i=0;i<20;i++)reserveRequest(budget,'search',new Date(date));assert.throws(()=>reserveRequest(budget,'search',new Date(date)));reserveRequest(budget,'videos',new Date(date));
const v={id:video,group:'public_issues',snippet:{channelId:channel,title:'Report',publishedAt:'2026-09-22T04:00:00Z'},statistics:{viewCount:'240'}};
assert.equal(viewRate(v,[],new Date(date)).rate,10);assert.equal(viewRate(v,[{observed_at:'2026-09-22T04:00:00Z',view_count:120}],new Date(date)).rate,5);assert.equal(viewRate({...v,statistics:{}},[],new Date(date)).rate,null);
const ranked=rankChannels([v],[{id:channel,snippet:{title:'New display name'}}],{},new Date(date));assert.equal(ranked[0].id,channel);assert.equal(ranked[0].name,'New display name');
let requests=[];const collected=await collectYouTube({videoIds:[video],maxComments:3,get:async(resource,params)=>{requests.push([resource,params]);if(resource==='videos')return {items:[{id:video,snippet:{title:'Video',description:'Description',publishedAt:date,channelId:channel},statistics:{viewCount:'20'}}]};if(resource==='commentThreads')return {items:[{snippet:{topLevelComment:{id:'one',snippet:{textOriginal:'text',publishedAt:date}},totalReplyCount:4}}]};return {items:[{id:'two',snippet:{textOriginal:'reply',publishedAt:date}},{id:'three',snippet:{textOriginal:'reply 2',publishedAt:date}}]};}});
assert.equal(collected.posts.length,4);assert.equal(collected.posts[0].metrics.like_count,undefined);assert.equal(collected.posts[1].metrics.like_count,null);
const memory=new Map([['corpus',[{...records[0],nlp_row:{},sentiment:{label:'neutral',score:0},is_seed:false}]]]);
const read=(name,fallback)=>structuredClone(memory.has(name)?memory.get(name):fallback),save=(name,value)=>memory.set(name,structuredClone(value));
let time=new Date(date),analyzes=0;
const service=createAnalysisService({read,save,clock:()=>time,get:async()=>({}),collect:async({videoIds})=>({posts:[{...records[0],id:'youtube:'+videoIds[0],video_id:videoIds[0],text:'fixture '+videoIds[0],author_name:'Priya Kumar'}],videos:[{id:videoIds[0],title:'Fixture'}],warnings:[]}),worker:async(action,{posts})=>{if(action==='analyze'){analyzes++;return posts.map(p=>({...p,nlp_row:{post_id:p.id},sentiment:{label:'neutral',score:0}}));}return {posts:posts.map(p=>({...p,embedding:Array(384).fill(0),topic_source:'BERTopic',topic_id:0,topic:'Fixture'})),status:'ok'};},enrich:async posts=>({posts,warnings:[]}),persistCorpus:async posts=>({nlp_written:posts.length,metadata_written:posts.length,errors:[]}),readRows:async()=>[{post_id:'fixture'}],upsert:async(_,rows)=>rows.length});
const wait=async()=>{for(let i=0;i<200&&service.status().busy;i++)await new Promise(r=>setTimeout(r,5));assert.equal(service.status().busy,false);};
const a=service.start({url:'https://youtu.be/'+video});const queued=service.start({url:'https://youtu.be/'+video});assert.equal(queued.queued,true,'a link submitted while busy is queued, not rejected');assert.equal(service.status().runs.find(r=>r.id===queued.run_id).status,'queued');assert.throws(()=>service.start({mode:'trending'}),/already running/);await wait();assert.equal(service.status().runs.find(r=>r.id===queued.run_id).status,'complete','queued link runs after the current job');assert.equal(service.view({run:a.run_id}).posts.length,1);assert.equal(service.view({run:'legacy'}).posts[0].id,records[0].id);
const b=service.start({url:'https://youtu.be/12345678901'});await wait();assert.notEqual(service.view({run:a.run_id}).posts[0].id,service.view({run:b.run_id}).posts[0].id);
service.live({enabled:true,run:b.run_id});time=new Date(time.getTime()+301000);service.tick();await wait();assert.equal(analyzes,2);assert.equal(service.status().runs.length,5);service.live({enabled:false});
assert.ok(![...memory.values()].some(v=>JSON.stringify(v).includes('Priya Kumar')),'display names must never be stored');
console.log('URL validation, API sampling, scoped history, lock/live scheduling, metrics, demographics and network checks passed.');
{
  // Hourly trending refresh reuses today's selection (no search) and old refresh runs are pruned.
  const mem=new Map([['analysis-index',{runs:[{id:'d1',mode:'discovery',status:'complete',source_key:'discovery',day:'2026-09-23',started_at:'2026-09-23T03:30:00Z',completed_at:'2026-09-23T03:40:00Z',warnings:[]}],live:{enabled:false},discovery:{enabled:true,auto_default:true,runs:[{id:'d1',day:'2026-09-23',status:'complete'}],budgets:{},snapshots:{},channels:{},last_success:'d1',selection:[{id:'c1',name:'News',group:'public_issues',video_ids:['abcdefghijk']}]}}]]);
  const rd=(n,f)=>structuredClone(mem.has(n)?mem.get(n):f),sv=(n,v)=>mem.set(n,structuredClone(v));
  let t=new Date('2026-09-23T05:00:00Z'),collected=0;const removed=[];
  const svc=createAnalysisService({read:rd,save:sv,clock:()=>t,get:async()=>({}),refreshMinutes:60,keepRefreshRuns:2,remove:n=>removed.push(n),attachSegments:p=>p,
    collectSelection:async sel=>{collected++;return {posts:[{id:'youtube:x'+collected,video_id:sel[0].video_ids[0],author_ref:'h',content_kind:'comment',created_at:t.toISOString(),text:'refresh '+collected,metrics:{}}],videos:[{id:'abcdefghijk',title:'V'}],warnings:[]};},
    discover:async()=>{throw new Error('search must not run during a refresh');},
    worker:async(action,{posts})=>action==='analyze'?posts.map(p=>({...p,nlp_row:{post_id:p.id},sentiment:{label:'neutral',score:0}})):{posts:posts.map(p=>({...p,topic_source:'Embedding clusters',topic_id:0,topic:'T'})),status:'ok'},
    enrich:async posts=>({posts,warnings:[]}),persistCorpus:async()=>({nlp_written:1,metadata_written:1,errors:[]}),readRows:async()=>[],upsert:async(_,r)=>r.length});
  const idle=async()=>{for(let i=0;i<200&&svc.status().busy;i++)await new Promise(r=>setTimeout(r,5));};
  svc.tick();await idle();assert.equal(collected,1);assert.equal(svc.status().runs[0].mode,'trending');
  svc.tick();await idle();assert.equal(collected,1,'no second refresh within the hour');
  for(let i=0;i<3;i++){t=new Date(t.getTime()+3600000);svc.tick();await idle();}
  assert.equal(collected,4);assert.equal(svc.status().runs.filter(r=>r.mode==='trending').length,2);assert.equal(removed.length,2);
  console.log('Hourly trending refresh and pruning checks passed.');
}
