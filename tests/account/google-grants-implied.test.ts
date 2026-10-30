import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GoogleOAuth,scopes} from '../../core/connectors/google/oauth.js';

const full='https://www.googleapis.com/auth/drive',driveFile='https://www.googleapis.com/auth/drive.file';
const compose='https://www.googleapis.com/auth/gmail.compose',modify='https://www.googleapis.com/auth/gmail.modify',mailFull='https://mail.google.com/';

// Invented provider only: the token endpoint reports `scope`, the profile endpoint a fixed identity.
function fixture(scope:()=>string){
 let saved:string|undefined;
 const store={get:async()=>saved,set:async(_id:string,value:string)=>{saved=value;},delete:async()=>{saved=undefined;},compareAndSet:async(_id:string,expected:string|undefined,value:string)=>{if(saved!==expected)return false;saved=value;return true;}};
 const http=(async(url:string|URL|Request)=>String(url).includes('/profile')?Response.json({emailAddress:'invented@example.test'}):Response.json({access_token:'INVENTED_ACCESS',refresh_token:'INVENTED_REFRESH',scope:scope()})) as typeof fetch;
 const oauth=new GoogleOAuth('invented',store,http);
 const connect=async(requested:string[],requiredGrants?:string[])=>{const f=oauth.begin(12345,requested);return oauth.exchange(`${f.redirect}?state=${f.state}&code=invented`,f,'connection',undefined,requiredGrants?{requiredGrants}:undefined);};
 return {oauth,connect,saved:()=>saved};
}

test('full Drive implies drive.readonly and drive.file; narrower grants never imply broader ones',async()=>{
 for(const [listed,expected,absent] of [
  [[scopes.mail,full],[scopes.mail,full,scopes.drive,driveFile],[compose]],
  [[mailFull],[mailFull,scopes.mail,compose],[full,scopes.drive,driveFile]],
  [[modify],[modify,scopes.mail,compose],[full,scopes.drive,driveFile]],
  [[scopes.mail,scopes.drive],[scopes.mail,scopes.drive],[driveFile,full,compose]],
  [[scopes.mail,driveFile],[scopes.mail,driveFile],[scopes.drive,full]],
  [[scopes.mail,compose],[scopes.mail,compose],[mailFull,modify]]
 ] as const){
  const f=fixture(()=>listed.join(' ')),result=await f.connect([scopes.mail,scopes.drive,compose,full]);
  assert.deepEqual(result.grants,[...expected],listed.join(' '));
  for(const scope of absent)assert.ok(!result.grants.includes(scope),scope+' must not be implied by '+listed.join(' '));
  assert.deepEqual((await f.oauth.status('connection'))!.grants,[...expected],'persisted grants include the implied scopes');
  assert.doesNotMatch(JSON.stringify(await f.oauth.status('connection')),/INVENTED_(ACCESS|REFRESH)/);
 }
});

test('implied grants satisfy exact required-grant checks; listed duplicates are de-duplicated',async()=>{
 const f=fixture(()=>[scopes.mail,full,full,mailFull].join(' '));
 const result=await f.connect([scopes.mail,scopes.drive,compose,full],[scopes.mail,scopes.drive,driveFile,compose,full]);
 assert.deepEqual(result.missingGrants,[]);assert.equal(new Set(result.grants).size,result.grants.length);
 assert.equal(await f.oauth.accessToken('connection',driveFile),'INVENTED_ACCESS','drive.file connectors accept a full-Drive credential');
 assert.equal(await f.oauth.accessToken('connection',compose),'INVENTED_ACCESS');
});

test('a compose-only grant still lacks the identity grant, and a missing full Drive grant still fails required checks',async()=>{
 await assert.rejects(fixture(()=>compose).connect([scopes.mail,compose]),(e:any)=>e.code==='GOOGLE_IDENTITY_GRANT_REQUIRED');
 const f=fixture(()=>[scopes.mail,scopes.drive,driveFile,compose].join(' '));
 await assert.rejects(f.connect([scopes.mail,scopes.drive,compose,full],[scopes.mail,scopes.drive,compose,full]),(e:any)=>e.status===403&&e.code==='GOOGLE_OUTPUT_GRANT_REQUIRED');
 assert.equal(f.saved(),undefined,'a refused consent never stores a credential');
});

test('refresh re-derives implication from the provider-reported scope (reduction removes implied grants too)',async()=>{
 let scope=[scopes.mail,full].join(' ');const f=fixture(()=>scope);await f.connect([scopes.mail,full]);
 assert.ok((await f.oauth.status('connection'))!.grants.includes(driveFile));
 scope=[scopes.mail,scopes.drive].join(' ');await f.oauth.accessToken('connection',scopes.mail);
 const grants=(await f.oauth.status('connection'))!.grants;assert.deepEqual(grants,[scopes.mail,scopes.drive]);
 await assert.rejects(f.oauth.accessToken('connection',driveFile),/grant absent/);
});
