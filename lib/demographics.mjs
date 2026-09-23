import {ServiceError} from './providers.mjs';
import {readLocal,saveLocal,upsert} from './storage.mjs';
const allowed = ['age','gender','country'];
export function validateDemographics(input){
  if(!input||!['youtube_analytics','opt_in_survey'].includes(input.source))throw new ServiceError('Source must be youtube_analytics or opt_in_survey.',400);
  if(input.aggregate_only!==true)throw new ServiceError('Only aggregate reports are supported. Do not upload individual records.',400);
  if(typeof input.population!=='string'||input.population.length<3||input.population.length>160)throw new ServiceError('Describe the population covered by this report.',400);
  const dimensions={};
  for(const dimension of allowed){
    const rows=input.dimensions?.[dimension];if(rows===undefined)continue;
    if(!Array.isArray(rows)||rows.length>20)throw new ServiceError('Each dimension must have at most 20 aggregate categories.',400);
    if(dimension==='religion'&&rows.length&&(input.source!=='opt_in_survey'||input.voluntary_self_report!==true))throw new ServiceError('Religion totals require an opt-in survey with voluntary self-reporting.',400);
    const seen=new Set();let sum=0;
    dimensions[dimension]=rows.map(row=>{
      if(!row||Object.keys(row).some(k=>!['label','percent','count','suppressed'].includes(k))||typeof row.label!=='string'||!row.label.trim()||row.label.length>50||/[@<>\r\n]|https?:/i.test(row.label))throw new ServiceError('Use aggregate category labels, percentages, counts and suppression flags only.',400);
      const label=row.label.trim();if(seen.has(label.toLowerCase()))throw new ServiceError('Duplicate demographic category.',400);seen.add(label.toLowerCase());
      if(row.count!==undefined&&(!Number.isInteger(row.count)||row.count<0))throw new ServiceError('Counts must be non-negative integers.',400);
      if(row.suppressed!==undefined&&typeof row.suppressed!=='boolean')throw new ServiceError('suppressed must be boolean.',400);
      if(row.percent!==null&&(typeof row.percent!=='number'||!Number.isFinite(row.percent)||row.percent<0||row.percent>100))throw new ServiceError('Percentages must be numbers from 0 to 100.',400);
      if(row.percent===null&&!row.suppressed)throw new ServiceError('Null percentages require a suppressed category.',400);
      sum+=row.percent||0;
      const count=row.count??(Number.isInteger(input.sample_size)&&row.percent!==null?Math.floor(input.sample_size*row.percent/100):null);
      const suppressed=row.suppressed===true||(count!==null&&count<10)||(input.source==='opt_in_survey'&&count===null);
      return {label,percent:suppressed?null:row.percent,suppressed};
    });
    if(sum>100.5)throw new ServiceError(`${dimension} percentages exceed 100%.`,400);
  }
  if(!Object.values(dimensions).some(rows=>rows.length))throw new ServiceError('Add at least one aggregate distribution from your source.',400);
  const sample=input.sample_size;
  if(sample!==undefined&&sample!==null&&(!Number.isInteger(sample)||sample<10))throw new ServiceError('Provide an aggregate sample size of at least 10, or omit it when the platform does not supply one.',400);
  return {mode:'imported',source:input.source,population:input.population,period:typeof input.period==='string'?input.period.slice(0,60):'Not specified',sample_size:sample??null,aggregate_only:true,voluntary_self_report:input.voluntary_self_report===true,dimensions,imported_at:new Date().toISOString()};
}
export function getDemographics(){return readLocal('demographics',{mode:'unavailable',dimensions:{},population:'No aggregate report connected'});}
export async function importDemographics(input){const report=validateDemographics(input);saveLocal('demographics',report);try{await upsert('audience_reports',[{id:'current',payload:report}],'id');report.storage='Supabase + local';}catch{report.storage='Local only — Supabase migration pending';}saveLocal('demographics',report);return report;}
export const demoDemographics=()=>({mode:'demo',source:'synthetic_demo',population:'Fictional audience for chart demonstration — unrelated to collected YouTube data',period:'Illustration only',sample_size:null,dimensions:{age:[{label:'18–24',percent:25},{label:'25–34',percent:35},{label:'35–44',percent:20},{label:'45–54',percent:12},{label:'55+',percent:8}],gender:[{label:'Women',percent:46},{label:'Men',percent:46},{label:'Self-described / not stated',percent:8}],country:[],religion:[]}});
