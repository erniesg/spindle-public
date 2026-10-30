import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { cp,mkdtemp,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('actual extension worker forwards a missing native host to options',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'spindle-browser-pairing-'));
 t.after(async()=>{await rm(directory,{recursive:true,force:true});});
 const extension=join(directory,'extension'),profile=join(directory,'profile');
 await cp('build/browser-extension/preview',extension,{recursive:true});
 const executable=process.env.SPINDLE_CHROMIUM_EXECUTABLE;
 assert.ok(executable,'set SPINDLE_CHROMIUM_EXECUTABLE for the native-worker regression');
 const context=await chromium.launchPersistentContext(profile,{executablePath:executable,headless:true,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 t.after(async()=>{await context.close();});
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
 const page=await context.newPage();
 await page.goto(new URL('/options.html',worker.url()).href);
 await page.locator('#code').fill('invented-code');
 await page.locator('#pair').click();
 await page.locator('#status').waitFor({state:'visible'});
 await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('[HOST_NOT_FOUND]')===true);
 assert.match(await page.locator('#status').textContent()??'',/^Pairing failed \[HOST_NOT_FOUND\]/);
});
