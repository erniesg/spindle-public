import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {EvidenceStore} from '../../core/evidence/store.js';
import {AgentSessionStore,type AgentOperationEnvelope} from '../../core/models/agent-session-store.js';
import {visibleRecord} from '../../core/preparation/session.js';

test('visible exports keep validated dynamic PDF values while excluding secret fields and recognizable credential text',()=>{
 const result=visibleRecord({args:{values:{'Full Name':'Invented Person','Application Reference':'000045',Password:'NEVER_EXPORT_PASSWORD'}},message:'api_key=NEVER_EXPORT_KEY password is NEVER_EXPORT_PHRASE',fields:[{id:'password',label:'Password',value:'NEVER_EXPORT_FIELD'}],reasoning:'NEVER_EXPORT_HIDDEN',relativePath:'/home/private/NEVER_EXPORT_PATH'}) as any;
 assert.equal(result.args.values['Application Reference'],'000045');assert.equal(result.args.values['Full Name'],'Invented Person');for(const secret of ['NEVER_EXPORT_PASSWORD','NEVER_EXPORT_KEY','NEVER_EXPORT_PHRASE','NEVER_EXPORT_FIELD','NEVER_EXPORT_HIDDEN','NEVER_EXPORT_PATH'])assert.ok(!JSON.stringify(result).includes(secret),secret);
});

test('vision session metadata is immutable, namespaced, secret-free and survives reopen',async()=>{
 const dir=mkdtempSync(join(process.cwd(),'.local/workflow/vision-session-'));let store=new EvidenceStore(dir);
 try{
  let sessions=new AgentSessionStore(store.db);const envelope:AgentOperationEnvelope={id:'vision-call',workspaceId:'w',accountId:'owner',taskId:'t',runId:'r',revision:1,kind:'vision',model:'invented',configDigest:'a'.repeat(64),inputArtifactId:'image',inputHash:'b'.repeat(64),sourceIds:['source'],status:'attempt',usage:null};
  await sessions.persistOperation({...envelope,password:'NEVER_EXPORT',system:'HIDDEN_SYSTEM',imageBase64:'IMAGE_BLOB'} as AgentOperationEnvelope);
  assert.ok(!JSON.stringify(sessions.operations({workspaceId:'w',accountId:'owner'},'t')).includes('NEVER_EXPORT'));
  await sessions.persistOperation({...envelope,status:'completed',promptDigest:'c'.repeat(64),usage:{inputTokens:3200,outputTokens:150}});
  await assert.rejects(sessions.persistOperation({...envelope,status:'failed',errorCode:'REBOUND'}),/immutable/);
  assert.deepEqual(sessions.operations({workspaceId:'w',accountId:'other'},'t'),[]);
  store.close();store=new EvidenceStore(dir);sessions=new AgentSessionStore(store.db);assert.equal(sessions.operations({workspaceId:'w',accountId:'owner'},'t')[0]!.usage!.inputTokens,3200);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
