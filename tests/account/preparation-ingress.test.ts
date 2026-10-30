import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {AccountClient} from '../../core/account/client.js';
import {startTrackingServer} from '../../core/tracking/server.js';

test('normal preparation ingress is authenticated even when processing is not configured',async()=>{
 const directory=await mkdtemp(join(process.cwd(),'.local/workflow/ingress-')),key=randomBytes(32);
 const server=await startTrackingServer(directory,key);let status=0,code='';
 const transport:typeof fetch=async(input,init)=>{const response=await fetch(input,init);if(String(input).endsWith('/preparation/request')){status=response.status;code=(await response.clone().json() as {code:string}).code;}return response;};
 try{
  const client=new AccountClient(server.origin,transport);
  await client.signin('invented-owner','invented-password-123',true);
  await assert.rejects(client.request('/preparation/request',{}));
  assert.equal(status,503);assert.equal(code,'PREPARATION_NOT_CONFIGURED');
  const unauthorized=await fetch(server.origin+'/preparation/request',{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json'},body:'{}'});assert.equal(unauthorized.status,401);
 }finally{await server.close();key.fill(0);await rm(directory,{recursive:true,force:true});}
});
