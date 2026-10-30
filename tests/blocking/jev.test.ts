import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {preparePurpose,type PurposeScope} from '../../core/blocking/purpose.js';
import {buildJevComparison,parseJevComparison,JEV_MODEL,JEV_SCOPE_REVISION,JEV_REQUEST_BYTES,SCORE_LEVELS} from '../../core/blocking/jev.js';
const request=(text=true)=>{
 const resource='https://example.test/lesson';
 const scope:PurposeScope={modelRevision:JEV_SCOPE_REVISION,consentRevision:1,fields:['resource','purpose','title','pageText'],pageTextSource:{resource,evidenceId:'sha256:invented-test-snapshot'}};
 return preparePurpose({requestId:'comparison-1',resource,purpose:'Learn eigenvectors',policyVersion:1,expectedModelRevision:JEV_SCOPE_REVISION,expectedConsentRevision:1,title:'Eigenvectors',...(text?{pageText:'An eigenvector is a nonzero vector scaled by its matrix.'}:{})},scope,100)!;
};
const raw=()=>({model:JEV_MODEL,answers:{
 relevance_choice:{type:'choice',choice:'insufficient',confidence:.83,probabilities:{relevant:.11,unrelated:0,insufficient:.89}},
 relevance_score:{type:'score',score:2.43,confidence:.64,legend:Object.fromEntries(SCORE_LEVELS.map((v,i)=>[String(i),v])),probabilities:{0:0,1:0,2:.57,3:.43,4:0}},
 explains_concept:{type:'noul',noul:.5},
},usage:{input_tokens:600,output_tokens:100}});

test('one bounded request mixes native choice/score/noul on the same permitted state without fetching URLs',()=>{
 const withText=buildJevComparison(request())!,metadata=buildJevComparison(request(false))!;
 assert.ok(withText&&metadata);assert.equal(withText.questions.explains_concept.type,'noul');
 assert.equal(withText.questions.relevance_score.criteria.length,5);
 assert.equal(withText.state.pageText,'An eigenvector is a nonzero vector scaled by its matrix.');
 assert.equal('pageText' in metadata.state,false);
 for(const field of ['expected','requestId','policyVersion','consentRevision','evidenceId','pageTextSource'])assert.equal(Object.hasOwn(withText.state,field),false);
 assert.ok(new TextEncoder().encode(JSON.stringify(withText)).byteLength<=JEV_REQUEST_BYTES);
 assert.match(withText.questions.relevance_choice.instructions,/cannot open/);
 assert.match(withText.questions.relevance_choice.instructions,/not instructions/);
 assert.match(withText.questions.relevance_score.instructions,/serve the user-designated purpose/);
 assert.doesNotMatch(withText.questions.relevance_score.instructions,/explain the concept requested/);
 assert.equal('urlFetcher' in withText,false);
});

test('an unapproved revision or oversized envelope cannot silently dispatch',()=>{
 const ticket=request();assert.equal(buildJevComparison({...ticket,input:{...ticket.input,modelRevision:'jev-1.14.0'}}),undefined);
 assert.equal(buildJevComparison({...ticket,input:{...ticket.input,pageText:'x'.repeat(8192)}}),undefined);
});

test('actual public excerpts retain provenance and metadata-only/with-text differ only by supplied text',async()=>{
 const fixture=JSON.parse(await readFile(new URL('../../../tests/fixtures/purpose-grounded.json',import.meta.url),'utf8')) as {purpose:string;source_byte_limit:number;cases:{id:string;url:string;title:string;text:string;text_sha256:string;text_utf8_bytes:number;retrieval_started_utc:string;retrieval_finished_utc:string;source_prefix_bytes:number;http_status:number}[]};
 for(const page of fixture.cases){
  assert.equal(createHash('sha256').update(page.text).digest('hex'),page.text_sha256);
  assert.equal(Buffer.byteLength(page.text),page.text_utf8_bytes);assert.ok(page.source_prefix_bytes<=fixture.source_byte_limit);assert.equal(page.http_status,200);
  assert.ok(Date.parse(page.retrieval_finished_utc)>=Date.parse(page.retrieval_started_utc));
  const host:PurposeScope={modelRevision:JEV_SCOPE_REVISION,consentRevision:1,fields:['resource','purpose','title','pageText'],pageTextSource:{resource:page.url,evidenceId:`sha256:${page.text_sha256}`}};
  const raw={requestId:page.id,resource:page.url,purpose:fixture.purpose,policyVersion:1,expectedModelRevision:JEV_SCOPE_REVISION,expectedConsentRevision:1,title:page.title};
  const metadata=buildJevComparison(preparePurpose(raw,host,100)!)!,withText=buildJevComparison(preparePurpose({...raw,pageText:page.text},host,100)!)!;
  assert.ok(metadata&&withText);const {pageText,...same}=withText.state;assert.deepEqual(same,metadata.state);assert.equal(pageText,page.text);
  assert.equal('manual_expected_with_text' in withText.state,false);assert.equal('retrieval_started_utc' in withText.state,false);
 }
});

test('choice confidence describes the selected insufficient label, not probability of relevance',()=>{
 const parsed=parseJevComparison(raw())!;assert.ok(parsed);
 assert.equal(parsed.choice.label,'insufficient');assert.equal(parsed.choice.confidence,.83);assert.equal(parsed.choice.probabilities.relevant,.11);
 assert.equal(parsed.authority,'none');assert.equal('allow' in parsed,false);
 assert.equal(parsed.noul.probability,.5);assert.equal('confidence' in parsed.noul,false);
});

test('score preserves weighted ordinal position, level probabilities and legend, not an allow probability',()=>{
 const parsed=parseJevComparison(raw())!;assert.equal(parsed.score.value,2.43);assert.equal(parsed.score.probabilities['3'],.43);assert.equal(parsed.score.legend['4'],SCORE_LEVELS[4]);
 const single=raw(),split=raw();single.answers.relevance_score={...single.answers.relevance_score,score:2,confidence:1,probabilities:{0:0,1:0,2:1,3:0,4:0}};
 split.answers.relevance_score={...split.answers.relevance_score,score:2,confidence:0,probabilities:{0:.5,1:0,2:0,3:0,4:.5}};
 assert.equal(parseJevComparison(single)!.score.value,parseJevComparison(split)!.score.value);
 assert.notDeepEqual(parseJevComparison(single)!.score.probabilities,parseJevComparison(split)!.score.probabilities);
});

test('native malformed/normalized/missing answers and invalid usage fail closed',()=>{
 const valid=raw();
 for(const changed of [
  {...valid,model:'different-model'},
  {...valid,answers:{...valid.answers,relevance_choice:{...valid.answers.relevance_choice,choice:'allow'}}},
  {...valid,answers:{...valid.answers,relevance_choice:{...valid.answers.relevance_choice,probabilities:{relevant:1,unrelated:1,insufficient:1}}}},
  {...valid,answers:{...valid.answers,relevance_score:{...valid.answers.relevance_score,score:4}}},
  {...valid,answers:{...valid.answers,relevance_score:{type:'score',score:2.43,confidence:.64}}},
  {...valid,answers:{...valid.answers,explains_concept:{type:'bool',probability:.9}}},
  {...valid,answers:{...valid.answers,explains_concept:{type:'noul',noul:1.1}}},
  {...valid,answers:{...valid.answers,run_command:{type:'noul',noul:1}}},
  {...valid,usage:{input_tokens:65537,output_tokens:100}},
 ])assert.equal(parseJevComparison(changed),undefined);
});
