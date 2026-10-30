import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {mailScript} from '../../core/account/mail-page.js';
import {AccountClient} from '../../core/account/client.js';

// Actual UI click handler + AccountClient, minimal DOM and scripted transport.
// A simulated dispatch loses its response. This never invokes a MailService or Send.
test('post-dispatch 503 mail UI reports unknown outcome, retains auth and never retries',async()=>{
 const nodes=new Map<string,any>(),el=(id:string)=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,hidden:false,textContent:'',replaceChildren(){}});return nodes.get(id);};
 let dispatches=0,timers=0;const requests:string[]=[];
 const transport:typeof fetch=async input=>{const path=new URL(String(input)).pathname;requests.push(path);
  if(path==='/session')return Response.json({account:{id:'11111111-1111-4111-8111-111111111111',name:'invented-owner'},csrf:'a'.repeat(64)});
  if(path==='/mail/send'){dispatches++;return Response.json({code:'STORE_OR_REQUEST_UNAVAILABLE'},{status:503});}
  throw Error('Unexpected transport action '+path);
 };
 const source=mailScript.replace("import {AccountClient} from '/connections-client.js';",'').replace('void action(refresh);',`taskId='invented-task';task={state:'ready',execution:'idle'};selected={draft:{draftId:'invented-draft',revision:1}};el('reviewed').checked=true;`);
 const context={AccountClient,location:{origin:'https://ui.example.test'},fetch:transport,crypto:{randomUUID},document:{getElementById:el,querySelectorAll:()=>[]},confirm:()=>true,clearTimeout:()=>{},setTimeout:()=>{timers++;}};
 runInNewContext(source,context);
 await el('send').onclick();
 assert.equal(dispatches,1);assert.deepEqual(requests,['/session','/mail/send']);assert.equal(timers,0);
 assert.doesNotMatch(el('notice').textContent,/nothing was sent|nothing is sent|work is safe|no email has been sent/i);
 assert.match(el('notice').textContent,/unknown|not confirmed/i);assert.match(el('notice').textContent,/status|reconcil/i);assert.match(el('notice').textContent,/before.*retry|do not.*retry/i);
 assert.equal(el('signed').hidden,false);assert.equal(el('auth').hidden,true);
 // Flush promise work: no automatic retry, timer, or duplicate effect is scheduled.
 await new Promise(resolve=>setImmediate(resolve));assert.equal(dispatches,1);assert.equal(timers,0);
});

test('confirmed pre-dispatch unconfigured mail stays friendly and distinguishes generic failures',()=>{
 const explain=runInNewContext(mailScript.match(/function explain\(e\)\{.*\}\nasync function action/)![0].replace('\nasync function action','')+';explain',{expired:()=>false});
 assert.match(explain({status:503,code:'MAIL_NOT_CONFIGURED'}),/still signed in|signed in/i);
 assert.match(explain({status:503,code:'MAIL_NOT_CONFIGURED'}),/nothing was sent|no email has been sent/i);
 for(const error of [{status:503,code:'STORE_OR_REQUEST_UNAVAILABLE'},{status:503,code:'ACCOUNT_HTTP_503'},{status:403,code:'ACCOUNT_HTTP_403'},new TypeError('Failed to fetch')]){
  assert.doesNotMatch(explain(error),/nothing was sent|work is safe|drafts are unchanged/i);
 }
});
