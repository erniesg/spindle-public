import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
async function fixture(){const scratch=resolve('.local/portal-tests');mkdirSync(scratch,{recursive:true});const directory=mkdtempSync(join(scratch,'shell-')),key=Buffer.alloc(32,51),server=await startTrackingServer(directory,key);return {server,close:async()=>{await server.close();key.fill(0);rmSync(directory,{recursive:true,force:true});}};}

test('ordinary portal serves the approved app shell and an explicit browser-only module closure',async()=>{
 const f=await fixture();try{
  const response=await fetch(f.server.origin+'/portal'),html=await response.text();assert.equal(response.status,200);
  assert.match(html,/<div id="app"><\/div>/);assert.match(html,/<script type="module" src="\/portal\/code\/account\/portal\/app\.js"><\/script>/);
  assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)/,'no inline script');assert.doesNotMatch(html,/<style[\s>]/);
  const csp=response.headers.get('content-security-policy')!;assert.match(csp,/frame-ancestors 'none'/);assert.match(csp,/script-src 'self';/);assert.match(csp,/style-src 'self' 'unsafe-inline';/);
  assert.equal(csp.match(/unsafe-inline/g)?.length,1,'unsafe-inline is limited to style-src');assert.doesNotMatch(csp,/unsafe-eval|data:/);
  assert.equal(response.headers.get('cache-control'),'no-store');
  for(const path of ['/portal/web/spindle.css','/portal/web/portal.css','/portal/web/palette.css','/portal/web/fonts.css','/portal/web/fonts/instrument.woff2','/portal/web/fonts/dm-sans-normal.woff2','/portal/web/flowing-sand.svg']){const r=await fetch(f.server.origin+path);assert.equal(r.status,200,path);await r.arrayBuffer();}
  for(const path of ['/portal/web/../build.json','/portal/web/nothing.css','/portal/web/web-manifest.js'])assert.notEqual((await fetch(f.server.origin+path)).status,200,path);
  const app=['app','brand','ui','context','prep','today','review','connections','settings','lock-in','attention'].map(n=>'/portal/code/account/portal/'+n+'.js');
  const urls=[...app,'/portal/code/account/portal/tracking.js','/portal/code/account/portal/pomodoro.js','/portal/code/account/portal/blocking.js','/portal/code/account/portal/application.js','/portal/code/account/client.js','/portal/code/pomodoro/client.js','/portal/code/pomodoro/protocol.js','/portal/code/pomodoro/focus-dial.js','/portal/code/ui/dom.js','/portal/code/ui/life-dial.js','/portal/code/ui/life-dial-geometry.js'];
  for(const url of urls){const r=await fetch(f.server.origin+url);assert.equal(r.status,200,url);assert.match(r.headers.get('content-type')!,/javascript/);const source=await r.text();for(const match of source.matchAll(/(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?['"](\.[^'"]+)['"]/g))assert.ok(urls.includes(new URL(match[1]!,f.server.origin+url).pathname),url+' imports outside browser allowlist');}
  const build=await fetch(f.server.origin+'/portal/build').then(r=>r.json()) as any;assert.match(build.bundleSha256,/^[a-f0-9]{64}$/);assert.equal(typeof build.sourceDirty,'boolean');
 }finally{await f.close();}
});

test('portal asset boundary does not expose server/config files or create an API authentication exception',async()=>{
 const f=await fixture();try{
  for(const path of ['/portal/code/tracking/server.js','/portal/code/account/portal/assets.js','/portal/code/account/portal/__proto__','/portal/code/../../../package.json']){const r=await fetch(f.server.origin+path);assert.notEqual(r.status,200,path);assert.ok(!(await r.text()).includes('clientSecret'));}
  assert.equal((await fetch(f.server.origin+'/portal',{method:'POST',headers:{Origin:f.server.origin}})).status,403);
  assert.equal((await fetch(f.server.origin+'/portal',{headers:{Origin:'https://foreign.example.test'}})).status,403);
  assert.equal((await fetch(f.server.origin+'/portal?file=../../tracking.enc')).status,403);
  assert.equal((await fetch(f.server.origin+'/history')).status,401);
  const client=new AccountClient(f.server.origin);await client.signin('invented-portal-owner','invented-password-123',true);assert.deepEqual((await client.request('/devices') as any).devices,[]);assert.equal((await client.request('/pomodoro/read',{}) as any).timer.revision,0);
  await client.signout();await assert.rejects(client.request('/devices'),/SIGNIN_REQUIRED/);
 }finally{await f.close();}
});
