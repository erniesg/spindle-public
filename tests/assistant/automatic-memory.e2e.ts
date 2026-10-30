// Real UI/HTTP/SQLite, scripted semantic extraction and account transport. Invented content only, not native/live model proof.
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {AgentStore} from '../../core/storage/agent-store.js';
import {startTaskReview} from '../../core/assistant/app.js';
import {fixture} from './user-memory-fixture.js';
const output=resolve(process.env.SPINDLE_MEMORY_REVIEW_OUTPUT??'.local/automatic-memory-review');await mkdir(output,{recursive:true});
const executablePath=process.env.SPINDLE_REVIEW_CHROMIUM;if(!executablePath)throw Error('Select existing clean Chromium');
const f=fixture(),tasks=new AgentStore(':memory:');await f.app.signin('Alice','invented');await f.app.drain();f.app.start();
const app=await startTaskReview(tasks,{workspaceId:'task-workspace',accountId:'task-account'},f.evidence,f.app);
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1100,height:1000},recordVideo:{dir:join(output,'video'),size:{width:1100,height:1000}}});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(app.url);await page.locator('#user-connected').waitFor({state:'visible'});
 await page.getByLabel('Learn from my conversations',{exact:true}).check();await page.getByLabel('Allow configured model processing of permitted text',{exact:true}).check();await page.getByRole('button',{name:'Update choices',exact:true}).click();
 await page.locator('#user-tell').scrollIntoViewIfNeeded();await page.waitForTimeout(1000);
 await page.getByLabel('Tell Spindle',{exact:true}).fill('I prefer tea. <img src=x onerror="alert(1)">');await page.getByRole('button',{name:'Tell Spindle',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('user-entries')?.textContent?.includes('I prefer tea.'));
 await page.locator('#user-entries').scrollIntoViewIfNeeded();await page.waitForTimeout(2000);await page.locator('#user-entries summary').click();await page.waitForTimeout(1500);
 assert.equal(await page.locator('#user-turns img').count(),0);assert.equal(f.app.recall('tea')[0].origin,'inferred');
 await page.locator('#user-entries').getByRole('button',{name:'Correct',exact:true}).click();await page.getByLabel('Corrected memory',{exact:true}).fill('Prefers coffee and short meetings');
 await page.getByLabel('Tell Spindle',{exact:true}).fill('Draft survives polling');await page.waitForTimeout(3200);
 assert.equal(await page.getByLabel('Corrected memory',{exact:true}).inputValue(),'Prefers coffee and short meetings');assert.equal(await page.getByLabel('Tell Spindle',{exact:true}).inputValue(),'Draft survives polling');
 await page.locator('#user-memory-heading').scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'automatic-memory-desktop.png'),fullPage:true});
 await page.locator('#user-correction').scrollIntoViewIfNeeded();await page.waitForTimeout(1500);
 await page.getByRole('button',{name:'Apply correction',exact:true}).click();await page.waitForFunction(()=>document.getElementById('user-entries')?.textContent?.includes('Prefers coffee and short meetings'));await page.locator('#user-entries').scrollIntoViewIfNeeded();await page.waitForTimeout(2000);
 await page.locator('#user-entries').getByRole('button',{name:'Forget',exact:true}).click();await page.waitForFunction(()=>document.getElementById('user-entries')?.textContent?.includes('Forgotten (tombstone)'));await page.waitForTimeout(2000);
 assert.deepEqual(f.app.recall('coffee'),[]);await page.setViewportSize({width:390,height:844});await page.locator('#user-entries').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(output,'automatic-memory-phone.png'),fullPage:true});await page.waitForTimeout(1000);
 assert.deepEqual(errors,[]);await writeFile(join(output,'journey.json'),JSON.stringify({proof:'Real Chromium/HTTP/SQLite; scripted account/model responses. No native or semantic model-quality claim.',chromium:browser.version(),learnedWithoutSave:true,correction:true,forget:true,draftsSurvivePolling:true,inertText:true,mobileWidth:390},null,2));
}finally{await context.close();await browser.close();await app.close();tasks.close();await f.close();}
console.log('PASS automatic conversation learning, correction/forget, inert text, draft retention and phone layout');
