import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EvidenceStore } from '../../core/evidence/store.js';
import { MemoryStore } from '../../core/memory/store.js';
import { contextTools } from '../../core/memory/tools.js';
import { AgentRuntime } from '../../core/agent/runtime.js';
import { AgentStore } from '../../core/storage/agent-store.js';
test('registered actual file tools preserve provenance through runtime and correction survives restart', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'context-tools-')); const ns={accountId:'a',workspaceId:'w'};
 try {
  writeFileSync(join(dir,'invented.txt'),'invented workshop');
  let evidence=new EvidenceStore(join(dir,'state'));
  const tools=contextTools(evidence,{r:dir},{chosen:{rootId:'r',path:'invented.txt',mimeType:'text/plain'}});
  assert.throws(()=>tools[3].inputSchema.parse({selectionId:'chosen',path:'/etc/passwd'}));
  const tasks=new AgentStore(join(dir,'tasks.sqlite')); const task=tasks.admit({...ns,messageId:'m',outcome:'read selected file'},8);
  await new AgentRuntime(tasks,tools).run(task.id,{id:'scripted-not-live',async next(t){
   if(!t.observations.length) return {kind:'tool',name:'files.read',args:{selectionId:'chosen'}};
   const result=t.observations[0]; const data=result.data as {source:{id:string;sha256:string};text:string};
   assert.equal(data.text,'invented workshop'); assert.equal(result.evidence[0].sourceVersion,data.source.sha256);
   assert.equal(result.artifacts[0].sha256,data.source.sha256);
   return {kind:'ready',result:'observed actual selected file'};
  }},3,{scope:{sources:[],destinations:[],grants:['files.read','files.root:r']}});
  assert.equal(tasks.get(task.id).status,'ready'); tasks.close();
  new MemoryStore(evidence).record(ns,{key:'workshop',kind:'fact',value:'corrected workshop',sourceIds:[],userCorrected:true});
  evidence.close(); evidence=new EvidenceStore(join(dir,'state'));
  assert.equal(new MemoryStore(evidence).read(ns,'workshop')?.value,'corrected workshop'); evidence.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('metadata abort publishes neither half and orphan is recoverable after reopen',()=>{
 const dir=mkdtempSync(join(tmpdir(),'context-abort-'));const ns={accountId:'a',workspaceId:'w'};
 try {
  let store=new EvidenceStore(dir);
  store.db.exec("CREATE TRIGGER abort_source BEFORE INSERT ON sources BEGIN SELECT RAISE(ABORT, 'injected metadata failure'); END");
  assert.throws(()=>store.put(ns,Buffer.from('original'),'text/plain',[],{provider:'user'}),/injected/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n,0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM sources').get()!.n,0);
  store.close(); store=new EvidenceStore(dir);assert.equal(store.recoverOrphans(),1);
  store.db.exec('DROP TRIGGER abort_source');
  assert.equal(store.put(ns,Buffer.from('retry'),'text/plain').artifact.bytes,5);
  assert.throws(()=>store.put(ns,Buffer.from('x'),'text/plain',Array(101).fill('x')),/metadata/);store.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('missing memory is a valid observation and independent work continues', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'context-missing-')); const ns={accountId:'a',workspaceId:'w'};
 const evidence=new EvidenceStore(join(dir,'state')); const tasks=new AgentStore(join(dir,'tasks.sqlite'));
 try {
  const tools=contextTools(evidence,{},{});
  const read=tools.find(t=>t.name==='memory.read')!; const search=tools.find(t=>t.name==='memory.search')!;
  assert.deepEqual(read.outputSchema.jsonSchema,{type:['object','null']});
  assert.equal(search.outputSchema.jsonSchema.type,'array');
  assert.equal(read.outputSchema.parse(null),null);
  assert.throws(()=>read.outputSchema.parse([])); assert.throws(()=>read.outputSchema.parse('invented'));
  assert.throws(()=>search.outputSchema.parse({})); assert.throws(()=>search.outputSchema.parse(null));
  const task=tasks.admit({...ns,messageId:'missing',outcome:'inspect memory'},8);
  await new AgentRuntime(tasks,tools).run(task.id,{id:'scripted-not-live',async next(t){
   if(!t.observations.length) return {kind:'tool',name:'memory.read',args:{key:'absent'}};
   assert.equal(t.observations[0].data,null);
   if(t.observations.length===1) return {kind:'tool',name:'memory.search',args:{query:'independent'}};
   assert.deepEqual(t.observations[1].data,[]);
   return {kind:'ready',result:'independent work retained'};
  }},4,{scope:{sources:[],destinations:[],grants:['memory.read','memory.search']}});
  assert.equal(tasks.get(task.id).status,'ready');
 } finally {tasks.close();evidence.close();rmSync(dir,{recursive:true,force:true});}
});
test('Linux FIFO read rejects without blocking the worker', {skip:process.platform!=='linux'},()=>{
 const dir=mkdtempSync(join(tmpdir(),'context-fifo-'));
 try {
  assert.equal(spawnSync('mkfifo',[join(dir,'pipe')]).status,0);
  const script=`import {ScopedFilesystem} from './build/core/connectors/filesystem.js';
   const files=new ScopedFilesystem({put(){throw new Error('must not snapshot')}},{r:process.argv[1]});
   try {files.read({accountId:'a',workspaceId:'w'},'r','pipe');process.exitCode=2;}
   catch(error){if(error.message !== 'Unsupported source size/type') throw error; console.log('FIFO rejected');}`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script,dir],{timeout:2000,encoding:'utf8'});
  assert.equal(child.error,undefined,`bounded subprocess: ${child.error}`);
  assert.equal(child.status,0,child.stderr); assert.match(child.stdout,/FIFO rejected/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
