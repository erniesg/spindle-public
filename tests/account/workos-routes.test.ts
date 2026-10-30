import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {createServer, request as httpRequest} from 'node:http';
import {randomBytes} from 'node:crypto';
import {WorkOSRoutes, type SpindleWorkOSSession} from '../../core/account/workos-routes.js';

test('browser binding rejects swap and replay; session is protected', async () => {
 const f=await setup(); try {
 const a=await f.begin(),b=await f.begin();
 const path='/auth/workos/callback?code=valid&state='+a.state;
 assert.equal((await f.request(path,{headers:{cookie:b.cookie}})).status,400);
 assert.equal(f.exchanges.length,0);
 const r=await f.request(path,{headers:{cookie:a.cookie}});
 assert.equal(r.status,303); assert.equal(r.headers.get('location'),'/portal');
 assert.match(r.headers.get('set-cookie')!,/spindle_session=[a-f0-9]{64};.*HttpOnly;.*SameSite=Strict/);
 assert.deepEqual(f.counts,[1]);
 assert.equal((await f.request(path,{headers:{cookie:a.cookie}})).status,400);
 assert.equal(f.exchanges.length,1);
 } finally {await f.close();}
});
test('native returns independent sessions and validates input',async()=>{
 const f=await setup();try{
 const r=await f.request('/auth/workos/native',{method:'POST',body:JSON.stringify({code:'native',codeVerifier:'x'.repeat(43)})});
 assert.equal(r.status,200);const body=await r.json() as any;
 assert.deepEqual(f.counts,[2]);assert.notEqual(body.tracking.cookie,body.timer.cookie);assert.notEqual(body.tracking.csrf,body.timer.csrf);
 assert.equal(r.headers.get('set-cookie'),null);
 for(const body of [{code:'x',codeVerifier:'short'},{code:'x',codeVerifier:'x'.repeat(43),extra:true}])
 assert.equal((await f.request('/auth/workos/native',{method:'POST',body:JSON.stringify(body)})).status,400);
 assert.equal(f.exchanges.length,1);
 }finally{await f.close();}
});
test('origins, extra query fields, duplicate state, and provider failures are rejected',async()=>{
 const f=await setup();try{
 for(const path of ['/auth/workos/config','/auth/workos/begin']){
 assert.equal((await f.request(path,{headers:{origin:'https://evil.example'}})).status,403);
 assert.equal((await f.request(path+'?x=1')).status,400);
 }
 assert.deepEqual(await(await f.request('/auth/workos/config')).json(),{configured:true,clientId:'client_test',backendOrigin:f.origin});
 const a=await f.begin();
 assert.equal((await f.request('/auth/workos/callback?code=x&state='+a.state+'&state='+a.state,{headers:{cookie:a.cookie}})).status,400);
 f.fail();
 const path='/auth/workos/callback?code=secret&state='+a.state;
 const r=await f.request(path,{headers:{cookie:a.cookie}});
 assert.equal(r.status,400);assert.equal((await r.text()).includes('secret'),false);
 assert.equal((await f.request(path,{headers:{cookie:a.cookie}})).status,400);
 assert.equal(f.exchanges.length,1);
 }finally{await f.close();}
});
test('web attempts are bounded, expire within five minutes, and close invalidates state',async()=>{
 const f=await setup();const realNow=Date.now;try{
 const a=await f.begin();
 for(let i=1;i<64;i++)await f.begin();
 assert.equal((await f.request('/auth/workos/begin')).status,503);
 Date.now=()=>realNow()+300001;
 assert.equal((await f.request('/auth/workos/callback?code=x&state='+a.state,{headers:{cookie:a.cookie}})).status,400);
 assert.equal(f.exchanges.length,0);
 const b=await f.begin();f.routes.close();
 assert.equal((await f.request('/auth/workos/callback?code=x&state='+b.state,{headers:{cookie:b.cookie}})).status,400);
 assert.equal(f.exchanges.length,0);
 }finally{Date.now=realNow;await f.close();}
});
test('web begin only accepts navigation and callback requires exact path and parameters',async()=>{
 const f=await setup();try{
 assert.equal((await f.request('/auth/workos/begin',{headers:{'sec-fetch-mode':'cors'}})).status,403);
 assert.equal((await f.request('/auth/workos/begin',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
 const a=await f.begin();
 for(const suffix of ['&extra=1','&code=another']){
 assert.equal((await f.request('/auth/workos/callback?code=x&state='+a.state+suffix,{headers:{cookie:a.cookie}})).status,400);
 }
 assert.equal((await f.request('/auth/workos/callback?code=x&state='+a.state,{headers:{cookie:a.cookie+'; '+a.cookie}})).status,400);
 assert.equal(f.exchanges.length,0);
 }finally{await f.close();}
});
test('close prevents dispatch and held web/native exchanges cannot issue sessions',async()=>{
 for(const web of [true,false]){
 const f=await setup(true);try{
 let request:Promise<Response>;
 if(web){const a=await f.begin();request=f.request('/auth/workos/callback?code=x&state='+a.state,{headers:{cookie:a.cookie}});}
 else request=f.request('/auth/workos/native',{method:'POST',body:JSON.stringify({code:'x',codeVerifier:'x'.repeat(43)})});
 await f.started;f.routes.close();f.release();
 const result=await request;assert.equal(result.status,400);assert.deepEqual(await result.json(),{error:'Authentication failed'});assert.deepEqual(f.counts,[]);
 for(const path of ['/auth/workos/config','/auth/workos/begin','/auth/workos/native']){
 const response=await f.request(path);assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'Authentication failed'});
 }
 }finally{f.release();await f.close();}
 }
});
test('only web callback forwards previous cookies to the transactional issuer',async()=>{
 const f=await setup();try{
 const a=await f.begin(),previous=a.cookie+'; spindle_session='+'a'.repeat(64);
 assert.equal((await f.request('/auth/workos/callback?code=x&state='+a.state,{headers:{cookie:previous}})).status,303);
 assert.deepEqual(f.previousCookies,[previous]);
 assert.equal((await f.request('/auth/workos/native',{method:'POST',headers:{cookie:'spindle_session='+'b'.repeat(64)},body:JSON.stringify({code:'x',codeVerifier:'x'.repeat(43)})})).status,200);
 assert.deepEqual(f.previousCookies,[previous,undefined]);
 }finally{await f.close();}
});
test('web cookies use exact HTTP and HTTPS scope, persistence, and security attributes',async()=>{
 // HTTP loopback transport models the trusted reverse-proxy hop for the HTTPS configuration.
 for(const secure of [false,true]){
 const f=await setup(false,secure);try{
 const a=await f.begin(),suffix=secure?'; Secure':'';
 assert.equal(a.binding,a.cookie+'; Path=/auth/workos/callback; HttpOnly; SameSite=Lax; Max-Age=300'+suffix);
 const response=await f.request('/auth/workos/callback?code=valid&state='+a.state,{headers:{cookie:a.cookie}});
 assert.equal(response.status,303);
 const cookies=response.headers.getSetCookie();
 // The fixture preserves multiple Set-Cookie headers independently.
 assert.equal(cookies.length,2);
 assert.equal(cookies[0],'spindle_workos_binding=; Path=/auth/workos/callback; HttpOnly; SameSite=Lax; Max-Age=0'+suffix);
 assert.match(cookies[1],/^spindle_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200(; Secure)?$/);
 assert.equal(cookies[1].endsWith('; Secure'),secure);
 }finally{await f.close();}
 }
});
async function setup(hold=false,secure=false){
 const exchanges:string[][]=[],counts:number[]=[],previousCookies:(string|undefined)[]=[];let fail=false;let routes:WorkOSRoutes;
 let release!:()=>void,notifyStarted!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;});
 const started=new Promise<void>(resolve=>{notifyStarted=resolve;});
 const server=createServer(async(req,res)=>{
 const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);
 const raw=Buffer.concat(chunks).toString();
 if(!await routes.handle(req,res,new URL(req.url!,backendOrigin),raw?JSON.parse(raw):undefined)){res.writeHead(404);res.end();}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const backendOrigin=secure?origin.replace('http:','https:'):origin;
 routes=new WorkOSRoutes({authorizationUrl(redirectUri,state,challenge){
 assert.equal(redirectUri,backendOrigin+'/auth/workos/callback');assert.match(challenge,/^[A-Za-z0-9_-]{43}$/);return 'https://provider.example/?state='+state;
 },async exchange(code,verifier){exchanges.push([code,verifier]);notifyStarted();if(hold)await held;if(fail)throw new Error('secret');return {subject:'user_test',sessionId:'session_test',clientId:'client_test',expiresAt:Date.now()/1000+60};}},
 async(_identity,count,previousCookie?:string)=>{counts.push(count);previousCookies.push(previousCookie);return Array.from({length:count},():SpindleWorkOSSession=>({account:{id:'account',name:'Account'},cookie:'spindle_session='+randomBytes(32).toString('hex'),csrf:randomBytes(32).toString('hex')}));},
 {clientId:'client_test',webRedirectUri:backendOrigin+'/auth/workos/callback'});
 const request=(path:string,init:RequestInit={})=>new Promise<Response>((resolve,reject)=>{
 const req=httpRequest(origin+path,{method:init.method??'GET',headers:Object.fromEntries(new Headers(init.headers))},res=>{
 const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
 const headers=new Headers();for(const [name,value]of Object.entries(res.headers))if(value!==undefined){if(Array.isArray(value)){for(const item of value)headers.append(name,item);}else headers.set(name,value);}
 resolve(new Response(Buffer.concat(chunks),{status:res.statusCode!,headers}));
 });});req.on('error',reject);req.end(typeof init.body==='string'?init.body:undefined);
 });
 return {origin,exchanges,counts,previousCookies,request,routes,started,release,fail(){fail=true;},async begin(){
 const r=await request('/auth/workos/begin');assert.equal(r.status,303);
 return {state:new URL(r.headers.get('location')!).searchParams.get('state')!,cookie:r.headers.get('set-cookie')!.split(';')[0],binding:r.headers.get('set-cookie')!};
 },async close(){routes.close();server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}};
}
