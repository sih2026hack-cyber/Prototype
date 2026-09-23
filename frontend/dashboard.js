const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const colors = {positive:'#7be8c0',neutral:'#83baff',negative:'#f68e9c',unavailable:'#6b7788'};
const api = async (url, options) => { const response = await fetch(url,options); const data = await response.json(); if(!response.ok)throw new Error(data.error||'Request failed'); return data; };
const post = (url,data) => api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const avg = list => list.length ? list.reduce((a,b)=>a+b,0)/list.length : 0;
const scored = p => Number.isFinite(p.score) && p.label !== 'unavailable' && !['unavailable','skipped_empty'].includes(p.source);
const empty = (title,note) => `<div class="empty"><strong>${esc(title)}</strong>${esc(note)}</div>`;
const safeURL = value => {try{const u=new URL(value);return u.protocol==='https:'?u.href:null;}catch{return null;}};
const shortDate = value => new Date(value).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'2-digit'});
const languageName = code => {if(code==='und')return 'Uncertain / mixed';try{return new Intl.DisplayNames(['en'],{type:'language'}).of(code)}catch{return code}};
function bars(items,total,color='#83baff') {
  return items.map(x=>`<div class="analysis-row"><div class="analysis-label"><span>${esc(x.label)}</span><strong>${x.value}${total?` · ${Math.round(x.value/total*100)}%`:''}</strong></div><div class="analysis-track"><span style="width:${Math.min(100,total?x.value/total*100:0)}%;background:${x.color||color}"></span></div></div>`).join('')||empty('No observations yet','Values appear after analysis.');
}
function timeline(points){
  const grouped=new Map();
  for(const p of points.filter(scored)){const day=p.date.slice(0,10);const list=grouped.get(day)||[];list.push(p.score);grouped.set(day,list);}
  const days=[...grouped].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,scores])=>({date,score:avg(scores),count:scores.length,time:Date.parse(date)}));
  if(!days.length){$('#sentimentBars').innerHTML=empty('No sentiment observations','Run ingestion to analyse comments.');return;}
  const left=35,right=675,top=18,bottom=165,width=710,height=202;
  const start=days[0].time,end=days.at(-1).time;
  const x=d=>start===end?(left+right)/2:left+(d.time-start)/(end-start)*(right-left);
  const y=score=>top+(1-score)/2*(bottom-top);
  const grid=[-1,-.5,0,.5,1].map(v=>`<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}" class="chart-grid"/><text x="25" y="${y(v)+3}" text-anchor="end">${v}</text>`).join('');
  const path=days.map((d,i)=>`${i&&d.time-days[i-1].time===86400000?'L':'M'}${x(d)},${y(d.score)}`).join(' ');
  const marks=days.map(d=>`<circle cx="${x(d)}" cy="${y(d.score)}" r="4" fill="${d.score<0?colors.negative:colors.positive}"><title>${esc(shortDate(d.date))}: ${d.score.toFixed(2)}, ${d.count} comments</title></circle>`).join('');
  const dates=[days[0],...(days.length>2?[days[Math.floor(days.length/2)]]:[]),...(days.length>1?[days.at(-1)]:[])];
  $('#sentimentBars').innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily average sentiment by publication date, from minus one to plus one"><title>Daily average sentiment</title>${grid}<path d="${path}" fill="none" stroke="#83baff" stroke-width="2"/>${marks}${dates.map((d,i)=>`<text x="${x(d)}" y="192" text-anchor="${i===0?'start':i===dates.length-1?'end':'middle'}">${shortDate(d.date)}</text>`).join('')}</svg>`;
}
function donut(counts,total){
  if(!total){$('#sentimentDistribution').innerHTML=empty('No analysed comments','Fetch comments to see the distribution.');return;}
  let cursor=0;const slices=[];
  const entries=Object.entries(colors).map(([name,color])=>({name,color,count:counts[name]||0}));
  for(const e of entries){const end=cursor+e.count/total*100;slices.push(`${e.color} ${cursor}% ${end}%`);cursor=end;}
  $('#sentimentDistribution').innerHTML=`<div class="donut-wrap"><div class="donut" role="img" aria-label="${esc(entries.map(e=>`${e.name} ${e.count}`).join(', '))}" style="background:conic-gradient(${slices.join(',')})"><div class="donut-hole"><strong>${total}</strong><small>comments</small></div></div><div class="donut-legend">${entries.map(e=>`<div class="legend-row"><i style="background:${e.color}"></i><span>${e.name==='unavailable'?'Unscored':e.name[0].toUpperCase()+e.name.slice(1)}</span><strong>${e.count}</strong></div>`).join('')}</div></div>`;
}

