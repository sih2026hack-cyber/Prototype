// Civic dashboard entities must be grounded in the configured gazetteer.
// Keep the original model output in the NLP record for inspection.
// Topic methods that produce clustered topics (BERTopic, or the embedding fallback when BERTopic cannot load).
export const CLUSTERED = new Set(['BERTopic','Embedding clusters']);
export const civicEntities = post => (post.entities || []).filter(e => ['GPE','LOC','ORG'].includes(e.label) && e.source === 'gazetteer');
export function aggregate(posts) {
  const sentiment = { positive:0, neutral:0, negative:0, unavailable:0 };
  const topics = new Map(), entities = new Map(), languages = {}, authors = new Map(), severity = {}, sources = {};
  let engagement = 0;
  for (const p of posts) {
    sentiment[p.sentiment?.label || 'unavailable']++;
    const language = p.nlp_row?.is_code_mixed || (p.nlp_row?.lang_confidence ?? 0) < .8 ? 'und' : p.lang || 'und';
    languages[language] = (languages[language] || 0)+1;
    const source = p.sentiment?.source || 'pending'; sources[source] = (sources[source] || 0)+1;
    const interactions = ['like_count','reply_count','retweet_count','quote_count'].map(k=>p.metrics?.[k]).filter(Number.isFinite).reduce((a,b)=>a+b,0); engagement += interactions;
    const topic = p.topic?.replace(/[·\s]/g,'') ? p.topic : CLUSTERED.has(p.topic_source) ? `Topic ${p.topic_id+1} (keywords unavailable)` : 'Topic analysis pending';
    const key = CLUSTERED.has(p.topic_source) ? `${p.source_group||'manual'}:${p.topic_id}` : topic;
    const t = topics.get(key) || { topic, topic_id:p.topic_id, posts:0, evidence:[], source:p.topic_source || 'pending', sentiment:0 };
    t.key=key; t.summary=p.topic_summary||null;
    t.posts++; if(p.abusive)t.abusive=(t.abusive||0)+1; t.sentiment += p.sentiment?.score || 0; if (p.source_url && !p.is_seed) t.evidence.push(p.source_url); if(p.topic_id!==-1)topics.set(key,t);
    for (const e of civicEntities(p)) {
      const key=e.label+':'+e.text.toLowerCase(); const item=entities.get(key)||{text:e.text,label:e.label,count:0,source:'civic gazetteer'}; item.count++; entities.set(key,item); }
    const sev=p.event_polarity?.severity??0; severity[sev]=(severity[sev]||0)+1;
    if (p.author_ref) { const a=authors.get(p.author_ref)||{author:'Author '+p.author_ref.slice(0,8),posts:0,engagement:0}; a.posts++;a.engagement+=interactions;authors.set(p.author_ref,a); }
  }
  return {total_posts:posts.length,sentiment,sentiment_sources:sources,languages,event_severity:severity,
    topics:[...topics.values()].map(t=>({...t,sentiment:t.sentiment/t.posts,evidence:t.evidence.slice(0,3)})).sort((a,b)=>b.posts-a.posts),
    entities:[...entities.values()].sort((a,b)=>b.count-a.count),engagement,
    authors:[...authors.values()].sort((a,b)=>b.engagement-a.engagement).slice(0,5),
    sample_window:posts.length?{from:posts.map(p=>p.created_at).sort()[0],to:posts.map(p=>p.created_at).sort().at(-1)}:null};
}
