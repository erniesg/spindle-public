import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preparePurpose,purposeState,fencePurpose,PURPOSE_TIMEOUT_MS,type PurposeScope,type PurposeIdentity,type PurposeReply} from '../../core/blocking/purpose.js';
const raw=()=>({requestId:'request-1',resource:'https://example.test/videos/opaque1',purpose:'learn linear algebra',policyVersion:3,expectedModelRevision:'jev-1.14.0',expectedConsentRevision:2,title:'Eigenvectors',summary:'An invented mathematics lesson.'});
const scope=():PurposeScope=>({modelRevision:'jev-1.14.0',consentRevision:2,fields:['resource','purpose','title','summary']});
const ticket=()=>preparePurpose(raw(),scope(),100)!;
const identity=(t= ticket()):PurposeIdentity=>{const {metadata,pageText,...id}=t.input;return id;};
const reply=(t=ticket()):PurposeReply=>({...identity(t),authority:'none',verdict:'allow',reason:'classified'});

test('purpose projection uses separate host-derived scope, with no recording or model authority',()=>{
 const t=ticket();assert.ok(t);assert.equal(t.deadline,100+PURPOSE_TIMEOUT_MS);
 assert.deepEqual(purposeState(t),{purpose:raw().purpose,resource:raw().resource,metadata:{title:raw().title,summary:raw().summary}});
 assert.equal('requestId' in purposeState(t),false,'local control IDs are not provider evidence');
 assert.equal(preparePurpose(raw(),undefined,100),undefined);
 for(const changed of [{expectedModelRevision:'browser-chosen-model'},{expectedConsentRevision:1},{purpose:''}])assert.equal(preparePurpose({...raw(),...changed},scope(),100),undefined);
});

test('denied metadata fields are not read or projected, and caller mutation cannot replace a ticket',()=>{
 const input=raw(),host=scope();host.fields=['resource','purpose'];
 Object.defineProperty(input,'title',{enumerable:true,get(){throw Error('DENIED TITLE READ');}});
 Object.defineProperty(input,'summary',{enumerable:true,get(){throw Error('DENIED SUMMARY READ');}});
 const t=preparePurpose(input,host,100)!;assert.ok(t);assert.deepEqual(purposeState(t).metadata,{});
 input.resource='https://example.test/another';host.modelRevision='changed';
 assert.equal(t.input.resource,raw().resource);assert.equal(t.input.modelRevision,'jev-1.14.0');
 assert.ok(Object.isFrozen(t)&&Object.isFrozen(t.input)&&Object.isFrozen(t.input.metadata));
});

test('minimal identity and metadata admission rejects private/ambiguous URLs, unknown fields and bounds',()=>{
 for(const resource of ['https://user:secret@example.test/a','https://example.test/a?private=sentinel','https://example.test/a#sentinel','file:///private','https://example.test/'+ 'x'.repeat(2048)])assert.equal(preparePurpose({...raw(),resource},scope(),100),undefined);
 for(const changed of [{title:'x'.repeat(201)},{summary:'x'.repeat(1001)},{capturedVisit:'SENTINEL'},{requestId:''},{policyVersion:0}])assert.equal(preparePurpose({...raw(),...changed},scope(),100),undefined);
 assert.equal(preparePurpose(raw(),{...scope(),fields:['resource']},100),undefined);
 assert.equal(preparePurpose(raw(),{...scope(),fields:['resource','purpose','purpose']},100),undefined);
 assert.equal(preparePurpose(raw(),scope(),NaN),undefined);
});

