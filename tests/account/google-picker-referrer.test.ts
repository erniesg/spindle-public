import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';

test('Picker page sends only its origin while assets and OAuth callbacks suppress referrers',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'spindle-picker-referrer-'));
 const server=await startTrackingServer(directory,randomBytes(32),0,undefined,{clientId:'invented-client',clientSecret:'invented-secret'});
 try{
  const page=await fetch(server.origin+'/connections');
  assert.equal(page.status,200);
  assert.equal(page.headers.get('referrer-policy'),'strict-origin');
  assert.match(page.headers.get('content-security-policy')??'',/frame-src https:\/\/docs\.google\.com https:\/\/drive\.google\.com/);
  for(const path of ['/connections.js','/connections-client.js']){
   const asset=await fetch(server.origin+path);
   assert.equal(asset.status,200);
   assert.equal(asset.headers.get('referrer-policy'),'no-referrer');
  }
  const callback=await fetch(server.origin+'/oauth/callback',{headers:{Accept:'text/html'}});
  assert.equal(callback.headers.get('referrer-policy'),'no-referrer');
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});
