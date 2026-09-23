export const GROUPS=['public_issues','popular_topics'];
export function istClock(value=new Date()) { const shifted=new Date(new Date(value).getTime()+330*60000);return {day:shifted.toISOString().slice(0,10),hour:shifted.getUTCHours()}; }
export function automaticDue(state,value=new Date()) {
  const {day,hour}=istClock(value);
  if(state.runs.some(r=>r.day===day))return false;
  if(hour>=9)return true;
  const yesterday=istClock(new Date(new Date(value).getTime()-86400000)).day;
  const last=state.runs.map(r=>r.day).sort().at(-1);
  return Boolean(last&&last<yesterday); // One catch-up, never a backlog of jobs.
}
export function nextSchedule(value=new Date()){const {day,hour}=istClock(value);const date=new Date(`${day}T03:30:00.000Z`);if(hour>=9)date.setUTCDate(date.getUTCDate()+1);return date.toISOString();}
export function reserveRequest(state,resource,value=new Date()){
  const day=istClock(value).day;state.budgets??={};const budget=state.budgets[day]??={search:0,total:0};
  if(resource==='search'&&budget.search>=20)throw new Error('Daily search budget exhausted (20 requests).');
  if(budget.total>=400)throw new Error('Daily YouTube request budget exhausted (400 requests).');
  if(resource==='search')budget.search++;budget.total++;return budget;
}
export function numberMetric(value){if(value===null||value===undefined||value==='')return null;const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:null;}
export function viewRate(video,history=[],at=new Date()){
  const views=numberMetric(video.statistics?.viewCount);const observed_at=new Date(at).toISOString();
  if(views===null)return {rate:null,basis:'unavailable',observed_at,views:null};
  const previous=history.filter(p=>Number.isFinite(p.view_count)&&new Date(at)-new Date(p.observed_at)>=3600000).sort((a,b)=>b.observed_at.localeCompare(a.observed_at))[0];
  if(previous){const delta=views-previous.view_count;const hours=(new Date(at)-new Date(previous.observed_at))/3600000;
    return {rate:delta<0?null:delta/hours,basis:delta<0?'counter_correction':'observed_growth',views,delta,hours,previous_at:previous.observed_at,observed_at};}
  const age=(new Date(at)-new Date(video.snippet.publishedAt))/3600000;
  return {rate:Number.isFinite(age)&&age>=0?views/Math.max(age,1):null,basis:'initial_estimate',views,age_hours:Math.max(age,1),observed_at};
}
export function rankChannels(candidates,channels,histories={},at=new Date()){
  const available=new Map(channels.map(c=>[c.id,c]));const selected=[],used=new Set();
  for(const group of GROUPS){
    const entries=new Map();
    for(const v of candidates.filter(v=>v.group===group&&v.relevant!==false)){
      if(!available.has(v.snippet.channelId))continue;
      const list=entries.get(v.snippet.channelId)||[];list.push({...v,rate:viewRate(v,histories[v.id],at)});entries.set(v.snippet.channelId,list);
    }
    const ranked=[...entries].map(([id,list])=>{const top=list.filter(v=>v.rate.rate!==null).sort((a,b)=>b.rate.rate-a.rate.rate||a.id.localeCompare(b.id)).slice(0,3);const meta=available.get(id);
      return {id,name:meta.snippet.title,url:`https://www.youtube.com/channel/${id}`,group,score:top.reduce((n,v)=>n+v.rate.rate,0),
        score_basis:top.every(v=>v.rate.basis==='observed_growth')?'observed_growth':top.every(v=>v.rate.basis==='initial_estimate')?'initial_estimate':'mixed',
        observed_growth:top.filter(v=>v.rate.basis==='observed_growth').reduce((n,v)=>n+v.rate.rate,0),
        evidence:top.map(v=>({video_id:v.id,title:v.snippet.title,url:`https://www.youtube.com/watch?v=${v.id}`,reason:v.reason,discovered_by:v.discovered_by,...v.rate})),
        video_ids:top.slice(0,2).map(v=>v.id),statistics:{subscriber_count:numberMetric(meta.statistics?.subscriberCount),view_count:numberMetric(meta.statistics?.viewCount),video_count:numberMetric(meta.statistics?.videoCount)}};
    }).filter(c=>c.video_ids.length).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
    for(const channel of ranked){if(used.has(channel.id))continue;selected.push(channel);used.add(channel.id);if(selected.filter(c=>c.group===group).length===5)break;}
  }
  return selected;
}
export function selectRecords(records,group='combined') {if(!['combined',...GROUPS].includes(group))throw new Error('Invalid source group.');return group==='combined'?records:records.filter(p=>p.source_group===group);}
export function topicKey(post){return `${post.source_group||'legacy'}:${post.topic_id}`;}
