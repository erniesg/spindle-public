import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {boundary,drawFace,drawHand,geometry,YEARS,WEEKS} from '../../core/ui/life-dial-geometry.js';
import {parseAge} from '../../core/ui/life-dial.js';
import {lifeDialCss} from '../../core/ui/life-dial-style.js';
import {paletteLiterals} from '../ui/guards.js';
import {tokens} from '../../core/ui/theme.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {portalBundleModules,portalWebFiles} from '../../core/account/portal/web-manifest.js';

test('approved radial face has exactly 4,174 week dots across 80 uneven whole-year boundaries',()=>{
 assert.equal(YEARS,80);assert.equal(WEEKS,4174);
 assert.deepEqual([0,1,23,79,80].map(year=>boundary(year)),[0,52,1200,4121,4174]);
 const layout=geometry(480,480);assert.equal(layout.radius,215);assert.equal(layout.points.length,4174);
 for(let year=0;year<80;year++){
  const points=layout.points.slice(boundary(year),boundary(year+1));
  assert.ok(points.length===52||points.length===53);
  assert.ok(points.every((p,index)=>p.year===year&&p.week===index&&p.length===points.length));
 }
 assert.ok(layout.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.r>0));
});

test('optional ages: no default, finite whole-year input 0–130, illustration saturates without changing age',()=>{
 assert.deepEqual(parseAge(''),{state:'empty'});assert.deepEqual(parseAge('  '),{state:'empty'});
 for(const value of ['NaN','Infinity','-Infinity','-1','131','23.5','1e999'])assert.deepEqual(parseAge(value),{state:'invalid'},value);
 for(const [age,weeks,gridAge] of [[0,0,0],[23,1200,23],[80,4174,80],[103,5374,80],[130,6782,80]])assert.deepEqual(parseAge(String(age)),{state:'valid',age,weeks,gridAge});
});

const trace=()=>{
 const calls:unknown[][]=[];
 const ctx=new Proxy({globalAlpha:1},{get(target,key){if(key==='globalAlpha')return target.globalAlpha;return (...args:unknown[])=>{if(key!=='save'&&key!=='restore')calls.push([key,...args]);};},set(target,key,value){if(key==='globalAlpha')target.globalAlpha=value;return true;}}) as unknown as CanvasRenderingContext2D;
 return {ctx,calls};
};
const colors={ink:'ink',sub:'sub',edge:'edge',now:'now'},fonts={body:'body',display:'display'};
test('empty face has no hand or fabricated centre; supplied age hand can stop at 80 independently of centre',()=>{
 const blank=trace();drawFace(blank.ctx,geometry(480,480),0,colors,fonts,{hand:false,centre:false});
 assert.equal(blank.calls.filter(c=>c[0]==='rotate').length,0);
 assert.deepEqual(blank.calls.filter(c=>c[0]==='fillText').map(c=>c[1]),['0 / 80','10','20','30','40','50','60','70']);
 const older=trace();drawFace(older.ctx,geometry(480,480),103,colors,fonts,{handAge:80});
 assert.deepEqual(older.calls.filter(c=>c[0]==='rotate'),[['rotate',-Math.PI/2+Math.PI*2]]);
 assert.ok(older.calls.some(c=>c[0]==='fillText'&&c[1]==='103'));
});

test('life dial is a bounded browser-only component with shared roles, no network, persistence or HTML sinks',async()=>{
 for(const file of ['life-dial.ts','life-dial-geometry.ts','life-dial-style.ts']){
  const code=await readFile(new URL(`../../../core/ui/${file}`,import.meta.url),'utf8');
  assert.doesNotMatch(code,/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|\.style\b|setAttribute\(\s*['"](?:style|on)|setInterval|setTimeout|requestAnimationFrame|localStorage|sessionStorage|indexedDB|\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|node:|Date\.now/);
  for(const match of code.matchAll(/from ['"]([^'"]+)/g))assert.ok(['./dom.js','./life-dial-geometry.js'].includes(match[1]!));
 }
 assert.deepEqual(paletteLiterals(lifeDialCss),[]);
 for(const [,name] of lifeDialCss.matchAll(/var\((--[a-z0-9-]+)/g))assert.ok(Object.hasOwn(tokens,name!));
});

// Explicit retained approved export, never a dependency or runtime filesystem read.
const source=process.env.SPINDLE_LIFE_DIAL_SOURCE;
test('typed port matches hash-bound approved geometry and default hand/face drawing semantics',{skip:source?false:'set SPINDLE_LIFE_DIAL_SOURCE to retained dist/life-dial.js'},async()=>{
 const bytes=await readFile(source!);assert.equal(createHash('sha256').update(bytes).digest('hex'),'dbf6461a462ccbf7c51646e41e62e286f7a3691b38c4771498156cb9a12480ff');
 const sandbox={module:{exports:{}}};runInNewContext(bytes.toString(),sandbox);
 const original=sandbox.module.exports as {geometry:typeof geometry;boundary:typeof boundary;drawFace:typeof drawFace;drawHand:typeof drawHand};
 for(const [w,h] of [[480,480],[340,340],[200,300],[50,50]])assert.deepEqual(geometry(w,h),JSON.parse(JSON.stringify(original.geometry(w,h))));
 for(let year=0;year<=130;year++)assert.equal(boundary(year),original.boundary(year));
 for(const age of [0,23,80,103]){
  for(const options of [{},{hand:false,centre:false},{handAge:80}]){
   const a=trace(),b=trace(),layout=geometry(480,480);drawFace(a.ctx,layout,age,colors,fonts,options);original.drawFace(b.ctx,layout,age,colors,fonts,options);assert.deepEqual(a.calls,JSON.parse(JSON.stringify(b.calls)));
  }
  const a=trace(),b=trace();drawHand(a.ctx,geometry(480,480),age,'now');original.drawHand(b.ctx,geometry(480,480),age,'now');assert.deepEqual(a.calls,JSON.parse(JSON.stringify(b.calls)));
 }
});

test('actual server serves only allowlisted life dial modules under self CSP and fingerprints their bytes',async()=>{
 const scratch=resolve('.local/life-dial-tests');await mkdir(scratch,{recursive:true});const directory=await mkdtemp(join(scratch,'http-'));
 const server=await startTrackingServer(directory,Buffer.alloc(32,142));
 try{
  for(const path of ['/portal/','/portal/styles.css','/portal/code/account/portal/pomodoro.js','/portal/code/ui/life-dial.js','/portal/code/ui/life-dial-geometry.js']){
   const response=await fetch(server.origin+path);assert.equal(response.status,200,path);assert.match(response.headers.get('content-security-policy')!,/script-src 'self'/);
   if(path.endsWith('.js'))assert.match(response.headers.get('content-type')!,/javascript/);
  }
  for(const path of ['/portal/code/ui/life-dial-style.js','/portal/code/ui/emit.js','/portal/code/ui/life-dial-private.js'])assert.equal((await fetch(server.origin+path)).status,404,path);
  const build=await (await fetch(server.origin+'/portal/build')).json() as {bundleSha256:string;fonts:{files:{file:string;sha256:string}[]}};
  const names=portalBundleModules;
  const hash=createHash('sha256');for(const name of names)hash.update(name+'\0').update(await readFile(new URL('../../core/'+name,import.meta.url)));
  for(const font of build.fonts.files)hash.update(font.file+'\0'+font.sha256+'\0');
  for(const file of portalWebFiles)hash.update('web/'+file.path+'\0').update(await readFile(new URL('../../core/account/portal/web/'+file.path,import.meta.url)));assert.equal(hash.digest('hex'),build.bundleSha256);
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});
