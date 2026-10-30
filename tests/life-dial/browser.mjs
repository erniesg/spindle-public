// Real backend-served Workspace, Chromium 149; invented data only. No native acceptance claim.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright-core';
import {startTrackingServer} from '../../build/core/tracking/server.js';
const output=resolve(process.env.SPINDLE_LIFE_DIAL_EVIDENCE??'.local/life-dial-evidence');
await mkdir(output,{recursive:true});
const directory=await mkdtemp(join(output,'server-')),key=Buffer.alloc(32,142);
const server=await startTrackingServer(directory,key);
const browser=await chromium.launch({executablePath:process.env.SPINDLE_CHROMIUM??`${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux/chrome`,headless:true,chromiumSandbox:true});
const context=await browser.newContext({viewport:{width:1280,height:1100},recordVideo:{dir:output,size:{width:1280,height:1100}}});
const page=await context.newPage(),errors=[],requests=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>requests.push({url:r.url().replace(server.origin,''),method:r.method(),body:r.postData()}));
// Instrument actual canvas drawing (not a fake renderer) and observer retirement.
await page.addInitScript(()=>{
 window.lifeProof={arcs:0,rotations:[],observers:0};
 const arc=CanvasRenderingContext2D.prototype.arc,rotate=CanvasRenderingContext2D.prototype.rotate;
 CanvasRenderingContext2D.prototype.arc=function(...args){if(this.canvas.classList.contains('life-dial-canvas'))window.lifeProof.arcs++;return arc.apply(this,args);};
 CanvasRenderingContext2D.prototype.rotate=function(angle){if(this.canvas.classList.contains('life-dial-canvas'))window.lifeProof.rotations.push(angle);return rotate.call(this,angle);};
 const Original=ResizeObserver;
 window.ResizeObserver=class extends Original{constructor(cb){super(cb);this.active=false;}observe(...args){if(!this.active){this.active=true;window.lifeProof.observers++;}super.observe(...args);}disconnect(){if(this.active){this.active=false;window.lifeProof.observers--;}super.disconnect();}};
});
try{
 await page.goto(server.origin+'/portal/#pomodoro');
 await page.locator('#portal-name').fill('invented-life-dial');await page.locator('#portal-password').fill('invented-only-password');
 await page.getByRole('button',{name:'Create account',exact:true}).click();
 await page.getByRole('button',{name:'View shared history & timer',exact:true}).click();
 await page.locator('.pomodoro-view[data-pomodoro-state=online]').waitFor();
 assert.equal(await page.locator('.pomodoro-countdown').count(),1);
 await page.evaluate(()=>document.fonts.ready);
 if(process.env.SPINDLE_LIFE_DIAL_BASELINE){
  await page.screenshot({path:join(output,'before.png'),fullPage:true});
 }
 await page.getByRole('region',{name:'Life in weeks',exact:true}).waitFor({timeout:2000});
 const card=page.locator('.life-dial-card'),age=card.getByLabel('Age in whole years (optional)');
 await card.scrollIntoViewIfNeeded();
 assert.equal(await age.inputValue(),'');assert.match(await card.innerText(),/No age supplied/);
 assert.equal((await page.evaluate(()=>window.lifeProof.rotations)).length,0);
 assert.ok((await page.evaluate(()=>window.lifeProof.arcs))>=4174);
 await page.screenshot({path:join(output,'empty.png'),fullPage:true});await page.waitForTimeout(1000);
 const storage=await page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}}));
 const beforeInput=requests.length;
 await age.fill('23');await page.waitForTimeout(800);
 assert.match(await card.innerText(),/Age 23 · Estimated 1,200 weeks/);
 assert.ok((await page.evaluate(()=>window.lifeProof.rotations)).some(a=>Math.abs(a-(-Math.PI/2+2*Math.PI*23/80))<1e-12));
 await page.screenshot({path:join(output,'age23.png'),fullPage:true});await page.waitForTimeout(1200);
 for(const value of ['0','80','103','130']){
  await age.fill(value);await page.waitForTimeout(600);assert.match(await card.innerText(),new RegExp(`Age ${value} · Estimated`));
  const rotations=await page.evaluate(()=>window.lifeProof.rotations);
  assert.ok(Math.abs(rotations.at(-1)-(-Math.PI/2+2*Math.PI*Math.min(Number(value),80)/80))<1e-12);
  if(Number(value)>80)assert.match(await card.innerText(),/Beyond the illustrative grid/);
 }
 await page.screenshot({path:join(output,'beyond80.png'),fullPage:true});
 for(const value of ['-1','131','23.5']){await age.fill(value);assert.match(await card.innerText(),/Enter a whole-number age from 0 to 130/);}
 await page.screenshot({path:join(output,'invalid.png'),fullPage:true});await page.waitForTimeout(1200);
 await card.getByRole('button',{name:'Clear age',exact:true}).click();
 assert.equal(await age.inputValue(),'');assert.match(await card.innerText(),/No age supplied/);
 const rotations=await page.evaluate(()=>window.lifeProof.rotations.length);
 await page.setViewportSize({width:390,height:1000});await page.waitForTimeout(500);
 assert.equal(await page.evaluate(()=>window.lifeProof.rotations.length),rotations);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:join(output,'mobile-empty.png'),fullPage:true});
 await page.setViewportSize({width:1280,height:1100});await age.fill('23');
 assert.deepEqual(requests.slice(beforeInput).filter(r=>r.url!=='/pomodoro/read'),[]);
 assert.equal(await page.locator('.pomodoro-view').getAttribute('data-pomodoro-revision'),'0');
 assert.equal(await page.locator('.pomodoro-countdown').count(),1);
 await page.getByRole('button',{name:'Site blocking',exact:true}).click();await card.waitFor({state:'detached'});
 assert.equal(await age.count(),0);assert.equal(await page.evaluate(()=>window.lifeProof.observers),0);
 await page.getByRole('button',{name:'Focus timer',exact:true}).click();await page.locator('.life-dial-card').waitFor();
 assert.equal(await age.inputValue(),'');assert.match(await card.innerText(),/No age supplied/);
 assert.deepEqual(await page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}})),storage);
 assert.deepEqual(requests.slice(beforeInput).filter(r=>!['/pomodoro/read','/blocking/status','/earned-leisure/read'].includes(r.url)),[]);
 assert.deepEqual(errors,[]);
 // Truthful fallback from the same actual served component; no unsupported-canvas success.
 await page.evaluate(async()=>{
  const {createLifeDial}=await import('/portal/code/ui/life-dial.js');
  window.originalCanvasContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=()=>null;
  const dial=createLifeDial(document);document.body.append(dial.root);window.unavailableDial=dial;
 });
 assert.match(await page.locator('.life-dial-card').last().innerText(),/Canvas renderer unavailable/);
 await page.evaluate(()=>{window.unavailableDial.dispose();window.unavailableDial.root.remove();HTMLCanvasElement.prototype.getContext=window.originalCanvasContext;});
 const build=await (await context.request.get(server.origin+'/portal/build')).json();
 await writeFile(join(output,'proof.json'),JSON.stringify({browser:browser.version(),build,requests:requests.map(r=>({path:r.url,method:r.method,body:r.url==='/pomodoro/read'?r.body:undefined})),errors,proof:'Real served portal, invented age 23, empty/clear, 0/80/103/130, invalid input, route-unmount and canvas fallback; no native claim.'},null,2));
 console.log('PASS real served portal life dial: empty/no hand, age 23, boundaries, invalid input, no persistence/age requests, unmount observer cleanup, mobile and unavailable canvas.');
}finally{
 await page.close();await context.close();await browser.close();await server.close();key.fill(0);await rm(directory,{recursive:true,force:true});
}
