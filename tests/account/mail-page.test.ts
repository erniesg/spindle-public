import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';import {AccountClient} from '../../core/account/client.js';import {mailFixture} from './mail-fixture.js';

test('actual authenticated mail UI drafts, corrects, saves verified Gmail MIME and sends once through registered tools (HTTP/model fixtures)',async()=>{
 const startedUtc=new Date().toISOString(),capture=!!process.env.SPINDLE_MAIL_REVIEW_OUTPUT;
 const f=await mailFixture({reply:true,batch:1}),source=f.prepared();let sentAttachment:{artifactId:string;sha256:string;bytes:Buffer}=source;const base=process.env.RUCKSACK_SCRATCH_ROOT??'/home/ubuntu/.local/state/rucksack/scratch/spindle-gmail-actions';mkdirSync(base,{recursive:true});const output=process.env.SPINDLE_MAIL_REVIEW_OUTPUT??mkdtempSync(join(base,'ui-'));
 mkdirSync(output,{recursive:true});let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try{
  // Genuine mechanism, invented provider only. No live consent or credential-entry recording.
  f.setCompose(true);const flow=await f.client.authorizeGoogleMail(f.flow.connectionId);await f.callback(flow.authorizationUrl);
  const executablePath=process.env.SPINDLE_WEB_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome';
  browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:true});
  const context=await browser.newContext({viewport:{width:1280,height:1000},...(capture?{recordVideo:{dir:join(output,'video'),size:{width:1280,height:1000}}}:{})});
  const signIn=async(target:typeof context)=>{const signed=await target.request.post(f.app.origin+'/signin',{headers:{Origin:f.app.origin},data:{name:'invented-mail-owner',password:'invented-password-123'}});assert.equal(signed.status(),200);};
  await signIn(context);
  // ONE auxiliary unrecorded context, with its OWN invented fixture signin. Never
  // copy cookies or fullPage-screenshot/resize the recorded main page.
  const stillContext=await browser.newContext({viewport:{width:1280,height:1000}});await signIn(stillContext);
  const page=await context.newPage(),stillPage=await stillContext.newPage(),unexpected:string[]=[],auxiliaryEffects:string[]=[],stages:unknown[]=[];
  for(const target of [page,stillPage])target.on('request',r=>{const u=new URL(r.url());if(u.origin!==f.app.origin)unexpected.push(u.origin);if(target===stillPage&&/^\/mail\/(request|edit|publish|send|cancel)$/.test(u.pathname))auxiliaryEffects.push(u.pathname);});
  // Display dwell only for human capture readability, never a job deadline.
  const dwell=async()=>{if(capture)await page.waitForTimeout(1800);};
  const still=async(name:string,revision:number)=>{
   const retained=await f.client.mailAction('list') as any;assert.equal(retained.tasks.length,1);const taskId=retained.tasks[0].taskId;
   const before=await f.client.mailAction('status',{taskId}) as any,ref=before.drafts[0].draft;
   assert.equal(ref.revision,revision);assert.equal(await page.locator('#drafts').inputValue(),ref.draftId);assert.match(await page.locator('#draft-state').innerText(),new RegExp('Revision '+revision+' '));
   const counts=f.counts(),calls=f.calls.length;
   await stillPage.goto(f.app.origin+'/mail');await stillPage.locator('#signed').waitFor({state:'visible'});
   await stillPage.locator('#tasks option[value="'+taskId+'"]').waitFor({state:'attached'});await stillPage.locator('details:has(#tasks)').evaluate(d=>{(d as HTMLDetailsElement).open=true;});await stillPage.locator('#tasks').selectOption(taskId);await stillPage.locator('#open-task').click();
   await stillPage.waitForFunction(rev=>document.querySelector('#draft-state')?.textContent?.startsWith('Revision '+rev+' '),revision);
   assert.equal(await stillPage.locator('#drafts').inputValue(),ref.draftId);assert.equal(await stillPage.locator('#subject').inputValue(),before.drafts[0].subject);
   await stillPage.getByText('Attach current prepared outputs (optional)',{exact:true}).click();
   await stillPage.screenshot({path:join(output,name),fullPage:true});
   const after=await f.client.mailAction('status',{taskId}) as any;assert.deepEqual(after.drafts[0].draft,ref);assert.deepEqual(f.counts(),counts);assert.equal(f.calls.length,calls);assert.deepEqual(auxiliaryEffects,[]);
   stages.push({name,taskId,draft:ref,source:after.source,publish:after.drafts[0].publish,send:after.drafts[0].send,utc:new Date().toISOString(),captureTarget:'same-run unrecorded auxiliary authenticated normal UI'});
   await page.locator('#sender').scrollIntoViewIfNeeded();await dwell();await page.locator('#draft-state').scrollIntoViewIfNeeded();await dwell();
  };
  await page.goto(f.app.origin+'/mail');await page.locator('#signed').waitFor({state:'visible'});assert.equal(f.counts().modelCalls,0);
  await page.getByText('Attach current prepared outputs (optional)',{exact:true}).click();await page.locator('#source-task').selectOption(source.taskId);
  const selectedFile=page.locator('.source-attachment[value="'+source.artifactId+'"]');await selectedFile.check();
  await page.getByRole('button',{name:'Download prepared-'+source.artifactId.slice(0,8)+'.pdf for review',exact:true}).click();const saveLink=page.getByRole('link',{name:'Save prepared-'+source.artifactId.slice(0,8)+'.pdf',exact:true});await saveLink.waitFor({state:'visible',timeout:3000});assert.match((await saveLink.getAttribute('href'))!,/^\/preparation\/download\?/);assert.match(await page.locator('#source-artifacts').innerText(),new RegExp(source.sha256));const [download]=await Promise.all([page.waitForEvent('download'),saveLink.click()]);assert.deepEqual(readFileSync((await download.path())!),source.bytes);
  await page.locator('#refresh').click();assert.equal(await selectedFile.isChecked(),true);assert.equal(f.counts().modelCalls,0);await dwell();
  await page.locator('#request').fill('Draft my fictional workshop application email to the invented recipient, attaching the selected prepared PDF.');await page.locator('#processing').check();await dwell();await page.locator('#draft').click();await page.locator('#review').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('#subject')?.value==='Invented workshop application');await page.waitForFunction(()=>document.querySelector('#reply')?.textContent==='Reply to an existing conversation.');
  // The review UI (since f492821) shows a plain reply indicator; exact thread metadata is asserted on the saved Gmail MIME below.
  await still('01-local-draft.png',1);
  await page.locator('#subject').fill('Corrected invented workshop application');await page.getByText('HTML body (inert text, never rendered)',{exact:true}).click();await page.locator('#html').fill('<img src="https://evil.example.test/never-load" onerror="window.untrustedEmailRan=true">');assert.equal(await page.locator('#send').isDisabled(),true);await dwell();await page.locator('#edit').click();
  await page.waitForFunction(()=>document.querySelector('#draft-state')?.textContent?.includes('Revision 2'));assert.equal(await page.locator('#reviewed').isChecked(),false);assert.equal(await page.evaluate(()=>Object.hasOwn(window,'untrustedEmailRan')),false);
  await still('02-corrected-draft.png',2);
  sentAttachment=source.change();await page.locator('#refresh').click();assert.equal(await page.locator('#send').isDisabled(),true);
  await page.locator('#source-help').scrollIntoViewIfNeeded();assert.equal(await page.locator('#source-help').isVisible(),true);assert.match(await page.locator('#source-help').innerText(),/select the current files and Save corrections/);assert.match(await page.locator('#source-help').innerText(),/No new email request or AI call is needed/);await dwell();
  await page.locator('.source-attachment[value="'+sentAttachment.artifactId+'"]').check();await page.locator('#edit').click();await page.waitForFunction(()=>document.querySelector('#draft-state')?.textContent?.includes('Revision 3'));
  assert.equal(f.counts().modelCalls,2,'replacing a changed prepared output does not rerun AI');await page.locator('#draft-state').scrollIntoViewIfNeeded();assert.match(await page.locator('#draft-state').innerText(),/source revision 2 is current/);await dwell();await page.locator('#reviewed').check();await dwell();await page.locator('#publish').click();
  await page.waitForFunction(()=>document.querySelector('#draft-state')?.textContent?.includes('verified'));assert.equal(f.drafts.size,1);
  {const raw=Buffer.from([...f.drafts.values()][0]!,'base64url').toString('utf8'),post=f.calls.find(c=>c.method==='POST'&&c.path.endsWith('/drafts'))!;assert.match(raw,/^In-Reply-To: <prior@example\.test>\r?$/m);assert.match(raw,/^References: <prior@example\.test>\r?$/m);assert.equal(post.body?.message?.threadId,'thread');}
  assert.equal(f.calls.filter(c=>c.path.endsWith('/drafts/send')).length,0);await still('03-gmail-draft.png',3);
  await page.locator('#reviewed').check();await dwell();page.once('dialog',dialog=>{void dialog.accept();});await page.locator('#send').click();
  await page.waitForFunction(()=>document.querySelector('#draft-state')?.textContent?.includes('provider_acknowledged'));assert.equal(await page.locator('#send').isDisabled(),true);assert.equal(f.drafts.size,0);assert.equal(f.calls.filter(c=>c.path.endsWith('/drafts/send')).length,1);assert.equal(f.counts().modelCalls,2,'owner correction/publish/send must not call AI');
  assert.deepEqual(unexpected,[]);await still('04-provider-acknowledged.png',3);await stillContext.close();
  const other=new AccountClient(f.app.origin);await other.signin('invented-ui-other','invented-password-123',true);
  assert.equal((await context.request.post(f.app.origin+'/signin',{headers:{Origin:f.app.origin},data:{name:'invented-ui-other',password:'invented-password-123'}})).status(),200);
  await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#owner')?.textContent?.includes('invented-ui-other'));
  assert.equal(await page.locator('#sender').textContent(),'');assert.equal(await page.locator('#reply').textContent(),'');assert.equal(await page.locator('#draft-state').textContent(),'');assert.equal(await page.locator('#body').inputValue(),'');assert.equal(await page.locator('#drafts option').count(),0);assert.equal(await page.locator('#tasks option').count(),0);assert.equal(await page.locator('.source-attachment').count(),0);assert.equal(await page.locator('#source-task').inputValue(),'');
  writeFileSync(join(output,'prepared-attachment.pdf'),sentAttachment.bytes);
  const video=page.video();await context.close();const videoPath=video?await video.path():undefined;
  const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
  const artifacts=[...['01-local-draft.png','02-corrected-draft.png','03-gmail-draft.png','04-provider-acknowledged.png','prepared-attachment.pdf'].map(name=>join(output,name)),...(videoPath?[videoPath]:[])].map(path=>{const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};});
  writeFileSync(join(output,'ui-result.json'),JSON.stringify({proof:'SCRIPTED_GOOGLE_AND_MODEL_HTTP_REAL_AUTH_UI_REGISTRY_RUNTIME_MIME',modelDraftAction:'batch',passed:true,startedUtc,completedUtc:new Date().toISOString(),sourceIdentity:{revision:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),base:'a120b5f4180521c30f5bdaf3dd6e609b6035ffbe',trackedStatus:git('status','--porcelain','--untracked-files=no'),untrackedStatus:git('ls-files','--others','--exclude-standard')},hostConfiguration:await f.client.preparationConfiguration(),environment:{node:process.version,platform:process.platform,arch:process.arch,chromium:browser.version(),executablePath,viewport:{width:1280,height:1000},sandbox:true},stages,auxiliaryEffects,modelHttpCalls:f.counts().modelCalls,gmailDraftPosts:f.calls.filter(c=>c.path.endsWith('/drafts')&&c.method==='POST').length,gmailDraftSendPosts:f.calls.filter(c=>c.path.endsWith('/drafts/send')).length,providerFixtureFacts:f.calls.filter(c=>c.path.includes('/gmail/')).map(c=>({method:c.method,path:c.path,...(c.body?.id?{providerDraftId:c.body.id}:{})})),remoteDraftsLeft:f.drafts.size,preparedAttachment:{artifactId:sentAttachment.artifactId,sha256:sentAttachment.sha256,bytes:sentAttachment.bytes.length,revision:2,sourceTaskId:source.taskId,source:'invented prepared-output fixture'},inertHtml:true,unexpectedPageOrigins:unexpected,videoPath,artifacts,transformations:'none: original Playwright webm, auxiliary full-page PNGs, actual revised fixture PDF',actualLiveGmailAcceptance:'UNRUN; requires genuine Gmail grant and exact owner-approved recipient/content',humanAcceptance:'pending'},null,2));
 }finally{await browser?.close();await f.close();if(!capture)rmSync(output,{recursive:true,force:true});}
});
