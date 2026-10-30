import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {PDFDocument} from 'pdf-lib';
import {AgentRuntime} from '../../core/agent/runtime.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {overlayFixture,placement} from './document-overlay-fixtures.js';
async function flat(){const d=await PDFDocument.create();d.addPage([400,300]).drawText('Invented dynamic flat form');return d.save();}
const args=(inputId:string,value='0012345')=>({inputId,pageIndex:0,coordinateSpace:{kind:'page_points'},placements:[placement(value)]});

test('offline scripted provider discovers registered capabilities, overlays, reads actual result, exports/renders and persists provenance across restart',async()=>{
 const original=await flat(),f=await overlayFixture(original);let tasks=new AgentStore(join(f.dir,'tasks.sqlite'));
 try {
  const task=tasks.admit({...f.ns,messageId:'overlay-scripted',outcome:'Prepare invented PDF using general tools'},30);
  await new AgentRuntime(tasks,f.tools).run(task.id,{id:'offline-script-not-live-model',async next(task,tools){
   const overlay=tools.find(t=>t.name==='document.overlay');assert.ok(overlay);const schema=overlay.inputSchema as any;assert.match(schema.properties.coordinateSpace.description,/top-left.*AFTER actual source rotation/);assert.match(schema.properties.placements.items.properties.fontSize.description,/Physical PDF points/);assert.ok(tools.find(t=>t.name==='document.render'));assert.equal(tools.find(t=>t.name==='document.render')!.effect,'write_local');
   const observations=task.observations,last=observations.at(-1);if(last)assert.equal(last.status,'ok',JSON.stringify(last));
   switch(observations.length) {
    case 0:return {kind:'tool',name:'document.inspect',args:{inputId:f.source.id}};
    case 1:assert.equal((last!.data as any).metadata.editingCapabilities.fieldEditing,'unsupported');assert.equal((last!.data as any).metadata.editingCapabilities.overlay,'supported');return {kind:'tool',name:'document.overlay',args:args(f.source.id)};
    case 2:return {kind:'tool',name:'document.extract_text',args:{inputId:last!.artifacts[0]!.id,pageIndex:0}};
    case 3:assert.match((last!.data as any).metadata.text,/0012345/);return {kind:'tool',name:'document.export',args:{inputId:observations[1]!.artifacts[0]!.id,flatten:true}};
    case 4:return {kind:'tool',name:'document.render',args:{inputId:last!.artifacts[0]!.id,pageIndex:0}};
    default:assert.equal((last!.data as any).metadata.render.pageIndex,0);return {kind:'ready',result:'Invented PDF prepared; visual/semantic review still required'};
   }
  }},6,{scope:f.ctx.scope});
  const completed=tasks.get(task.id);assert.equal(completed.status,'ready');assert.equal(completed.observations.length,5);assert.equal(completed.recovery,'clean');
  tasks.close();tasks=new AgentStore(join(f.dir,'tasks.sqlite'));assert.deepEqual(tasks.get(task.id),completed);
  const reopened=new EvidenceStore(f.dir);try {
   assert.deepEqual(reopened.read(f.ns,f.source.snapshotArtifactId),Buffer.from(original));
   for(const result of completed.observations.slice(1)) {assert.equal(result.evidence[0]!.sourceId,f.source.id);assert.equal(result.evidence[0]!.sourceVersion,f.source.sha256);assert.deepEqual(reopened.read(f.ns,result.artifacts[0]!.id),f.store.read(f.ns,result.artifacts[0]!.id));}
  }finally{reopened.close();}
  const first=completed.observations[1]!,correctedTask=tasks.admit({...f.ns,messageId:'overlay-correction',outcome:'Correct invented document'},10);
  await new AgentRuntime(tasks,f.tools).run(correctedTask.id,{id:'offline-correction-not-live-model',async next(){return {kind:'tool',name:'document.overlay',args:args(f.source.id,'0098765')};}},1,{scope:f.ctx.scope});
  const corrected=tasks.get(correctedTask.id).observations[0]!;assert.equal(corrected.status,'ok');assert.notEqual(corrected.artifacts[0]!.sha256,first.artifacts[0]!.sha256);assert.deepEqual(corrected.artifacts[0]!.derivedFrom,[f.source.id]);
  // Flat overlay correction is regenerated from the original, not painted over
  // the previous value. Semantic revision/attachment propagation is workflow-owned.
  const text=await f.call('extract_text',{inputId:corrected.artifacts[0]!.id,pageIndex:0});assert.match((text.data as any).metadata.text,/0098765/);assert.ok(!(text.data as any).metadata.text.includes('0012345'));
  const retained='.local/pdf-overlay/runtime';mkdirSync(retained,{recursive:true});writeFileSync(join(retained,'task.json'),JSON.stringify(completed,null,2));writeFileSync(join(retained,'corrected.pdf'),f.store.read(f.ns,corrected.artifacts[0]!.id));
 }finally{tasks.close();f.close();}
});

