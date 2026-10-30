// Shared extractor check only, not Linux recording/product or Mac/Windows enrollment proof.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { visibleText } from '../../browser-extension/preview/extract.js';
const browser=await chromium.launch({headless:true});
try{
 const context=await browser.newContext(),page=await context.newPage();
 await page.setContent('<div style="mask-image:linear-gradient(transparent,transparent)">MASKED_SECRET</div><div style="color:transparent">TRANSPARENT_SECRET</div><div style="height:0;overflow:hidden">CLIPPED_SECRET</div><h1>INVENTED ARTICLE</h1><p id="changing">Visible counter one</p><input value="FORM_SECRET"><textarea>TEXTAREA_SECRET</textarea><div contenteditable>EDITABLE_SECRET</div><div hidden>HIDDEN_SECRET</div><div style="visibility:hidden">CSS_SECRET</div><div style="position:absolute;top:3000px">OFFSCREEN_SECRET</div><iframe srcdoc="IFRAME_SECRET"></iframe>');
 await page.bringToFront();const first=await page.evaluate(visibleText,false);assert.ok(first);assert.match(first.text,/INVENTED ARTICLE/);assert.match(first.text,/counter one/);assert.ok(!first.text.includes('SECRET'));
 await page.locator('#changing').evaluate(e=>{e.textContent='Visible counter two';});const second=await page.evaluate(visibleText,false);assert.ok(second);assert.match(second.text,/counter two/);
 // Headless Playwright emulates focused pages. Inject only the negative focus signal;
 // this is not proof of OS/browser-window focus association.
 await page.evaluate(()=>Object.defineProperty(document,'hasFocus',{value:()=>false}));assert.equal(await page.evaluate(visibleText,false),null);
 await context.close();console.log('Actual disposable Chromium DOM extractor passed: visible text, same-document update, form/editable/hidden/offscreen/iframe exclusion, injected unfocused denial. Not native capture/enrollment proof.');
}finally{await browser.close();}
