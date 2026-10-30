import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {issueWorkOSAccountSessions, type WorkOSAccountState} from '../../core/account/workos-accounts.js';
import type {WorkOSIdentity} from '../../core/account/workos-provider.js';

const issuer='https://api.workos.com/user_management/client_shared';
const now=1_800_000_000_000;
const identity:WorkOSIdentity={subject:'user_one',sessionId:'session_one',clientId:'client_spindle',expiresAt:now/1000+60};
const empty=():WorkOSAccountState=>({accounts:[],sessions:{}});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const key=(cookie:string)=>hash(cookie.slice('spindle_session='.length));

test('same identity preserves account UUID, devices, history and running timer across clients',()=>{
 const state=empty();
 const first=issueWorkOSAccountSessions(state,identity,issuer,1,now)[0];
 const account=state.accounts[0];
 account.devices.push({id:'device-preserved'});account.entries.push({history:'preserved'});account.seq=9;
 Object.assign(account,{pomodoro:{phase:'focus',startedAt:now-1000}});
 const before=structuredClone(account);
 const second=issueWorkOSAccountSessions(state,{...identity,sessionId:'session_second'},issuer,2,now);
 assert.equal(state.accounts.length,1);assert.deepEqual(account,before);
 assert.equal(second[0].account.id,first.account.id);assert.equal(second[1].account.id,first.account.id);
 assert.match(account.name,/^[a-z0-9._-]{3,64}$/);assert.match(account.id,/^[a-f0-9-]{36}$/);
 assert.equal(account.password,'');assert.match(account.salt,/^[a-f0-9]{64}$/);
 assert.deepEqual(account.workos,{issuer,subject:identity.subject,clientId:identity.clientId});
 assert.equal(Object.keys(state.sessions).length,3);
 const values=[first,...second];assert.equal(new Set(values.map(s=>s.cookie)).size,3);assert.equal(new Set(values.map(s=>s.csrf)).size,3);
 for(const session of values){
  assert.match(session.cookie,/^spindle_session=[a-f0-9]{64}$/);assert.match(session.csrf,/^[a-f0-9]{64}$/);
  const stored=state.sessions[key(session.cookie)];
  assert.equal(stored.account,account.id);assert.equal(stored.csrf,session.csrf);assert.equal(stored.expires,now+12*3600000);
 }
 assert.equal(state.sessions[key(second[0].cookie)].workosSessionId,'session_second');
 delete state.sessions[key(second[0].cookie)];assert.ok(state.sessions[key(second[1].cookie)]);
});

test('password account name collision never merges or mutates accounts',()=>{
 const state=empty();issueWorkOSAccountSessions(state,identity,issuer,1,now);
 delete state.accounts[0].workos;state.accounts[0].password='password-hash';
 const before=structuredClone(state);
 assert.throws(()=>issueWorkOSAccountSessions(state,identity,issuer,1,now),/WORKOS_ACCOUNT_CONFLICT/);
 assert.deepEqual(state,before);
});

test('stable issuer and subject cannot rebind to another client or duplicate account',()=>{
 const state=empty();issueWorkOSAccountSessions(state,identity,issuer,1,now);
 const before=structuredClone(state);
 assert.throws(()=>issueWorkOSAccountSessions(state,{...identity,clientId:'client_sibling'},issuer,1,now),/WORKOS_ACCOUNT_CONFLICT/);
 assert.deepEqual(state,before);
 state.accounts.push({...structuredClone(state.accounts[0]),id:'duplicate'});const duplicate=structuredClone(state);
 assert.throws(()=>issueWorkOSAccountSessions(state,identity,issuer,1,now),/WORKOS_ACCOUNT_CONFLICT/);assert.deepEqual(state,duplicate);
});

test('only stable issuer and subject map accounts; password accounts stay separate',()=>{
 const state=empty();issueWorkOSAccountSessions(state,identity,issuer,1,now);
 const password={...structuredClone(state.accounts[0]),id:'password-owner',name:'my-account',password:'hash'};delete password.workos;
 state.accounts.push(password);
 issueWorkOSAccountSessions(state,{...identity,subject:'user_two'},issuer,1,now);
 assert.equal(state.accounts.length,3);assert.equal(state.accounts[1],password);
 issueWorkOSAccountSessions(state,identity,'https://api.workos.com/user_management/client_other',1,now);assert.equal(state.accounts.length,4);
});

test('invalid identity, issuer, expiry and count reject without expired-session cleanup',()=>{
 for(const patch of [{subject:''},{subject:'machine_one'},{sessionId:''},{clientId:''},{expiresAt:now/1000},{expiresAt:NaN},{subject:'user_'+'x'.repeat(300)}]){
  const state=empty();state.sessions.expired={account:'old',csrf:'old',expires:now-1};const before=structuredClone(state);
  assert.throws(()=>issueWorkOSAccountSessions(state,{...identity,...patch},issuer,1,now));assert.deepEqual(state,before);
 }
 for(const invalid of [issuer+'/',issuer+'?x=1',issuer.replace('https:','http:'),issuer.replace('api.workos.com','evil.test')])assert.throws(()=>issueWorkOSAccountSessions(empty(),identity,invalid,1,now));
 assert.throws(()=>issueWorkOSAccountSessions(empty(),identity,issuer,3 as 1,now));
});

test('session and account caps preflight entire issuance without partial mutations',()=>{
 const state=empty();issueWorkOSAccountSessions(state,identity,issuer,1,now);state.sessions={};
 for(let i=0;i<499;i++)state.sessions['active'+i]={account:'old',csrf:'old',expires:now+1};
 state.sessions.expired={account:'old',csrf:'old',expires:now};
 let before=structuredClone(state);
 assert.throws(()=>issueWorkOSAccountSessions(state,identity,issuer,2,now),/WORKOS_SESSION_BOUND/);assert.deepEqual(state,before);
 issueWorkOSAccountSessions(state,identity,issuer,1,now);assert.equal(Object.keys(state.sessions).length,500);assert.ok(!state.sessions.expired);
 while(state.accounts.length<100)state.accounts.push({...structuredClone(state.accounts[0]),id:'other'+state.accounts.length,name:'other'+state.accounts.length,workos:undefined});
 state.sessions={};before=structuredClone(state);
 assert.throws(()=>issueWorkOSAccountSessions(state,{...identity,subject:'user_new'},issuer,1,now),/WORKOS_ACCOUNT_BOUND/);assert.deepEqual(state,before);
 issueWorkOSAccountSessions(state,identity,issuer,2,now);assert.equal(state.accounts.length,100);
});