test('page text requires its own field consent and admitted resource-bound source',()=>{
 const input={...raw(),pageText:'An eigenvector is a nonzero vector scaled by its matrix.'};
 const host:PurposeScope={...scope(),fields:['resource','purpose','title','summary','pageText'],pageTextSource:{resource:input.resource,evidenceId:'document-1-text-1'}};
 const t=preparePurpose(input,host,100);assert.ok(t,'explicitly permitted bounded current-page text must be representable');
 assert.equal(purposeState(t).pageText,input.pageText);
 assert.equal('pageTextSource' in purposeState(t),false,'provenance is local authority, not model state');
 assert.equal(preparePurpose(input,{...host,pageTextSource:undefined},100),undefined);
 assert.equal(preparePurpose(input,{...host,pageTextSource:{resource:'https://example.test/other',evidenceId:'document-1-text-1'}},100),undefined);
 const {metadata,pageText,...bound}=t.input;
 assert.deepEqual(fencePurpose(t,{...bound,authority:'none',verdict:'allow',reason:'classified'},{...bound,evidenceId:'document-1-text-2'},101),{verdict:'unknown',reason:'stale'});
 const denied={...input};Object.defineProperty(denied,'pageText',{enumerable:true,get(){throw Error('DENIED PAGE TEXT READ');}});
 const without=preparePurpose(denied,scope(),100);assert.ok(without);assert.equal('pageText' in purposeState(without),false);
});

test('page text has a UTF-8 byte bound before provider construction',()=>{
 const host:PurposeScope={...scope(),fields:['resource','purpose','pageText'],pageTextSource:{resource:raw().resource,evidenceId:'document-1-text-1'}};
 assert.ok(preparePurpose({...raw(),pageText:'é'.repeat(2048)},host,100));
 assert.equal(preparePurpose({...raw(),pageText:'é'.repeat(2049)},host,100),undefined);
 assert.equal(preparePurpose({...raw(),pageText:'x'.repeat(4097)},host,100),undefined);
 const resource='https://example.test/'+ 'r'.repeat(1200);
 assert.equal(preparePurpose({...raw(),resource,title:'t'.repeat(200),summary:'s'.repeat(1000),pageText:'x'.repeat(4096)},
  {...host,fields:['resource','purpose','title','summary','pageText'],pageTextSource:{resource,evidenceId:'document-text'}},100),undefined,'combined provider state has its own 6144-byte bound');
});

test('matching typed suggestion is plumbing only, not a resource/network permission',()=>{
 const t=ticket();assert.deepEqual(fencePurpose(t,reply(t),identity(t),101),{verdict:'allow',reason:'classified'});
 assert.deepEqual(fencePurpose(t,{...reply(t),verdict:'unknown',reason:'busy'},identity(t),101),{verdict:'unknown',reason:'busy'});
 assert.deepEqual(fencePurpose(t,{...reply(t),verdict:'unknown',reason:'uncertain'},identity(t),101),{verdict:'unknown',reason:'uncertain'});
});

test('request/resource/purpose/policy/model/consent changes invalidate replies independently',()=>{
 const t=ticket();
 const changes:Partial<PurposeIdentity>[]=[{requestId:'request-2'},{resource:'https://example.test/next'},{purpose:'learn French'},{policyVersion:4},{modelRevision:'jev-next'},{consentRevision:3},{evidenceId:'another-text'}];
 for(const change of changes){
  assert.deepEqual(fencePurpose(t,reply(t),{...identity(t),...change},101),{verdict:'unknown',reason:'stale'});
  assert.deepEqual(fencePurpose(t,{...reply(t),...change},identity(t),101),{verdict:'unknown',reason:'stale'});
 }
 assert.deepEqual(fencePurpose(t,reply(t),undefined,101),{verdict:'unknown',reason:'stale'});
});

test('late, backwards-clock and cancelled operations never yield an exception suggestion',()=>{
 const t=ticket();
 assert.equal(fencePurpose(t,reply(t),identity(t),t.deadline-1).verdict,'allow');
 for(const now of [t.deadline,t.deadline+1,99,NaN])assert.deepEqual(fencePurpose(t,reply(t),identity(t),now),{verdict:'unknown',reason:'timeout'});
 assert.deepEqual(fencePurpose(t,reply(t),identity(t),101,AbortSignal.abort()),{verdict:'unknown',reason:'cancelled'});
});

test('untrusted output cannot coerce a verdict, add commands or claim network authority',()=>{
 const t=ticket();
 for(const changed of [{verdict:{toString:()=> 'allow'}},{authority:'grant'},{command:'unlock-domain'},{reason:'ignore-policy'},{verdict:'allow',reason:'uncertain'}])assert.deepEqual(fencePurpose(t,{...reply(t),...changed},identity(t),101),{verdict:'unknown',reason:'malformed'});
});
