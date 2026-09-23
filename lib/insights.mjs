import {aggregate,civicEntities,CLUSTERED} from './analytics.mjs';
import {ServiceError} from './providers.mjs';
import {aggregateSegments,aggregateEstimates} from './segments.mjs';
export function scopeRecords(posts,{from='',to='',group='combined'}={}){
  for(const d of [from,to])if(d&&(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d))throw new ServiceError('Use valid YYYY-MM-DD dates.',400);
  if(from&&to&&from>to)throw new ServiceError('Start date must not follow end date.',400);
  if(!['combined','public_issues','popular_topics'].includes(group))throw new ServiceError('Unknown source group.',400);
  return posts.filter(p=>(!from||p.created_at?.slice(0,10)>=from)&&(!to||p.created_at?.slice(0,10)<=to)&&(group==='combined'||p.source_group===group));
}
export function network(posts){
  const byId=new Map(posts.map(p=>[p.id,p])),nodes=new Map(),edges=[],incoming=new Map(),authors=new Map();
  const author=p=>p.author_ref?`author:${p.author_ref}`:null;
  function addAuthor(p){const id=author(p);if(!id)return null;nodes.set(id,{id,kind:'author',label:'Participant '+p.author_ref.slice(0,8)});const a=authors.get(id)||{id,label:'Participant '+p.author_ref.slice(0,8),comments:0,likes:null,sample:null};a.comments++;if(Number.isFinite(p.metrics?.like_count))a.likes=(a.likes??0)+p.metrics.like_count;
    // Their most-liked comment, so the ranking points at real, checkable evidence without storing names.
    if(p.text&&(!a.sample||(p.metrics?.like_count??0)>a.sample.likes))a.sample={text:p.text.slice(0,140),url:p.source_url,likes:p.metrics?.like_count??0,video:p.context_title||null};authors.set(id,a);return id;}
  for(const p of posts.filter(p=>p.content_kind!=='video')){
    const id=addAuthor(p);if(!id)continue;
    if(p.video_id){const v=`video:${p.video_id}`;nodes.set(v,{id:v,kind:'video',label:p.context_title||p.video_id});edges.push({id:`participation:${p.id}`,from:id,to:v,type:'participation',record_id:p.id,at:p.created_at,url:p.source_url});}
    if(p.content_kind==='reply'){
      const parent=byId.get(p.parent_id),target=parent&&author(parent);
      if(target){nodes.set(target,{id:target,kind:'author',label:'Participant '+parent.author_ref.slice(0,8)});edges.push({id:`reply:${p.id}`,from:id,to:target,type:'reply',record_id:p.id,parent_id:p.parent_id,at:p.created_at,url:p.source_url});if(id!==target){const set=incoming.get(target)||new Set();set.add(id);incoming.set(target,set);}}
    }
  }
  return {nodes:[...nodes.values()],edges,leaders:[...authors.values()].map(a=>({...a,unique_incoming_repliers:incoming.get(a.id)?.size||0})).sort((a,b)=>b.unique_incoming_repliers-a.unique_incoming_repliers||b.comments-a.comments).slice(0,10),limitations:'Observed participation and replies only; not a follower or propagation network.'};
}
// Observable participation only: activity patterns, not identity or protected traits.
const IST_PARTS=[['Night (10 PM–6 AM)',h=>h>=22||h<6],['Morning (6 AM–12 PM)',h=>h>=6&&h<12],['Afternoon (12–5 PM)',h=>h>=12&&h<17],['Evening (5–10 PM)',h=>h>=17&&h<22]];
export function participation(comments){
  const byAuthor=new Map();for(const p of comments)if(p.author_ref)byAuthor.set(p.author_ref,(byAuthor.get(p.author_ref)||0)+1);
  const counts=[...byAuthor.values()],time=Object.fromEntries(IST_PARTS.map(([label])=>[label,0]));
  for(const p of comments){const t=Date.parse(p.created_at);if(!Number.isFinite(t))continue;const h=new Date(t+19800000).getUTCHours();time[IST_PARTS.find(([,test])=>test(h))[0]]++;}
  return {commenters:byAuthor.size,one_time:counts.filter(n=>n===1).length,repeat:counts.filter(n=>n>1).length,
    top_level:comments.filter(p=>p.content_kind!=='reply').length,replies:comments.filter(p=>p.content_kind==='reply').length,
    abusive:comments.filter(p=>p.abusive).length,time_of_day_ist:time,
    note:'Counted from pseudonymous commenter references in this sample. No age, gender, religion, caste or location is inferred.'};
}
// Chart series that stays readable for short samples: hourly (IST) under 48 h, otherwise daily.
const IST=19800000,HOUR=3600000;
export function activity(comments){
  const times=comments.map(p=>Date.parse(p.created_at)).filter(Number.isFinite);
  if(!times.length)return {granularity:'day',buckets:[]};
  const hourly=Math.max(...times)-Math.min(...times)<48*HOUR,buckets=new Map();
  for(const p of comments){const t=Date.parse(p.created_at);if(!Number.isFinite(t))continue;
    const local=new Date(t+IST).toISOString(),key=hourly?local.slice(0,13):local.slice(0,10);
    const b=buckets.get(key)||{at:hourly?new Date(Date.parse(key+':00:00Z')-IST).toISOString():key,label:hourly?`${key.slice(8,10)}/${key.slice(5,7)} ${key.slice(11,13)}:00`:key,count:0,scores:[],topics:{}};
    b.count++;if(Number.isFinite(p.sentiment?.score)&&!['unavailable','skipped_empty'].includes(p.sentiment?.source)&&p.sentiment?.label!=='unavailable')b.scores.push(p.sentiment.score);
    if(CLUSTERED.has(p.topic_source)&&p.topic_id>=0){const k=`${p.source_group||'manual'}:${p.topic_id}`;b.topics[k]=(b.topics[k]||0)+1;}buckets.set(key,b);}
  return {granularity:hourly?'hour':'day',timezone:'IST',buckets:[...buckets.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([,b])=>({at:b.at,label:b.label,count:b.count,scored:b.scores.length,score:b.scores.length?b.scores.reduce((x,y)=>x+y,0)/b.scores.length:null,topics:b.topics}))};
}
export function insights(posts,run,filters={},audienceReport=null){
  const comments=posts.filter(p=>p.content_kind!=='video'),summary=aggregate(comments),topics=aggregate(posts).topics.filter(t=>CLUSTERED.has(t.source)&&t.topic_id>=0),emotions={},days=new Map();let nuanced=0;
  for(const p of comments){
    if(p.nuance?.status==='complete')nuanced++;
    for(const emotion of new Set(p.nuance?.emotions||p.sentiment?.emotions||[]))emotions[emotion]=(emotions[emotion]||0)+1;
    const date=p.created_at?.slice(0,10);if(!date)continue;const d=days.get(date)||{date,count:0,scores:[],topics:{}};d.count++;
    if(Number.isFinite(p.sentiment?.score)&&!['unavailable','skipped_empty'].includes(p.sentiment?.source)&&p.sentiment?.label!=='unavailable')d.scores.push(p.sentiment.score);
    if(CLUSTERED.has(p.topic_source)&&p.topic_id>=0){const key=`${p.source_group||'manual'}:${p.topic_id}`;d.topics[key]=(d.topics[key]||0)+1;}days.set(date,d);
  }
  const timeline=[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(d=>({...d,score:d.scores.length?d.scores.reduce((a,b)=>a+b,0)/d.scores.length:null,scored:d.scores.length,scores:undefined}));
  return {run,filters,summary,topics,timeline,emotions,nuanced,network:network(posts),audienceReport,participation:participation(comments),activity:activity(comments),audienceSegments:aggregateSegments(comments),audienceEstimates:aggregateEstimates(comments),
    videos:posts.filter(p=>p.content_kind==='video').map(({embedding,nlp_row,author_ref,estimate,...p})=>p),
    coverage:{records:posts.length,comments:comments.length,videos:posts.filter(p=>p.content_kind==='video').length,embeddings:posts.filter(p=>p.embedding?.length===384).length,nlp:posts.filter(p=>p.nlp_row).length,outliers:posts.filter(p=>p.topic_id===-1).length},
    entities:aggregate(posts).entities,
    growth:{status:'insufficient_history',note:'Topic lines show sampled publication counts. Comparable collection coverage is required before claiming growth or predicting virality.'},
    evidence:comments.filter(p=>p.source_url).slice(0,12).map(p=>({id:p.id,text:p.text,url:p.source_url,sentiment:p.sentiment?.label,entities:civicEntities(p),severity:p.event_polarity?.severity})),
    limitations:['Selected public commenter sample, not all viewers or followers.','Public comments do not establish age, gender, occupation or residence.','Views, likes and reported comment totals are distinct from collected comments.','Topic IDs are local to this run and must not be compared across independent fits.']};
}