let pendingRun='',generation=0,loading=false,current=null;
const scope=()=>({run:$('#runSelect').value,from:$('#fromDate').value,to:$('#toDate').value,group:$('#groupSelect').value});
const query=()=>new URLSearchParams(scope()).toString();
function networkView(net){
  const nodes=net.nodes.slice(0,24),positions=new Map(nodes.map((n,i)=>[n.id,{x:50+(i%4)*135,y:35+Math.floor(i/4)*65}]));
  const height=Math.max(130,Math.ceil(nodes.length/4)*65+10),edges=net.edges.filter(e=>positions.has(e.from)&&positions.has(e.to));
  $('#linkGraph').innerHTML=nodes.length?'<svg viewBox="0 0 520 '+height+'" role="img" aria-label="Observed directed participation and reply relationships"><defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="#688f9a"/></marker></defs>'+edges.map(e=>{const a=positions.get(e.from),b=positions.get(e.to);return '<line x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'" stroke="'+(e.type==='reply'?'#b3a1ff':'#3b676b')+'" stroke-opacity=".55" marker-end="url(#arrow)"><title>'+esc(e.type)+' · '+esc(e.at)+'</title></line>';}).join('')+nodes.map(n=>{const p=positions.get(n.id);return '<circle cx="'+p.x+'" cy="'+p.y+'" r="7" fill="'+(n.kind==='video'?'#83baff':'#7be8c0')+'"><title>'+esc(n.label)+'</title></circle><text x="'+(p.x-30)+'" y="'+(p.y+20)+'">'+esc(n.kind==='video'?'Video':n.label.slice(-8))+'</text>';}).join('')+'</svg>':empty('No observed edges','Replies appear only when both records are available.');
  $('#networkNote').textContent=nodes.length+'/'+net.nodes.length+' participants & videos · '+edges.length+'/'+net.edges.length+' connections';
  $('#leaders').innerHTML=net.leaders.slice(0,5).map(a=>'<div class="topic-row"><div class="topic-title"><span>'+esc(a.label)+'</span><b>'+a.unique_incoming_repliers+' repliers</b></div><small class="muted">'+a.comments+' comments · '+(a.likes??'Unavailable')+' likes</small></div>').join('')||empty('No participant ranking','Author identifiers were unavailable.');
}
function summaryBullets(text){
  if(!text)return '';
  const sentences=typeof Intl.Segmenter==='function'?[...new Intl.Segmenter('en',{granularity:'sentence'}).segment(text)].map(x=>x.segment.trim()):text.split(/(?<=[.!?])\s+/);
  return '<ul class="topic-bullets">'+sentences.filter(Boolean).map(s=>'<li>'+esc(s)+'</li>').join('')+'</ul>';
}
function topicView(data){
  $('#topicCount').textContent=data.topics.length+' TOPICS';
  $('#topics').innerHTML=data.topics.slice(0,6).map(t=>'<article class="topic-row"><div class="topic-title"><h4>'+esc(t.topic)+'</h4><b>'+t.posts+' mentions</b></div>'+summaryBullets(t.summary)+(t.abusive?'<span class="abuse-tag">Contains abusive language · masked</span>':'')+'</article>').join('')||empty('No topics yet','Try another source or date range.');
  const topics=data.topics.slice(0,4),days=data.timeline,w=520,h=145,max=Math.max(1,...days.flatMap(d=>Object.values(d.topics))),palette=['#7be8c0','#83baff','#b3a1ff','#eecb7c'];
  $('#topicTimeline').innerHTML=days.length?'<svg viewBox="0 0 '+w+' '+h+'" role="img" aria-label="Daily topic counts in collected comments">'+topics.map((t,i)=>{const points=days.map((d,j)=>(20+j/Math.max(1,days.length-1)*480)+','+(110-(d.topics[t.key]||0)/max*90)).join(' ');return '<polyline points="'+points+'" stroke="'+palette[i]+'" stroke-width="2" fill="none"><title>'+esc(t.topic)+'</title></polyline>';}).join('')+'<text x="20" y="135">'+esc(days[0].date)+'</text><text x="400" y="135">'+esc(days.at(-1).date)+'</text></svg><p class="footnote">'+topics.map((t,i)=>'<span style="color:'+palette[i]+'">'+esc(t.topic)+'</span>').join(' · ')+'</p>':empty('No dated topic observations','Collect a source to begin.');
  $('#growthNote').textContent=data.growth.status==='measured_sample'?'Observed sample growth · two 24-hour periods':'More history needed to measure growth.';
}
const regionName = code => {try{return /^[A-Z]{2}$/.test(code)?new Intl.DisplayNames(['en'],{type:'region'}).of(code):code}catch{return code}};
const dimensionNames = {age:'Age',gender:'Gender',country:'Country'};
function participationView(p){
  if(!p){$('#participation').innerHTML='';return;}
  const stat=(value,label)=>'<div><strong>'+esc(value)+'</strong><span>'+esc(label)+'</span></div>';
  const time=Object.entries(p.time_of_day_ist||{}).map(([label,value])=>({label,value}));
  $('#participation').innerHTML='<h4>Participation</h4><div class="stat-grid">'+stat(p.commenters,'unique commenters')+stat(p.repeat,'commented more than once')+stat(p.replies,'replies · '+p.top_level+' top-level')+'</div>'
    +(p.abusive?'<p class="footnote"><span class="abuse-tag">'+p.abusive+' comment'+(p.abusive===1?'':'s')+' with abusive language · masked</span></p>':'')
    +'<h4>When they comment (IST)</h4>'+bars(time,time.reduce((a,b)=>a+b.value,0),'#7be8c0');
}
function audienceView(data){
  participationView(data.participation);
  $('#audience').innerHTML=bars(Object.entries(data.summary.languages).map(([name,value])=>({label:languageName(name),value})),data.coverage.comments,'#b3a1ff');
  const r=data.audienceReport;
  if(!r){
    $('#demographics').innerHTML='<h4>Age, gender &amp; country</h4><div class="demographic-grid">'+['Age','Gender','Country'].map(label=>'<div><span>'+label+'</span><strong>Not connected</strong></div>').join('')+'</div><p class="footnote">These can’t be read from public comments. Import your channel’s YouTube Studio audience CSVs or a voluntary survey below.</p>';
    return;
  }
  const source=r.source==='youtube_analytics'?'YouTube Studio analytics':'Voluntary survey';
  $('#demographics').innerHTML='<h4>Age, gender &amp; country</h4><p class="demo-source">'+esc(source)+' · '+esc(r.population)+' · '+esc(r.period)+(r.sample_size?' · '+esc(r.sample_size)+' people':'')+'</p>'
    +Object.entries(r.dimensions).filter(([,rows])=>rows.length).map(([dimension,rows])=>{
      const shown=rows.filter(row=>!row.suppressed).map(row=>({label:dimension==='country'?regionName(row.label):row.label,value:Math.round(row.percent*10)/10})),hidden=rows.filter(row=>row.suppressed).length;
      return '<h4>'+esc(dimensionNames[dimension]||dimension)+'</h4>'+bars(shown,100,'#83baff').replace(/ · \d+%/g,'%')+(hidden?'<p class="footnote">'+hidden+' small group'+(hidden===1?'':'s')+' hidden for privacy.</p>':'');
    }).join('')+'<p class="footnote">This is a separate population from the commenters above.</p>';
}
// --- Aggregate audience import (YouTube Studio exports or opt-in survey totals) ---
function parseCSV(text){
  const rows=[];let row=[],cell='',quoted=false;text=text.replace(/^﻿/,'');
  for(let i=0;i<text.length;i++){const c=text[i];
    if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}
    else if(c==='"')quoted=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';}else cell+=c;}
  row.push(cell);if(row.some(x=>x.trim()))rows.push(row);return rows.map(r=>r.map(x=>x.trim()));
}
const number=v=>{const n=Number(String(v).replace(/[%,\s]/g,''));return Number.isFinite(n)?n:null;};
const ageLabel=v=>v.replace(/^age[\s_]*/i,'').replace(/\s*years?$/i,'').replace(/[_-]/g,'–').replace(/^65–?$/,'65+');
const genderLabel=v=>({female:'Women',male:'Men',user_specified:'Self-described',unknown:'Not stated'}[v.toLowerCase().replace(/\s+/g,'_')]||v);
function capRows(rows){if(rows.length<=20)return rows;const sorted=[...rows].sort((a,b)=>(b.percent??0)-(a.percent??0)),rest=sorted.slice(19);const other={label:'Other',percent:Math.round(rest.reduce((a,b)=>a+(b.percent||0),0)*100)/100};if(rest.every(r=>Number.isInteger(r.count)))other.count=rest.reduce((a,b)=>a+b.count,0);return [...sorted.slice(0,19),other];}
function studioTable(rows){
  const head=rows[0].map(h=>h.toLowerCase()),dimension=/age/.test(head[0])?'age':/gender/.test(head[0])?'gender':/geograph|country/.test(head[0])?'country':null;
  if(!dimension)throw new Error('Unrecognised CSV: first column should be Viewer age, Viewer gender or Geography.');
  let metric=head.findIndex(h=>/^views \(%\)$/.test(h));if(metric<0)metric=head.findIndex(h=>/watch time.*\(%\)/.test(h));
  const percentColumn=metric>=0;if(!percentColumn)metric=head.findIndex(h=>/^views$/.test(h));
  if(metric<0)throw new Error('The '+dimension+' CSV needs a "Views (%)" or "Views" column.');
  const data=rows.slice(1).filter(r=>r[0]&&!/^total$/i.test(r[0])&&number(r[metric])!==null);
  const total=percentColumn?100:data.reduce((a,r)=>a+number(r[metric]),0);
  return [dimension,capRows(data.map(r=>{const value=number(r[metric]),label=dimension==='age'?ageLabel(r[0]):dimension==='gender'?genderLabel(r[0]):r[0].toUpperCase().slice(0,50);
    return percentColumn?{label,percent:Math.round(value*100)/100}:{label,percent:total?Math.round(value/total*10000)/100:0,count:Math.round(value)};}))];
}
function surveyTable(rows){
  const head=rows[0].map(h=>h.toLowerCase()),at=name=>head.indexOf(name),d=at('dimension'),l=at('label'),c=at('count');
  if(l<0||c<0)throw new Error('Survey CSV needs dimension,label,count columns.');
  const dims={};for(const r of rows.slice(1)){const dim=r[d]?.toLowerCase();if(!['age','gender','country'].includes(dim)||!r[l])continue;(dims[dim]||=[]).push({label:r[l].slice(0,50),count:Math.round(number(r[c])||0)});}
  const sample=Math.max(0,...Object.values(dims).map(list=>list.reduce((a,b)=>a+b.count,0)));
  for(const [dim,list] of Object.entries(dims)){const total=list.reduce((a,b)=>a+b.count,0);dims[dim]=capRows(list.map(x=>({...x,percent:total?Math.round(x.count/total*10000)/100:0})));}
  return {dims,sample};
}
async function importCSV(){
  const files=[...$('#audienceFiles').files];if(!files.length)throw new Error('Choose one or more CSV files first.');
  const population=$('#audiencePopulation').value.trim();if(population.length<3)throw new Error('Say who this data covers, e.g. “Viewers of @channel”.');
  const dimensions={};let source='youtube_analytics',sample=null;
  for(const file of files){const rows=parseCSV(await file.text());if(rows.length<2)throw new Error(file.name+' has no data rows.');
    if(rows[0].map(h=>h.toLowerCase()).includes('dimension')){const s=surveyTable(rows);source='opt_in_survey';sample=s.sample;Object.assign(dimensions,s.dims);}
    else{const [dimension,list]=studioTable(rows);dimensions[dimension]=list;}}
  const report={source,aggregate_only:true,population,period:$('#audiencePeriod').value.trim()||'Not specified',dimensions,run:$('#runSelect').value};
  if(source==='opt_in_survey'){report.sample_size=sample;report.voluntary_self_report=true;}
  return post('/api/audience/import',report);
}
function render(data){
  current=data;$('#downloadPdf').disabled=false;$('#sampleCount').textContent=data.coverage.comments+' COMMENTS / REPLIES';
  donut(data.summary.sentiment,data.coverage.comments);
  timeline(data.timeline.map(d=>({date:d.date,score:d.score,label:d.score===null?'unavailable':'scored',source:'analysis'})));
  $('#emotions').innerHTML=bars(Object.entries(data.emotions).map(([label,value])=>({label,value})),data.coverage.comments,'#eecb7c');
  topicView(data);audienceView(data);networkView(data.network);
}
async function refreshDashboard(){
  if(loading)return;loading=true;const version=generation;
  try{
    const status=await api('/api/analysis/status'),finished=status.runs.filter(r=>['complete','partial'].includes(r.status));let selected=$('#runSelect').value;
    if(pendingRun){const r=status.runs.find(r=>r.id===pendingRun);if(r&&['complete','partial'].includes(r.status)){selected=pendingRun;pendingRun='';history.length=0;}else if(r?.status==='failed'){pendingRun='';$('#ingestStatus').textContent=r.message;}}
    if(!finished.some(r=>r.id===selected))selected=finished[0]?.id||'';
    if(version!==generation)return;
    $('#runSelect').innerHTML=finished.map(r=>'<option value="'+esc(r.id)+'">'+esc(r.label)+' · '+esc(new Date(r.completed_at).toLocaleString())+'</option>').join('')||'<option value="">No saved analysis</option>';$('#runSelect').value=selected;
    $('#analyseBtn').disabled=status.busy;$('#discoverBtn').disabled=status.busy;
    $('#liveToggle').checked=!!status.live.enabled;$('#liveToggle').disabled=!selected||status.busy;
    const last=status.runs[0];
    $('#ingestStatus').textContent=status.busy?'Analysing…':last?.status==='failed'?'Refresh failed · previous results retained':'Ready';
    if(selected){const data=await api('/api/view?'+query());if(version!==generation)return;render(data);$('#updatedAt').textContent='Collected '+new Date(data.run.completed_at).toLocaleString();if(!status.busy&&last?.status!=='failed')$('#ingestStatus').textContent=data.run.warnings.length?'Partial results · see report':'Ready';}
    const d=await api('/api/discovery/status');if(version!==generation)return;$('#discoveryToggle').checked=d.enabled;
    $('#discoveryStatus').textContent=(d.stale?'Previous sources may be stale. ':'')+'Next scheduled: '+new Date(d.next_at).toLocaleString()+' · '+d.budget.search+'/20 daily searches · Runs only while the server is running.';
    $('#channels').innerHTML=d.selection.map(c=>'<div class="topic-row"><a href="'+esc(safeURL(c.url))+'" target="_blank" rel="noreferrer">'+esc(c.name)+'</a> · '+esc(c.group.replaceAll('_',' '))+'<p class="footnote">'+c.score.toFixed(1)+' views/hour · '+esc(c.score_basis.replaceAll('_',' '))+' · '+esc(c.evidence[0]?.reason)+'</p></div>').join('');
  }catch(e){$('#ingestStatus').textContent=e.message;}finally{loading=false;}
}
function changed(){generation++;history.length=0;$('#chatLog').textContent='';current=null;$('#downloadPdf').disabled=true;refreshDashboard();}
$('#sourceForm').addEventListener('submit',async e=>{e.preventDefault();try{const r=await post('/api/analysis/run',{url:$('#sourceUrl').value.trim()});pendingRun=r.run_id;$('#ingestStatus').textContent='Analysis queued…';await refreshDashboard();}catch(e){$('#ingestStatus').textContent=e.message;}});
for(const id of ['runSelect','fromDate','toDate','groupSelect'])$('#'+id).addEventListener('change',changed);
$('#downloadPdf').addEventListener('click',()=>{if(current)window.location.href='/api/report.pdf?'+query();});
$('#liveToggle').addEventListener('change',async()=>{try{await post('/api/analysis/live',{enabled:$('#liveToggle').checked,run:$('#runSelect').value});}catch(e){$('#ingestStatus').textContent=e.message;$('#liveToggle').checked=false;}});
$('#discoveryToggle').addEventListener('change',async()=>{try{await post('/api/discovery/settings',{enabled:$('#discoveryToggle').checked});}catch(e){$('#ingestStatus').textContent=e.message;}});
$('#discoverBtn').addEventListener('click',async()=>{try{const r=await post('/api/discovery/run',{});pendingRun=r.run_id;await refreshDashboard();}catch(e){$('#ingestStatus').textContent=e.message;}});
$('#importCsv').addEventListener('click',async()=>{$('#importStatus').textContent='Importing…';try{const r=await importCSV();$('#importStatus').textContent='Imported · '+r.storage;await refreshDashboard();}catch(e){$('#importStatus').textContent=e.message;}});
$('#surveyTemplate').addEventListener('click',e=>{e.preventDefault();const csv='dimension,label,count\nage,18–24,0\nage,25–34,0\nage,35–44,0\nage,45+,0\ngender,Women,0\ngender,Men,0\ngender,Self-described / not stated,0\ncountry,IN,0\n';const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['﻿'+csv],{type:'text/csv'}));a.download='argus-survey-template.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
$('#importAudience').addEventListener('click',async()=>{try{const input=JSON.parse($('#audienceJson').value);const r=await post('/api/audience/import',{...input,run:$('#runSelect').value});$('#importStatus').textContent='Imported · '+r.storage;await refreshDashboard();}catch(e){$('#importStatus').textContent=e.message;}});
const history=[];
function bubble(role,text){const node=document.createElement('div');node.className=`bubble ${role}`;node.textContent=text;$('#chatLog').appendChild(node);$('#chatLog').scrollTop=$('#chatLog').scrollHeight;return node;}
$('#chatToggle').addEventListener('click',()=>{$('#chatPanel').classList.add('open');$('#chatInput').focus();});$('#chatClose').addEventListener('click',()=>$('#chatPanel').classList.remove('open'));
document.addEventListener('keydown',e=>{if(e.key==='Escape')$('#chatPanel').classList.remove('open');});
document.querySelectorAll('.suggestions button').forEach(b=>b.addEventListener('click',()=>{$('#chatInput').value=b.textContent;$('#chatForm').requestSubmit();}));
$('#chatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#chatForm').requestSubmit();}});
$('#chatForm').addEventListener('submit',async e=>{
  e.preventDefault();const question=$('#chatInput').value.trim();if(!question||$('#chatSend').disabled)return;
  bubble('user',question);$('#chatInput').value='';$('#chatSend').disabled=true;const pending=bubble('bot','Reading your analysis…');
  try{const r=await post('/api/chat',{question,history,...scope()});pending.textContent=r.answer;
    for(const [i,url] of [...new Set(r.evidence)].filter(safeURL).entries()){const link=document.createElement('a');link.href=safeURL(url);link.textContent=`Source ${i+1} ↗`;link.target='_blank';link.rel='noreferrer';link.className='chat-source';pending.appendChild(link);}
    history.push({role:'user',content:question},{role:'assistant',content:r.answer});
  }catch(error){pending.textContent=error.message;}finally{$('#chatSend').disabled=false;$('#chatInput').focus();$('#chatLog').scrollTop=$('#chatLog').scrollHeight;}
});
let previewTimer,aiTimer,revision=0,inFlight=false,lastChecked='',latestSuggestion=null;
function showModeration(result,preview=false){
  $('#pluginResult').dataset.risk=result.verdict;
  const names={high_risk:'High risk · threat warning',review:'Review suggested',safe:'Checked',unchecked:'Local preview'};
  $('#pluginResult').innerHTML=`<strong>${esc(names[result.verdict]||result.verdict)}</strong><p>${esc(result.reason||'')}</p>${result.corrected_text?`<p>Suggestion: ${esc(result.corrected_text)}</p>`:''}${result.warning?`<p>${esc(result.warning)}</p>`:''}${!preview&&result.complete&&result.corrected_text?'<button id="acceptSuggestion">Use suggestion</button>':''}`;
  if(!preview){latestSuggestion=result;$('#acceptSuggestion')?.addEventListener('click',async()=>{try{const r=await post('/api/plugin/accept',{id:latestSuggestion.id});$('#draftText').value=r.text;revision++;lastChecked=r.text;$('#pluginStatus').textContent=`Suggestion accepted · ${r.storage}`;}catch(error){$('#pluginStatus').textContent=error.message;}});}
}
async function checkDraft(){
  clearTimeout(aiTimer);const text=$('#draftText').value.trim(),version=revision;
  if(!text||text===lastChecked)return;if(inFlight){aiTimer=setTimeout(checkDraft,1500);return;}
  inFlight=true;$('#checkDraft').disabled=true;$('#pluginStatus').textContent='Checking your draft…';
  try{const result=await post('/api/plugin/check',{text});lastChecked=text;if(version===revision){showModeration(result);$('#pluginStatus').textContent=`${result.complete?'AI check':'Local check'} saved · ${result.storage}`;}}
  catch(error){if(version===revision)$('#pluginStatus').textContent=error.message;}finally{inFlight=false;$('#checkDraft').disabled=false;if(version!==revision&&$('#draftText').value.trim())aiTimer=setTimeout(checkDraft,1800);}
}
$('#draftText').addEventListener('input',()=>{
  revision++;const version=revision,text=$('#draftText').value.trim();clearTimeout(previewTimer);clearTimeout(aiTimer);
  $('#pluginResult').textContent='';$('#pluginStatus').textContent=text?'Checking your draft as you type…':'Type a draft to begin.';if(!text)return;
  previewTimer=setTimeout(async()=>{try{const r=await post('/api/plugin/preview',{text});if(version===revision)showModeration(r,true);}catch{}},200);
  aiTimer=setTimeout(checkDraft,1800);
});
$('#checkDraft').addEventListener('click',()=>{lastChecked='';checkDraft();});
refreshDashboard();setInterval(()=>{if(!document.hidden)refreshDashboard();},4000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshDashboard();});
