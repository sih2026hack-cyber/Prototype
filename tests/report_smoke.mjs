import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const base=process.env.ARGUS_TEST_URL||'http://127.0.0.1:8787';
const res=await fetch(base+'/api/report.pdf?run=legacy');
assert.equal(res.status,200);const pdf=Buffer.from(await res.arrayBuffer());assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
const directory=path.resolve('output/pdf');fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'ARGUS-verified-sample.pdf');fs.writeFileSync(file,pdf);console.log(JSON.stringify({pdf:file,bytes:pdf.length}));