for(const operation of ['overlay','edit','export','render','extract_text'])test(`real SQLite artifact INSERT failure in document.${operation} escapes to Runtime write reconciliation without phantom observation`,async()=>{
 const d=await PDFDocument.create();const page=d.addPage([400,300]);page.drawText('Invented input');const field=d.getForm().createTextField('Code');field.addToPage(page,{x:40,y:220,width:180,height:30});field.setFontSize(12);
 const f=await overlayFixture(await d.save()),tasks=new AgentStore(join(f.dir,'tasks.sqlite'));
 try {
  f.store.db.exec("CREATE TRIGGER reject_output BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT,'invented SQLite publication failure'); END");
  const task=tasks.admit({...f.ns,messageId:`sqlite-${operation}`,outcome:'Prepare invented document'},10);
  const request=operation==='overlay'?args(f.source.id):operation==='edit'?{inputId:f.source.id,values:{Code:'0098765'}}:operation==='export'?{inputId:f.source.id,flatten:true}:{inputId:f.source.id,pageIndex:0};
  await new AgentRuntime(tasks,f.tools).run(task.id,{id:'offline-fault-script',async next(){return {kind:'tool',name:`document.${operation}`,args:request};}},1,{scope:f.ctx.scope});
  const failed=tasks.get(task.id);assert.equal(failed.status,'blocked');assert.equal(failed.recovery,'reconciliation_required');assert.equal(failed.pending?.effect,'write_local');assert.equal(failed.observations.length,0);assert.match(failed.blocker!,/invented SQLite publication failure/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n,1);assert.equal(f.store.recoverOrphans(),1);
 }finally{tasks.close();f.close();}
});

test('real SQLite failure is not replaced by concurrent cancellation',async()=>{
 const f=await overlayFixture(await flat());try {
  f.store.db.exec("CREATE TRIGGER reject_output BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT,'invented exact failure'); END");
  const put=f.store.put.bind(f.store);let actual:unknown;
  f.store.put=(...p)=>{try{return put(...p);}catch(error){actual=error;f.controller.abort();throw error;}};
  await assert.rejects(f.call('overlay',args(f.source.id)),error=>error===actual&&(error as Error).message.includes('invented exact failure'));
 }finally{f.close();}
});

test('cancellation after real commit cannot return a phantom successful tool result',async()=>{
 const f=await overlayFixture(await flat());try {
  const put=f.store.put.bind(f.store);let committed='';f.store.put=(...p)=>{const result=put(...p);committed=result.artifact.id;f.controller.abort();return result;};
  await assert.rejects(f.call('overlay',args(f.source.id)),{name:'AbortError'});assert.ok(committed);assert.ok(f.store.read(f.ns,committed).length>0);
 }finally{f.close();}
});

for(const cancel of [false,true])test(`injected post-commit exception ${cancel?'with cancellation':'without cancellation'} preserves original error and committed artifact, never phantom success`,async()=>{
 const f=await overlayFixture(await flat()),tasks=new AgentStore(join(f.dir,'tasks.sqlite'));try {
  const put=f.store.put.bind(f.store),fault=new Error('injected failure after real artifact commit');let outputId='';
  f.store.put=(...p)=>{const output=put(...p);outputId=output.artifact.id;if(cancel)f.controller.abort();throw fault;};
  if(cancel)await assert.rejects(f.call('overlay',args(f.source.id)),error=>error===fault);
  else {
   const task=tasks.admit({...f.ns,messageId:'postcommit',outcome:'Prepare invented PDF'},10);
   await new AgentRuntime(tasks,f.tools).run(task.id,{id:'offline-postcommit-fault-script',async next(){return {kind:'tool',name:'document.overlay',args:args(f.source.id)};}},1,{scope:f.ctx.scope});
   const result=tasks.get(task.id);assert.equal(result.status,'blocked');assert.equal(result.recovery,'reconciliation_required');assert.equal(result.observations.length,0);assert.equal(result.pending?.effect,'write_local');
  }
  assert.ok(outputId);assert.deepEqual(f.store.artifact(f.ns,outputId).derivedFrom,[f.source.id]);assert.ok(f.store.read(f.ns,outputId).subarray(0,5).equals(Buffer.from('%PDF-')));
 }finally{tasks.close();f.close();}
});
