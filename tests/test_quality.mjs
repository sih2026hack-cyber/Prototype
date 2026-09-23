import assert from 'node:assert/strict';
import {aggregate,civicEntities} from '../lib/analytics.mjs';
import {inspectDraft} from '../lib/moderation.mjs';
const item={lang:'sw',nlp_row:{lang_confidence:.66,is_code_mixed:true},entities:[{text:'Sun',label:'LOC',source:'model'},{text:'Chennai',label:'GPE',source:'gazetteer'},{text:'State',label:'ORG',source:'model'}]};
assert.deepEqual(civicEntities(item).map(e=>e.text),['Chennai']);
assert.deepEqual(aggregate([item]).languages,{und:1});
assert.equal(inspectDraft('I will kill him').verdict,'high_risk');
assert.notEqual(inspectDraft('I will not kill him').verdict,'high_risk');
assert.notEqual(inspectDraft('The character said "I will kill him" in the film.').verdict,'high_risk');
console.log('Entity grounding, language uncertainty and threat-context checks passed.');
import {maskProfanity,maskRecord} from '../lib/profanity.mjs';
import {participation} from '../lib/insights.mjs';
{
  const eq=(a,b)=>{if(a!==b)throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);};
  eq(maskProfanity('losu kuthi show').text,'l*** k**** show');eq(maskProfanity('you idiots are stupid').text,'you i***** are s*****');eq(maskProfanity('fucking hell').masked,1);
  for(const clean of ['Scunthorpe','Dickens','kuthikum','Ooroda Oththa Don','ஒத்த ரூபா'])eq(maskProfanity(clean).masked,0);
  const r=maskRecord({text:'what a bitch',topic_summary:'calling it bastard'});eq(r.abusive,true);eq(r.topic_summary,'calling it b******');
  const p=participation([{author_ref:'a',content_kind:'comment',created_at:'2026-09-23T04:00:00Z',abusive:true},{author_ref:'a',content_kind:'reply',created_at:'2026-09-23T14:00:00Z'},{author_ref:'b',content_kind:'comment',created_at:'2026-09-23T10:00:00Z'}]);
  eq(p.commenters,2);eq(p.repeat,1);eq(p.replies,1);eq(p.abusive,1);eq(p.time_of_day_ist['Morning (6 AM–12 PM)'],1);eq(p.time_of_day_ist['Evening (5–10 PM)'],1);eq(p.time_of_day_ist['Afternoon (12–5 PM)'],1);eq(p.time_of_day_ist['Night (10 PM–6 AM)'],0);
  console.log('Profanity masking and participation checks passed.');
}
import {activity} from '../lib/insights.mjs';
import {validateSegment,aggregateSegments} from '../lib/segments.mjs';
{
  const eq=(a,b)=>{if(a!==b)throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);};
  const at=h=>new Date(Date.UTC(2026,8,23,h,10)).toISOString();
  const short=activity([{created_at:at(10),sentiment:{score:.5,label:'positive'},topic_source:'BERTopic',topic_id:0},{created_at:at(10),sentiment:{score:-.5,label:'negative'},topic_source:'BERTopic',topic_id:1},{created_at:at(12),topic_source:'BERTopic',topic_id:0}]);
  eq(short.granularity,'hour');eq(short.buckets.length,2);eq(short.buckets[0].label,'23/09 15:00');eq(short.buckets[0].score,0);eq(short.buckets[1].score,null);
  eq(short.buckets.reduce((a,b)=>a+(b.topics['manual:0']||0),0),2);
  eq(activity([{created_at:'2026-09-18T10:00:00Z'},{created_at:'2026-09-23T10:00:00Z'}]).granularity,'day');
  const post={text:'As a student I cannot pay this fee'};
  eq(validateSegment(post,{segment:'student',evidence:'As a student',confidence:.9}).id,'student');
  eq(validateSegment(post,{segment:'student',evidence:'I am in college',confidence:.9}).id,'unstated');
  eq(validateSegment(post,{segment:'student',evidence:'As a student',confidence:.4}).id,'unstated');
  eq(validateSegment(post,{segment:'young_women',evidence:'As a student',confidence:.9}).id,'unstated');
  eq(validateSegment({text:'Muni action super da'},{segment:'fan_viewer',evidence:'Muni action super da',confidence:.9}).id,'unstated');
  eq(validateSegment({text:'Leader bised totally this season, very unfair'},{segment:'fan_viewer',evidence:'Leader bised',confidence:.9}).id,'unstated');
  eq(validateSegment({text:'I watch every episode but this task was unfair to everyone'},{segment:'fan_viewer',evidence:'I watch every episode',confidence:.8}).id,'fan_viewer');
  eq(validateSegment({text:'நான் ஒரு மாணவன், இந்த கட்டணம் அதிகம்'},{segment:'student',evidence:'நான் ஒரு மாணவன்',confidence:.8}).id,'student');
  const seg=(id,c=.8)=>({segment:{id,confidence:c}});
  const agg=aggregateSegments([seg('student'),seg('student'),seg('student',.6),seg('parent_family'),seg('unstated'),{}]);
  eq(agg.segments.length,1);eq(agg.segments[0].count,3);eq(agg.segments[0].percent,75);eq(agg.segments[0].confidence,.73);eq(agg.hidden_groups,1);eq(agg.unstated,1);eq(agg.pending,1);
  console.log('Activity bucketing and audience segment checks passed.');
}
import {validateEstimate,aggregateEstimates} from '../lib/segments.mjs';
{
  const eq=(a,b)=>{if(a!==b)throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);};
  eq(validateEstimate({age_band:'18-24',gender:'female',region:'in',estimate_confidence:.6}).region,'IN');
  eq(validateEstimate({age_band:'18-24',estimate_confidence:.2}).age,null);
  eq(validateEstimate({age_band:'toddler',gender:'hindu',estimate_confidence:.9}).gender,null);
  const e=aggregateEstimates([{estimate:{age:'18-24',gender:'male',region:'IN',confidence:.6}},{estimate:{age:'18-24',gender:null,region:'IN',confidence:.5}},{estimate:{age:'45+',gender:'male',region:null,confidence:.5}},{}]);
  eq(e.dimensions.age.rows.length,1);eq(e.dimensions.age.hidden,1);eq(e.dimensions.gender.rows[0].count,2);eq(e.dimensions.gender.unclear,1);eq(e.pending,1);eq(e.label,'AI estimate · low confidence');
  console.log('AI audience estimate checks passed.');
}
import {firstJson} from '../lib/enrichment.mjs';
{
  const r=firstJson('```json\n{"items":[{"id":"a","evidence":"x}\\"y"}]}\n```\n### Notes: {not json}');
  if(r.items[0].evidence!=='x}"y')throw new Error('firstJson failed');
  if(firstJson('[{"id":"b"}] trailing').length!==1)throw new Error('firstJson array failed');
  console.log('Model JSON extraction checks passed.');
}
