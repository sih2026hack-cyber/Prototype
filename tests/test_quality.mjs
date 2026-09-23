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
  eq(maskProfanity('losu kuthi show').text,'losu k**** show');eq(maskProfanity('fucking hell').masked,1);
  for(const clean of ['Scunthorpe','Dickens','kuthikum','Ooroda Oththa Don','ஒத்த ரூபா'])eq(maskProfanity(clean).masked,0);
  const r=maskRecord({text:'what a bitch',topic_summary:'calling it bastard'});eq(r.abusive,true);eq(r.topic_summary,'calling it b******');
  const p=participation([{author_ref:'a',content_kind:'comment',created_at:'2026-09-23T04:00:00Z',abusive:true},{author_ref:'a',content_kind:'reply',created_at:'2026-09-23T14:00:00Z'},{author_ref:'b',content_kind:'comment',created_at:'2026-09-23T10:00:00Z'}]);
  eq(p.commenters,2);eq(p.repeat,1);eq(p.replies,1);eq(p.abusive,1);eq(p.time_of_day_ist['Morning (6 AM–12 PM)'],1);eq(p.time_of_day_ist['Evening (5–10 PM)'],1);eq(p.time_of_day_ist['Afternoon (12–5 PM)'],1);eq(p.time_of_day_ist['Night (10 PM–6 AM)'],0);
  console.log('Profanity masking and participation checks passed.');
}
