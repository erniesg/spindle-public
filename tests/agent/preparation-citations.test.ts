import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {EvidenceStore} from '../../core/evidence/store.js';
import {spanId} from '../../core/evidence/ocr.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {preparationCitation} from '../../core/preparation/citations.js';
import type {PreparationRecord} from '../../core/preparation/types.js';

test('citation review resolves exact persisted region preview without browser EXIF/HEIF geometry guesses',()=>{
 const dir=mkdtempSync(join(process.cwd(),'.local/workflow/citation-')),store=new EvidenceStore(join(dir,'evidence')),tasks=new AgentStore(join(dir,'tasks.sqlite')),ns={workspaceId:'w',accountId:'owner'};
 try{
  // Metadata adapter fixture only. Actual region drawing/geometry is covered by the OCR module.
  const source=store.put(ns,Buffer.from('invented image fixture'),'image/png',[],{provider:'drive',providerId:'source',providerVersion:'1'}).source!;
  const span={text:'000045',uncertainty:'not-assessed' as const,polygon:[{x:.1,y:.1},{x:.3,y:.1},{x:.3,y:.3},{x:.1,y:.3}]},id=spanId(source.id,source.sha256,0,span);
  const record={kind:'spindle.ocr.v1',sourceId:source.id,sourceVersion:source.sha256,sourceWidthPx:100,sourceHeightPx:100,coordinateSpace:'normalized-0-1',producer:{backend:'self-hosted-nim',model:'invented'},spans:[{...span,id}]};
  const ocr=store.put(ns,Buffer.from(JSON.stringify(record)),'application/vnd.spindle.ocr+json',[source.id]).artifact;
  const task=tasks.admit({workspaceId:'w',accountId:'owner',messageId:'m',outcome:'Invented citation'},20),citation={artifactId:ocr.id,sourceId:source.id,sourceVersion:source.sha256,spanIds:[id]};
  tasks.update(task.id,t=>{t.preparation={artifactIds:[source.snapshotArtifactId,ocr.id]} as PreparationRecord;});
  const raw=preparationCitation(store,ns,tasks.get(task.id),citation) as any;assert.equal(raw.previewArtifactId,source.snapshotArtifactId);assert.equal(raw.regionPreview,false);
  const preview=store.put(ns,Buffer.from('invented persisted region PNG'),'image/png',[ocr.id,source.snapshotArtifactId]).artifact;
  tasks.update(task.id,t=>{t.preparation!.artifactIds.push(preview.id);t.observations.push({callId:'actual-persisted-tool-fixture',status:'ok',data:{kind:'spindle.ocr.regions.v1',ocrArtifactId:ocr.id,inputArtifactId:source.snapshotArtifactId,inputHash:source.sha256,outputId:preview.id,outputHash:preview.sha256,regions:[{spanId:id}]},artifacts:[preview],evidence:[],observations:['Metadata-only local review callback fixture, not an actual image draw']});});
  const shown=preparationCitation(store,ns,tasks.get(task.id),citation) as any;assert.equal(shown.previewArtifactId,preview.id);assert.equal(shown.regionPreview,true);assert.equal(shown.regions[0][0].x,10);
  tasks.update(task.id,t=>{(t.observations[0]!.data as any).outputHash='f'.repeat(64);});assert.equal((preparationCitation(store,ns,tasks.get(task.id),citation) as any).regionPreview,false);
  assert.equal((preparationCitation(store,{workspaceId:'w',accountId:'other'},tasks.get(task.id),citation) as any).previewUnavailable,true);
 }finally{store.close();tasks.close();rmSync(dir,{recursive:true,force:true});}
});
