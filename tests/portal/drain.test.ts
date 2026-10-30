import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {startPortal} from '../../examples/application-portal/server.js';
import {inventedPdf} from './fixtures.js';

test('portal close waits for an accepted receipt commit after its client socket closes',async()=>{
 const scratch=process.env.RUCKSACK_SCRATCH_ROOT??'/home/ubuntu/.local/state/rucksack/scratch/spindle-demo-loops';fs.mkdirSync(scratch,{recursive:true});const root=fs.mkdtempSync(join(scratch,'portal-drain-'));
 const original=fs.promises.rename;let release!:()=>void,entered!:()=>void;
 const held=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
 fs.promises.rename=async(from,to)=>{if(String(to).startsWith(root)&&String(to).endsWith('.json')){entered();await held;}return original(from,to);};syncBuiltinESMExports();
 const portal=await startPortal(root);let closing:Promise<void>|undefined;
 const controller=new AbortController();let request:Promise<unknown>|undefined;
 try{
  const form=new FormData();form.set('name','Invented drained applicant');form.set('idempotencyKey','invented-drain-key');form.set('statement',new Blob([Buffer.from(inventedPdf())],{type:'application/pdf'}),'invented.pdf');
  request=fetch(portal.origin+'/applications',{method:'POST',body:form,signal:controller.signal}).catch(()=>undefined);
  await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(Error('receipt commit not reached')),5000).unref())]);
  controller.abort();await request;let settled=false;closing=portal.close().then(()=>{settled=true;});
  await new Promise(r=>setTimeout(r,100));assert.equal(settled,false,'socket closure alone is not commit drain');
  release();await closing;
  const records=fs.readdirSync(root).filter(n=>n.endsWith('.json'));assert.equal(records.length,1);assert.equal(JSON.parse(fs.readFileSync(join(root,records[0]!),'utf8')).status,'submitted');
 }finally{release();await request;await(closing??portal.close());fs.promises.rename=original;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});}
});
