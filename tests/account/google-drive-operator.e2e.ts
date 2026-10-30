import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';
import {EncryptedStore} from '../../core/tracking/store.js';
import {AccountClient} from '../../core/account/client.js';
import {scopes} from '../../core/connectors/google/oauth.js';
const executable=process.env.SPINDLE_REVIEW_CHROMIUM;if(!executable)throw Error('SPINDLE_REVIEW_CHROMIUM required');
const output=resolve(process.env.SPINDLE_GOOGLE_REVIEW_OUTPUT??'.local/drive-operator/browser');await mkdir(output,{recursive:true});
const directory=await mkdtemp(join(tmpdir(),'drive-operator-')),key=Buffer.alloc(32,37),root='invented-root',file='invented-file';
let version='1',name='PRIVATE_NAME_MUST_NOT_APPEAR.txt',content=Buffer.from('Invented initial source.\n'),reads=0,lists=0;
const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const provider:typeof fetch=async(input)=>{const u=new URL(String(input));if(u.origin==='https://oauth2.googleapis.com'&&u.pathname==='/token')return Response.json({access_token:'INVENTED_ACCESS',token_type:'Bearer',expires_in:3600});assert.equal(u.origin,'https://www.googleapis.com');
 if(u.pathname==='/drive/v3/files'){lists++;return Response.json({files:[{id:file,name,mimeType:'text/plain',version},{id:'invented-shortcut',name:'PRIVATE_SHORTCUT',mimeType:'application/vnd.google-apps.shortcut',version:'1'}]});}
 if(u.pathname==='/drive/v3/files/'+root)return Response.json({id:root,name:'PRIVATE_ROOT',mimeType:'application/vnd.google-apps.folder',version:'1',parents:[],trashed:false});
 if(u.pathname==='/drive/v3/files/'+file){if(u.searchParams.has('alt')){reads++;return new Response(content);}return Response.json({id:file,name,mimeType:'text/plain',version,parents:[root],trashed:false});}
 throw Error('Unexpected provider path');};
const runtime=await startTrackingServer(directory,key,0,undefined,{clientId:'invented-client',clientSecret:'invented-secret',http:provider});
const owner=new AccountClient(runtime.origin),other=new AccountClient(runtime.origin);let browser:any,context:any;
try{
 const account=await owner.signin('invented-operator','invented-private-password',true);await other.signin('invented-other','invented-other-password',true);
 const store=new EncryptedStore<any>(directory,key,()=>({}));const connection='invented-connection';
 await store.transaction(s=>{s.accounts.find((a:any)=>a.id===account.id).google=[{id:connection,incarnation:'invented-incarnation',identity:'invented@example.test',credential:JSON.stringify({accountId:'invented@example.test',refreshToken:'INVENTED_ONLY',accessToken:'INVENTED_ACCESS',expiresAt:Date.now()+3600000,grants:[scopes.mail,scopes.drive]}),roots:[root],rootRevision:1}];});
 await assert.rejects(other.listGoogleDrive(connection,root,root));assert.equal(lists,0);
 browser=await chromium.launch({executablePath:executable,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});context=await browser.newContext({viewport:{width:1100,height:1100},recordVideo:{dir:join(output,'video')}});const page=await context.newPage();
 await context.route('**/*',(r:any)=>new URL(r.request().url()).origin===runtime.origin?r.continue():r.abort());
 await page.request.post(runtime.origin+'/signin',{headers:{Origin:runtime.origin},data:{name:'invented-operator',password:'invented-private-password'}});
 await page.addInitScript(()=>{document.addEventListener('DOMContentLoaded',()=>{const b=document.createElement('p');b.textContent='INVENTED DATA / FAKE GOOGLE · real authenticated UI/API · NOT live Drive acceptance';b.style.cssText='background:#fff4ce;padding:10px';document.body.prepend(b);});});
 await page.goto(runtime.origin+'/connections');await page.locator('#signed[aria-busy="false"]').waitFor();assert.equal(reads,0);assert.equal(lists,0);
 await page.getByRole('button',{name:'Browse saved folder 1 sources',exact:true}).waitFor({timeout:5000});
 await page.getByRole('button',{name:'Browse saved folder 1 sources',exact:true}).click();await page.getByText('2 sources returned',{exact:false}).waitFor();assert.equal(lists,1);assert.equal(reads,0);assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_NAME_MUST_NOT_APPEAR'));assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_SHORTCUT'));assert.equal(await page.getByRole('button',{name:/Read source 2/}).count(),0);
 await page.screenshot({path:join(output,'listed-private-names-hidden.png'),fullPage:true});
 await page.getByRole('button',{name:'Read source 1 (text/plain)',exact:true}).click();await page.getByText('Source verified: 25 bytes',{exact:false}).waitFor();assert.equal(reads,1);
 const downloaded=page.waitForEvent('download');await page.getByRole('link',{name:'Download original source snapshot',exact:true}).click();const download=await downloaded;const path=await download.path();assert.deepEqual(await readFile(path!),content);
 const proofDownload=page.waitForEvent('download');await page.getByRole('link',{name:'Download private source provenance',exact:true}).click();const proofPath=await (await proofDownload).path();assert.ok(proofPath);const proof=JSON.parse(await readFile(proofPath,'utf8'));assert.equal(proof.sha256,digest(content));assert.equal(proof.providerVersion,'1');assert.equal(proof.provenance.rootId,root);
 await page.screenshot({path:join(output,'read-hash-verified-downloads.png'),fullPage:true});
 version='2';name='RENAMED_PRIVATE_INPUT.txt';content=Buffer.from('Invented CHANGED source.\n');await page.getByRole('button',{name:'Read source 1 (text/plain)',exact:true}).click();await page.getByText('The source changed after listing. Browse again before reading.',{exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:'Download original source snapshot',exact:true}).count(),0);
 await page.getByRole('button',{name:'Browse saved folder 1 sources',exact:true}).click();await page.getByRole('button',{name:'Read source 1 (text/plain)',exact:true}).click();await page.getByText('Source verified: '+content.length+' bytes',{exact:false}).waitFor();const changed=page.waitForEvent('download');await page.getByRole('link',{name:'Download original source snapshot',exact:true}).click();const changedPath=await (await changed).path();assert.ok(changedPath);assert.deepEqual(await readFile(changedPath),content);
 await page.reload();await page.locator('#signed[aria-busy="false"]').waitFor();assert.equal(await page.getByRole('link',{name:'Download original source snapshot',exact:true}).count(),0);await page.getByRole('button',{name:'Browse saved folder 1 sources',exact:true}).click();await page.getByText('2 sources returned',{exact:false}).waitFor();
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.locator('#auth:not([hidden])').waitFor();assert.equal(await page.getByRole('button',{name:/Read source/}).count(),0);
 await writeFile(join(output,'result.json'),JSON.stringify({status:'PASS',source:'invented real API/browser only',lists,reads,namespaceDenial:true,noAutomaticRead:true,namesHidden:true,shortcutNotReadable:true,exactDownloadAndProvenanceHash:true,changedVersionRejected:true,renameAndChangedBytes:true,reloadAndSignoutClean:true},null,2)+'\n');console.log('PASS reusable Drive operator UI / real authenticated API / invented provider only');
}finally{if(context)await context.close();if(browser)await browser.close();await runtime.close();await rm(directory,{recursive:true,force:true});}
