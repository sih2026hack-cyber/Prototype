// Compare completed UTC publication days using snapshots captured shortly after each day.
// Align evidence by embeddings, never by numeric topic IDs from independent fits.
export function measuredTopicGrowth(current,history,filters={}){
  const unavailable={status:'insufficient_history',note:'Insufficient comparable history. Topic lines show sampled publication counts, not predicted virality.'};
  const end=Date.parse(current.run.completed_at?.slice(0,10));if(!Number.isFinite(end))return unavailable;
  const day=86400000,start=end-2*day,middle=end-day;
  if(filters.from&&Date.parse(filters.from)>start||filters.to&&Date.parse(filters.to)+day<end)return unavailable;
  const videoSet=r=>JSON.stringify([...(r.video_ids||[])].sort());
  const compatible=history.filter(s=>s.run.source_key===current.run.source_key&&videoSet(s.run)===videoSet(current.run));
  const snapshot=at=>compatible.filter(s=>Date.parse(s.run.completed_at)>=at&&Date.parse(s.run.completed_at)<at+3600000).sort((a,b)=>a.run.completed_at.localeCompare(b.run.completed_at))[0];
  const before=snapshot(middle),after=snapshot(end);
  if(!before||!after||!compatible.some(s=>Date.parse(s.run.completed_at)<=start))return unavailable;
  const groups=new Map();for(const p of current.posts){if(p.topic_id<0||p.topic_source!=='BERTopic'||p.embedding?.length!==384)continue;const key=(p.source_group||'manual')+':'+p.topic_id;const g=groups.get(key)||{key,label:p.topic,vector:Array(384).fill(0),n:0,previous:0,current:0};p.embedding.forEach((v,i)=>g.vector[i]+=v);g.n++;groups.set(key,g);}
  for(const g of groups.values()){const norm=Math.hypot(...g.vector);g.vector=g.vector.map(v=>norm?v/norm:0);}
  let unmatched=0;
  for(const [sample,lo,hi,field] of [[before,start,middle,'previous'],[after,middle,end,'current']]){
    for(const p of sample.posts){const t=Date.parse(p.created_at);if(p.content_kind==='video'||t<lo||t>=hi||(filters.group&&filters.group!=='combined'&&p.source_group!==filters.group))continue;
      if(p.embedding?.length!==384){unmatched++;continue;}const scores=[...groups.values()].map(g=>({g,s:p.embedding.reduce((s,v,i)=>s+v*g.vector[i],0)})).sort((a,b)=>b.s-a.s);
      if(!scores.length||scores[0].s<.65||(scores[1]&&scores[0].s-scores[1].s<.05)){unmatched++;continue;}scores[0].g[field]++;
    }
  }
  return {status:'measured_sample',window_hours:24,from:new Date(start).toISOString(),to:new Date(end).toISOString(),unmatched,
    topics:[...groups.values()].map(({key,label,previous,current})=>({key,label,previous,current,change:current-previous})).sort((a,b)=>b.change-a.change),
    note:'Observed change across two completed 24-hour publication windows for the same source selection. Samples may be incomplete; ambiguous semantic matches are excluded. This is not a virality prediction.'};
}
