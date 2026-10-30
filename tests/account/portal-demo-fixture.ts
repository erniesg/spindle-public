// Invented-activity helpers shared by portal-demo.test.ts and portal-demo.e2e.ts. The model is a
// real TextProvider whose transport is SCRIPTED: no network, credential or paid call.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PreviewSession} from '../../core/preview/session.js';
import {CallBudget,TextProvider,type ModelDeclaration} from '../../core/models/provider.js';
import type {ClassificationConfig} from '../../core/account/classification-host.js';
import type {Operation} from '../../core/tracking/types.js';

export const model:ModelDeclaration={provider:'nebius',id:'invented/classifier',text:true,jsonObject:true,inputContextTokens:4096,maxOutputTokens:256,pricing:{inputUsdPerMillion:0.1,outputUsdPerMillion:0.1,verifiedAt:'2026-10-01T00:00:00Z',source:'https://example.com/invented-pricing'}};
export function scripted(){
 const calls:string[]=[];
 const transport=(async(_url:string,init:RequestInit)=>{calls.push(String(init.body));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({decision:'suggest',categoryId:'learning',activityId:'reading',relatedIds:[]})}}],usage:{prompt_tokens:40,completion_tokens:12}}));}) as unknown as typeof fetch;
 const config:ClassificationConfig={model,createProvider:()=>new TextProvider(model,new CallBudget(1,10),async()=>'invented-server-key',transport)};
 return {config,calls};
}
let recordings=0;
/** One closed invented visit of `seconds`, as a device would upload it. */
export function observation(deviceId:string,wall:number,seconds=20,text='Invented permitted reading about invented cell biology notes',title='Invented study chapter'):Operation{
 const session=new PreviewSession();session.start({pixels:false,rich:false,retain:true});
 assert.equal(session.focus({epoch:session.epoch,at:0,revision:1,key:'invented/window',app:'Reader',title,clock:'source-boot-1'}),true);
 assert.equal(session.sample({epoch:session.epoch,revision:1,at:0,text,textSource:'native',status:'native-text'}),true);
 session.pause(seconds*1000);const visit=session.visits[0]!,recordingId=`recording-${++recordings}`;
 return {id:randomUUID(),deviceId,recordingId,visitId:visit.id,record:{schema:'spindle-tracking/v1',deviceId,recordingId,visitId:visit.id,revision:1,consentRevision:1,policyRevision:1,wallAnchor:wall,monotonicAnchor:0,observedAt:seconds*1000,expiresAt:wall+3600000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:seconds*1000,coverage:'observed'},visit}};
}
export type {ClassificationConfig};
