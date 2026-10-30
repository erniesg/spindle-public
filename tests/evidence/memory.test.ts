import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EvidenceStore } from '../../core/evidence/store.js';
import { MemoryStore } from '../../core/memory/store.js';

test('lexical recall ranks separate tokens, bounds results and preserves scoped corrections',()=>{
 const dir=mkdtempSync(join(tmpdir(),'memory-alpha-'));const evidence=new EvidenceStore(dir);const memory=new MemoryStore(evidence);
 const ns={workspaceId:'w',accountId:'a'};
 try {
 const source=evidence.put(ns,Buffer.from('invented source'),'text/plain',[],{provider:'user'}).source!;
 memory.record(ns,{key:'writing',kind:'preference',value:'Concise plain language please',sourceIds:[],userCorrected:true});
 memory.record(ns,{key:'writing',kind:'preference',value:'Verbose technical jargon',sourceIds:[source.id],userCorrected:false});
 memory.record({...ns,accountId:'other'},{key:'foreign',kind:'fact',value:'plain concise',sourceIds:[],userCorrected:true});
 memory.record({...ns,workspaceId:'other'},{key:'foreign',kind:'fact',value:'plain concise',sourceIds:[],userCorrected:true});
 for(let i=0;i<25;i++)memory.record(ns,{key:`item-${String(i).padStart(2,'0')}`,kind:'fact',value:'plain',sourceIds:[],userCorrected:true});
 assert.equal(memory.search(ns,'plain concise')[0]?.value,'Concise plain language please');
 assert.equal(memory.search(ns,'plain').length,20);
 assert.deepEqual(memory.search(ns,'plain').map(r=>r.key),Array.from({length:20},(_,i)=>`item-${String(i).padStart(2,'0')}`));
 assert.equal(memory.list(ns).length,26);
 assert.equal(memory.list(ns,'writing').length,0);
 assert.deepEqual(memory.search(ns,'verbose'),[]);
 assert.deepEqual(memory.search(ns,'!!!'),[]);
 assert.throws(()=>memory.search(ns,'x'.repeat(513)));
 assert.throws(()=>memory.search(ns,Array(17).fill('word').join(' ')));
 assert.throws(()=>memory.search(ns,'x'.repeat(65)));
 assert.equal(memory.history(ns,'writing')[1].sourceIds[0],source.id);
 assert.deepEqual(memory.search({...ns,accountId:'absent'},'plain'),[]);
 for(let i=25;i<55;i++)memory.record(ns,{key:`item-${String(i).padStart(2,'0')}`,kind:'fact',value:'plain',sourceIds:[],userCorrected:true});
 const page=memory.list(ns);assert.equal(page.length,50);assert.equal(memory.list(ns,page.at(-1)!.key).length,6);
 for(let i=0;i<105;i++)memory.record(ns,{key:'history',kind:'goal',value:`Revision ${i}`,sourceIds:[],userCorrected:true});
 const latest=memory.history(ns,'history');assert.equal(latest.length,100);assert.equal(latest[0].version,6);
 assert.equal(memory.history(ns,'history',latest[0].version).length,5);
 assert.equal(memory.read(ns,'history')?.version,105);
 } finally {evidence.close();rmSync(dir,{recursive:true,force:true});}
});
