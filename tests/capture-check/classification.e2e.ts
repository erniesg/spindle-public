// Production UI/session/labels/provider; invented native events + local HTTP model
// mock. Never Native or authenticated Nebius acceptance; no real key lookup.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { PreviewSession } from '../../core/preview/session.js';
import { CaptureClassification } from '../../core/preview/classification.js';
import { CallBudget,TextProvider,type ModelDeclaration } from '../../core/models/provider.js';
const output=resolve(process.env.SPINDLE_CLASSIFICATION_OUTPUT??'.local/classification-ui');await mkdir(output,{recursive:true});
const bodies:Record<string,any>[]=[];
const model:ModelDeclaration={provider:'nebius',id:'synthetic-vision-not-live',text:true,jsonObject:true,inputContextTokens:16384,maxOutputTokens:512,images:{inputTokensUpperBound:4096,accounting:'input-tokens'},pricing:{inputUsdPerMillion:1,outputUsdPerMillion:2,verifiedAt:'2026-10-24',source:'https://example.org/synthetic-pricing'}};
const peer=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;bodies.push(JSON.parse(raw));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({decision:'suggest',categoryId:'work',activityId:'coding',relatedIds:[]})}}],usage:{prompt_tokens:100,completion_tokens:20}}));});
await new Promise<void>(r=>peer.listen(0,'127.0.0.1',r));const modelOrigin=`http://127.0.0.1:${(peer.address() as AddressInfo).port}`;
const provider=new TextProvider(model,new CallBudget(1,4),async()=>'invented-mock-key',async(url,init)=>{assert.equal(String(url),'https://api.tokenfactory.nebius.com/v1/chat/completions');return fetch(modelOrigin,init);});
const session=new PreviewSession(),labels=new CaptureClassification(session,provider),token='invented-owner-token';
const server=createServer(async(req,res)=>{
 try{
  res.setHeader('Cache-Control','no-store');
  if(req.url==='/'||req.url==='/ui.js'){res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(await readFile(resolve('build/core/preview',req.url==='/'?'index.html':'ui.js')));return;}
  assert.equal(req.headers.authorization,`Bearer ${token}`);res.setHeader('Content-Type','application/json');
  if(req.url==='/state'){res.end(JSON.stringify({...session.snapshot(),classification:labels.snapshot(),platform:'synthetic-peer',provider:'invented native events',lastCode:'NOT_NATIVE_OR_NEBIUS_ACCEPTANCE',pair:'not-enrolled'}));return;}
  let raw='';for await(const c of req)raw+=c;const d=JSON.parse(raw||'{}');let result:unknown={ok:true};
  if(req.url==='/classification/local')labels.local(d.enabled);
  else if(req.url==='/classification/remote'){if(!d.text&&!d.image)labels.revokeRemote();else labels.grantRemote(d.text,d.image);}
  else if(req.url==='/classification/correct')labels.correct(d.visit,d.labels,d.ref);
  else if(req.url==='/classification/classify')result=await labels.classify(d.visit,d.mode);
  else if(req.url==='/clear')session.clear();else throw new Error('unexpected test route');
  res.end(JSON.stringify(result));
 }catch{res.statusCode=409;res.end('{"code":"UNAVAILABLE"}');}
});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.SPINDLE_CHROMIUM_EXECUTABLE});
const context=await browser.newContext({viewport:{width:1200,height:900},...(process.env.SPINDLE_CLASSIFICATION_RECORD==='1'?{recordVideo:{dir:output,size:{width:1200,height:900}}}:{})});const page=await context.newPage();
try{
 async function showStep(text:string,target='#visits article'){
  if(process.env.SPINDLE_CLASSIFICATION_RECORD!=='1')return;
  await page.evaluate(message=>{let banner=document.getElementById('demo-caption');if(!banner){banner=document.createElement('div');banner.id='demo-caption';banner.style.cssText='position:fixed;top:8px;left:8px;right:8px;padding:14px;background:#123b42;color:white;font:20px sans-serif;z-index:99999;pointer-events:none;border:3px solid #59dfc9';document.body.append(banner);}banner.textContent='COMPONENT DEMO · invented capture + mock model | '+message;},text);
  await page.locator(target).first().evaluate(e=>e.scrollIntoView({block:'center'}));await page.waitForTimeout(3500);
 }
 const sample=await context.newPage();await sample.setContent('<body style="margin:0"><div id="image-sample" style="box-sizing:border-box;width:820px;height:300px;font:22px monospace;padding:16px"><h1 style="font-size:25px">INVENTED CODING EXAMPLE</h1><pre>function inventedExample() {\n  return "sample only";\n}</pre><p>Component test image, not native capture.</p></div></body>');const png=(await sample.locator('#image-sample').screenshot()).toString('base64');await sample.close();
 function visit(n:number,rich:boolean){session.start({rich,retain:rich,pixels:rich});session.focus({epoch:session.epoch,revision:1,at:n,key:'invented-'+n,app:'spindlefixture',title:'Invented coding example '+n,clock:'invented',browser:false});session.sample({epoch:session.epoch,revision:1,at:n+1,text:rich?'':'function inventedExample() { return "sample only"; }',status:rich?'ocr-empty':'native-text',image:rich?png:'',...(rich?{capture:{pixels:'captured',ocr:'ocr-empty',image:'image-retained',sourceWidth:820,sourceHeight:300,imageWidth:820,imageHeight:300,ocrWidth:820,ocrHeight:300}}:{})});session.pause(n+3);}
 visit(1,true);await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/#${token}`);
 await page.locator('h1').evaluate(e=>{e.textContent='Classification demo — invented capture + mock model';});
 await page.getByRole('button',{name:'Enable local labels',exact:true}).click();await page.waitForFunction(()=>document.getElementById('classification-status')?.textContent?.includes('Local labels on'));
 assert.equal(bodies.length,0);await showStep('1. Enable local labels — no network request');await page.getByRole('button',{name:'Correct labels',exact:true}).first().click();await page.locator('#correction-category').selectOption('learning');await page.locator('#correction-activity').selectOption('reading');await page.waitForTimeout(1600);assert.equal(await page.locator('#correction-category').inputValue(),'learning');await page.getByRole('button',{name:'Save correction',exact:true}).click();await page.waitForFunction(()=>document.getElementById('visits')?.textContent?.includes('exact-user-correction'));
 assert.equal(await page.locator('#visits article').first().locator('p').last().textContent(),'Learning · Reading — Your correction');
 await showStep('2. Change this visit to Learning / Reading — your correction wins');
 await page.screenshot({path:resolve(output,'local-correction.png'),fullPage:true});await page.locator('#visits article').first().screenshot({path:resolve(output,'local-result-detail.png')});
 visit(10,true);await page.locator('#remote-image').check();await page.getByRole('button',{name:'Apply remote consent',exact:true}).click();await page.waitForFunction(()=>document.getElementById('classification-status')?.textContent?.includes('remote text on, image on'));
 await page.getByRole('button',{name:'Classify Rich image + text',exact:true}).first().click();await page.waitForFunction(()=>document.getElementById('message')?.textContent==='suggested');assert.equal(bodies.length,1);assert.equal(bodies[0].messages[1].content[1].image_url.url,'data:image/png;base64,'+png);
 await page.waitForTimeout(900);await showStep('3. Rich request sends this screenshot + text to the mock model');await page.screenshot({path:resolve(output,'rich-image-classified.png'),fullPage:true});await page.locator('#visits article').first().screenshot({path:resolve(output,'rich-result-detail.png')});
 visit(20,false);await page.waitForTimeout(900);const textDone=page.waitForResponse(r=>r.url().endsWith('/classification/classify'));await page.getByRole('button',{name:'Classify text with Nebius',exact:true}).first().click();await textDone;await page.waitForFunction(()=>document.getElementById('message')?.textContent==='suggested');await page.waitForTimeout(200);assert.equal(bodies.length,2);assert.equal(typeof bodies[1].messages[1].content,'string');assert.ok(!JSON.stringify(bodies[1]).includes(png));
 assert.equal(labels.inspect(session.visits[0].id).labels.categoryId,'learning','another visit must not replace the earlier exact correction');
 await showStep('4. Basic request sends text only — no screenshot');
 await page.getByRole('button',{name:'Revoke remote consent',exact:true}).click();await page.waitForFunction(()=>document.getElementById('classification-status')?.textContent?.includes('remote text off, image off'));
 await showStep('5. Revoke remote access — local correction is still retained');
 await page.getByRole('button',{name:'Delete all context',exact:true}).click();await page.waitForTimeout(900);assert.equal(await page.locator('#visits article').count(),0);assert.equal(labels.snapshot().assignments.length,0);await showStep('6. Delete all context — captured visits and labels are gone','#visits');await page.screenshot({path:resolve(output,'cleared.png'),fullPage:true});
 await writeFile(resolve(output,'receipt.json'),JSON.stringify({scope:'production UI/capture core/classifier/provider with invented native events and actual local HTTP model mock; NOT native or live Nebius',remoteCalls:2,richImageSent:true,basicImageAbsent:true,correctionDialogStableAcrossPolls:true,clearRemovedAssignments:true},null,2));console.log('PASS production classification components: local correction, Rich PNG+text, Basic text-only, revoke/Clear. Native/paid peers synthetic.');
}finally{
 labels.dispose();console.log('Closing component browser context');await context.close();
 console.log('Closing component browser');await browser.close();
 server.closeAllConnections();server.close();peer.closeAllConnections();peer.close();console.log('Component resources closed');
}
