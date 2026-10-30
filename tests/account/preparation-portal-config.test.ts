import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {PreparationService,type PreparationConfig} from '../../core/preparation/service.js';
import {validatePreparationPortal,type PreparationPortal} from '../../core/preparation/browser-review.js';
const portal:PreparationPortal={destination:'https://fictional.example.test',submissionUrl:'https://fictional.example.test/submit',receiptUrl:'https://fictional.example.test/receipt',encoding:'multipart'};

test('trusted portal configuration fails before owner claim, including while processing is paused',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pcfg-')),tasks=new AgentStore(join(root,'tasks.sqlite')),store=new EvidenceStore(join(root,'evidence'));
 const config:PreparationConfig={tasks,store,workspaceId:'invented',buildIdentity:'fixture',processingPaused:true,provider:()=>{throw Error('must not start provider');},tools:()=>[]};
 const bind=async()=>{throw Error('must not fetch Google at startup');};
 try{
  for(const bad of [{...portal,destination:'not a URL'},{...portal,receiptUrl:'https://foreign.example.test/receipt'},{...portal,destination:'javascript:alert(1)'},{...portal,submissionUrl:'https://user:secret@fictional.example.test/submit'},{...portal,receiptUrl:portal.receiptUrl+'#private'},{...portal,encoding:'unexpected'},{...portal,constants:[{name:'duplicate',value:'a'},{name:'duplicate',value:'b'}]}]){
   assert.throws(()=>new PreparationService({...config,browserPortal:bad as PreparationPortal},bind),/PREPARATION_BROWSER_INVALID_DESTINATION/);
  }
  // A failed constructor must not reserve the AgentStore's single preparation owner.
  const service=new PreparationService({...config,browserPortal:portal},bind);await service.close();
  assert.equal(tasks.tasks({workspaceId:'invented',accountId:'invented'}).length,0);
 }finally{tasks.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('valid operator URLs are canonicalized without changing origin, constants are copied',()=>{
 const input={...portal,constants:[{name:'reference',value:''}]},actual=validatePreparationPortal(input);
 assert.equal(actual.destination,'https://fictional.example.test/');assert.equal(actual.submissionUrl,portal.submissionUrl);
 input.constants[0]!.value='changed';assert.equal(actual.constants![0]!.value,'');
});
