// Download official safetensors in bounded ranges, then verify the Hub SHA-256.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {env,ROOT} from '../lib/config.mjs';
const repo='sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
const destination=path.resolve(ROOT,'../../work/multilingual-model');
const meta=await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`,{signal:AbortSignal.timeout(30000)}).then(r=>{if(!r.ok)throw new Error(`Hub metadata HTTP ${r.status}`);return r.json();});
const weight=meta.siblings.find(f=>f.rfilename==='model.safetensors');
if(!weight?.lfs?.sha256||!weight.size)throw new Error('Missing official weight checksum');
fs.mkdirSync(destination,{recursive:true});
const partial=path.join(destination,'model.safetensors.part'),target=path.join(destination,'model.safetensors');
const url=name=>`https://huggingface.co/${repo}/resolve/${meta.sha}/${name}`;
async function checksum(file){const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(file))hash.update(bytes);return hash.digest('hex');}
if(!fs.existsSync(target)||await checksum(target)!==weight.lfs.sha256){
  const cachedDir=path.join(env.ARGUS_MODEL_CACHE,'models--sentence-transformers--paraphrase-multilingual-MiniLM-L12-v2','blobs');
  let start=0;
  const cached=fs.existsSync(cachedDir)?fs.readdirSync(cachedDir).filter(n=>n.startsWith(weight.lfs.sha256)&&n.endsWith('.incomplete')).map(n=>path.join(cachedDir,n)).sort((a,b)=>fs.statSync(b).size-fs.statSync(a).size)[0]:null;
  if(cached&&fs.statSync(cached).size<weight.size){fs.copyFileSync(cached,partial);start=fs.statSync(partial).size;}
  const handle=await fs.promises.open(partial,start?'r+':'w');
  const chunks=[];const chunkSize=4*1024*1024;
  for(let offset=start;offset<weight.size;offset+=chunkSize)chunks.push({start:offset,end:Math.min(weight.size-1,offset+chunkSize-1)});
  let completed=start;
  console.log(`Official model: ${weight.size} bytes; resuming verified-source partial at ${start}`);
  async function run(){while(chunks.length){const range=chunks.shift();let data;
    for(let attempt=0;attempt<3;attempt++){try{
      const response=await fetch(url('model.safetensors'),{headers:{Range:`bytes=${range.start}-${range.end}`},signal:AbortSignal.timeout(45000)});
      if(response.status!==206||response.headers.get('content-range')!==`bytes ${range.start}-${range.end}/${weight.size}`)throw new Error(`Unexpected range response ${response.status}`);
      data=Buffer.from(await response.arrayBuffer());if(data.length!==range.end-range.start+1)throw new Error('Incomplete range');break;
    }catch(error){if(attempt===2)throw error;}}
    let written=0;while(written<data.length){const result=await handle.write(data,written,data.length-written,range.start+written);written+=result.bytesWritten;}
    completed+=data.length;console.log(`Model download ${Math.round(completed/weight.size*100)}%`);
  }}
  try{await Promise.all([run(),run(),run()]);}finally{await handle.close();}
  if(await checksum(partial)!==weight.lfs.sha256)throw new Error('SHA-256 check failed; model not activated');
  fs.renameSync(partial,target);
}
const wanted=meta.siblings.filter(f=>!f.rfilename.includes('/')&&/\.(json|txt|model)$/.test(f.rfilename)||f.rfilename==='1_Pooling/config.json');
for(const file of wanted){const name=file.rfilename;const response=await fetch(url(name),{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error(`Model config HTTP ${response.status}`);const output=path.join(destination,name);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,Buffer.from(await response.arrayBuffer()));}
console.log('Model weights SHA-256 verified. Local model ready: '+destination);
