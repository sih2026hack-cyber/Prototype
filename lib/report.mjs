import {spawn} from 'node:child_process';
import path from 'node:path';
import {env,ROOT} from './config.mjs';
import {ServiceError} from './providers.mjs';
export function reportPDF(data){return new Promise((resolve,reject)=>{
  const child=spawn(env.ARGUS_PYTHON||'python',['-u',path.join(ROOT,'backend/report.py')],{cwd:ROOT,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...env,PYTHONIOENCODING:'utf-8',PYTHONPATH:path.resolve(ROOT,'../../work/pdf-packages')}});
  const chunks=[];let bytes=0;const timer=setTimeout(()=>{child.kill();reject(new ServiceError('PDF export timed out; retry a smaller date range.'));},60000);
  child.stdout.on('data',b=>{bytes+=b.length;if(bytes>20000000){child.kill();reject(new ServiceError('Report exceeds export size limit.'));}else chunks.push(b);});child.stderr.on('data',()=>{});
  child.on('error',()=>{clearTimeout(timer);reject(new ServiceError('PDF runtime unavailable.'));});child.on('close',code=>{clearTimeout(timer);const pdf=Buffer.concat(chunks);if(code===0&&pdf.subarray(0,5).toString()==='%PDF-')resolve(pdf);else reject(new ServiceError('PDF generation failed. Check the configured Python PDF dependencies.'));});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(data));
});}
