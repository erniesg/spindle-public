import {test} from 'node:test';import assert from 'node:assert/strict';
import {gmailDraftMimeMatches} from '../../core/mail/gmail-drafts.js';
import {mailFixture} from '../account/mail-fixture.js';
function rewritten(raw:string){const mime=Buffer.from(raw,'base64url').toString('utf8'),split=mime.indexOf('\r\n\r\n');return Buffer.from('Received: from invented.example.test\r\n\tby gmailapi.google.com with HTTPREST;\r\n\tWed, 28 Oct 2026 11:10:34 -0700\r\n'+mime.slice(0,split).replace(/^Date:.*$/m,'Date: Wed, 28 Oct 2026 11:10:34 -0700').replace(/^Message-ID:.*$/m,'Message-Id: <invented-provider-id@mail.gmail.com>')+mime.slice(split)).toString('base64url');}
test('known Gmail draft reconciles rewritten transport headers and sends the existing draft once without another AI request',async()=>{
 let reads=0;const f=await mailFixture({draftReadback:raw=>{if(++reads===1)throw Error('invented lost first readback');return rewritten(raw);}});
 try{f.setCompose(true);const upgrade=await f.client.authorizeGoogleMail(f.flow.connectionId);await f.callback(upgrade.authorizationUrl);
 const source=f.prepared(),request=await f.client.mailAction('request',{connectionId:f.flow.connectionId,request:'Draft invented mail with the selected invented PDF',requestId:'one-request',processingConsent:true,sourceTaskId:source.taskId,attachmentIds:[source.artifactId]}) as any;
 const ready=await f.until(request.taskId),draft=ready.drafts[0].draft,calls=f.counts().modelCalls;
 const uncertain=await f.client.mailAction('publish',{taskId:request.taskId,draft,requestId:'publish-once'}) as any;assert.equal(uncertain.drafts[0].publish.state,'uncertain');const providerId=uncertain.drafts[0].publish.providerDraftId;assert.ok(providerId);
 const reconciled=await f.client.mailAction('reconcile',{taskId:request.taskId,draft}) as any;assert.equal(reconciled.drafts[0].publish.state,'verified');assert.equal(reconciled.drafts[0].publish.providerDraftId,providerId);
 const sent=await f.client.mailAction('send',{taskId:request.taskId,draft,requestId:'send-once'}) as any;assert.equal(sent.drafts[0].send.state,'sent');
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/drafts')).length,1);const sends=f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/drafts/send'));assert.equal(sends.length,1);assert.equal(sends[0].body.id,providerId);assert.ok(!f.calls.some(c=>c.path.endsWith('/messages/send')));assert.equal(f.counts().modelCalls,calls);
 }finally{await f.close();}
});

const exact=Buffer.from('From: sender@example.test\r\nDate: Wed, 28 Oct 2026 18:10:01 GMT\r\nMessage-ID: <local@spindle.invalid>\r\nMIME-Version: 1.0\r\nTo: recipient@example.test\r\nSubject: Invented only\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\nSW52ZW50ZWQgdGVzdA==\r\n');
test('Gmail transport normalization preserves every content header and complete MIME bytes',()=>{
 const normalized=Buffer.from(rewritten(exact.toString('base64url')),'base64url');assert.equal(gmailDraftMimeMatches(exact,normalized),true);
 for(const [before,after] of [['recipient@example.test','changed@example.test'],['sender@example.test','changed@example.test'],['Subject: Invented only','Subject: Changed'],['Content-Type: text/plain','Content-Type: text/html'],['SW52ZW50ZWQgdGVzdA==','SW52ZW50ZWQgZXZpbA=='],['MIME-Version: 1.0','MIME-Version: 2.0']]){
  assert.equal(gmailDraftMimeMatches(exact,Buffer.from(normalized.toString().replace(before,after))),false,before);
 }
 for(const header of ['Cc: extra@example.test','Bcc: extra@example.test','Reply-To: extra@example.test','In-Reply-To: <extra@example.test>','References: <extra@example.test>','To: recipient@example.test','Date: Wed, 28 Oct 2026 18:10:01 GMT','Message-ID: <duplicate@example.test>','X-Unapproved: value']){
  assert.equal(gmailDraftMimeMatches(exact,Buffer.from(header+'\r\n'+normalized.toString())),false,header);
 }
 assert.equal(gmailDraftMimeMatches(exact,Buffer.from(normalized.toString().replace('Date: Wed, 28 Oct 2026 11:10:34 -0700','Date: invalid date'))),false);
 assert.equal(gmailDraftMimeMatches(exact,Buffer.from(normalized.toString().replace('<invented-provider-id@mail.gmail.com>','<invalid>'))),false);
 assert.equal(gmailDraftMimeMatches(exact,Buffer.from(normalized.toString().replace(/\r\n/g,'\n'))),false);
 assert.equal(gmailDraftMimeMatches(exact,Buffer.from(normalized.toString().replace('From: sender@example.test','from: sender@example.test'))),false);
 assert.equal(gmailDraftMimeMatches(exact,Buffer.from(normalized.toString().replace('To: recipient@example.test','To:  recipient@example.test '))),false);
 assert.equal(gmailDraftMimeMatches(exact,Buffer.from(normalized.toString().replace('To: recipient@example.test','To:\r\n recipient@example.test'))),false);
 assert.equal(gmailDraftMimeMatches(exact,Buffer.from(normalized.toString().replace('MIME-Version: 1.0\r\nTo: recipient@example.test','To: recipient@example.test\r\nMIME-Version: 1.0'))),false);

});
