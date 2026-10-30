import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
const scopes=['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/drive.readonly'];
const secret='INVENTED_CLIENT_SECRET_SENTINEL',refresh='INVENTED_REFRESH_SENTINEL',access='INVENTED_ACCESS_SENTINEL';
const password='invented-password-123';
test('real encrypted backend shares several Google identities across independent Node account clients and restart; owner/root isolation',async()=>{
 const directory=await mkdtemp(join(process.cwd(),'.local/shared-google/store-'));const key=randomBytes(32);let identity='first@example.test',calls=0;
 const http:typeof fetch=async(input,init)=>{calls++;const u=new URL(String(input));
  if(u.hostname==='oauth2.googleapis.com'){assert.equal(new URLSearchParams(init?.body as URLSearchParams).get('client_secret'),secret);return Response.json({access_token:access,refresh_token:refresh,scope:scopes.join(' ')});}
  if(u.hostname==='gmail.googleapis.com')return Response.json({emailAddress:identity});
  assert.equal(new Headers(init?.headers).get('Authorization'),`Bearer ${access}`);
  if(u.pathname==='/drive/v3/files/invented-file'&&u.searchParams.get('alt')==='media')return new Response('Invented source bytes');
  if(u.pathname==='/drive/v3/files/invented-file')return Response.json({id:'invented-file',name:'Invented document',mimeType:'text/plain',parents:['root-a'],version:'1',trashed:false,webViewLink:'https://drive.google.com/file/d/invented-file/view'});
  if(u.pathname==='/drive/v3/files/root-a')return Response.json({id:'root-a',name:'Invented root',mimeType:'application/vnd.google-apps.folder',parents:[],version:'1',trashed:false});
  if(u.pathname==='/drive/v3/files')return Response.json({files:[{id:'invented-file',name:'Invented document',mimeType:'text/plain',version:'1'}]});
  throw Error('Unexpected mock HTTP');
 };
 const config={clientId:'invented-web-client',clientSecret:secret,http};
 const start=()=>startTrackingServer(directory,key,0,undefined,config);
 let server=await start();
 try{
  const web=new AccountClient(server.origin),desktop=new AccountClient(server.origin),other=new AccountClient(server.origin);
  await web.signin('invented-owner',password,true);await desktop.signin('invented-owner',password);await other.signin('invented-other',password,true);
  const begin=async(client:AccountClient,connectionId?:string)=>client.request('/google/begin',connectionId?{connectionId}:{}) as Promise<{connectionId:string;authorizationUrl:string}>;
  const complete=async(flow:{authorizationUrl:string})=>{const u=new URL(flow.authorizationUrl);const callback=new URL(u.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({code:'invented-code',state:u.searchParams.get('state')!}).toString();const result=await fetch(callback,{redirect:'manual'});assert.equal(result.status,200);return result.text();};
  const first=await begin(web);await complete(first);
  let list=await desktop.request('/google/list',{}) as any;assert.equal(list.connections[0].accountId,'first@example.test');
  await desktop.request('/google/roots',{connectionId:first.connectionId,roots:['root-a']});
  identity='second@example.test';const second=await begin(desktop);await complete(second);assert.notEqual(first.connectionId,second.connectionId);
  list=await web.request('/google/list',{}) as any;assert.equal(list.connections.length,2);assert.deepEqual(list.connections.map((v:any)=>v.accountId).sort(),['first@example.test','second@example.test']);
  assert.deepEqual((await other.request('/google/list',{}) as any).connections,[]);
  for(const path of ['/google/begin','/google/roots','/google/disconnect','/google/drive/list'])await assert.rejects(other.request(path,{connectionId:first.connectionId,roots:['root-a'],rootId:'root-a',folder:'root-a',workspaceId:'invented-owner'}));
  const before=calls;await assert.rejects(web.request('/google/drive/list',{connectionId:first.connectionId,rootId:'wrong-root',folder:'wrong-root'}));assert.equal(calls,before);
  const result=await desktop.request('/google/drive/list',{connectionId:first.connectionId,rootId:'root-a',folder:'root-a'}) as any;assert.equal(result.files[0].id,'invented-file');assert.equal(result.provenance.connectionId,first.connectionId);
  const source=await web.readGoogleDrive(first.connectionId,'root-a',result.files[0].id) as any;assert.equal(Buffer.from(source.bytesBase64,'base64').toString(),'Invented source bytes');assert.equal(source.sha256,createHash('sha256').update('Invented source bytes').digest('hex'));assert.equal(source.providerVersion,'1');assert.equal(source.provenance.accountId,'first@example.test');
  for(const value of [list,result,source,await other.request('/history')])for(const sentinel of [secret,refresh,access])assert.ok(!JSON.stringify(value).includes(sentinel));
  const encrypted=await readFile(join(directory,'tracking.enc'));for(const sentinel of [secret,refresh,access,'first@example.test'])assert.ok(!encrypted.includes(Buffer.from(sentinel)));
  await server.close();server=await start();const reopened=new AccountClient(server.origin);await reopened.signin('invented-owner',password);assert.equal((await reopened.request('/google/list',{}) as any).connections.length,2);
  await reopened.request('/google/disconnect',{connectionId:first.connectionId});assert.equal((await reopened.request('/google/list',{}) as any).connections.find((c:any)=>c.id===first.connectionId).status,'disconnected');
 }finally{await server.close();key.fill(0);await rm(directory,{recursive:true,force:true});}
});
