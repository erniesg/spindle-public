// Saved-media review page, following Rucksack PR #8's private-viewer pattern.
// This tool never runs the app, reads activity, uploads files or loads credentials.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => entities[c]);
export interface Review {
  title: string; summary: string; caveat: string;
  capturedAt: string; expiresAt: string; codeVersion: string; viewerVersion: string;
  recording: string; recordingFallback?: string; recordUrl: string;
  screens: { url: string; label: string; phone?: boolean }[];
  downloads: { url: string; label: string }[];
}

export function renderReviewPage(review: Review) {
  const links = [review.recording, review.recordUrl, ...(review.recordingFallback ? [review.recordingFallback] : []), ...review.screens.map(s => s.url), ...review.downloads.map(d => d.url)];
  if (!review.screens.length || links.some(value => {
    try { const url = new URL(value); return url.protocol !== 'https:' || url.username || url.password; } catch { return true; }
  })) throw new Error('Review files require HTTPS links without embedded credentials');
  const captured = new Date(review.capturedAt), expires = new Date(review.expiresAt);
  if (!Number.isFinite(+captured) || !Number.isFinite(+expires) || expires <= captured) throw new Error('Invalid review date');
  const format = (date: Date) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC';
  const nonce = randomUUID();
  const origins = [...new Set(links.map(link => new URL(link).origin))].join(' ');
  const screens = JSON.stringify(review.screens).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${escape(origins)}; media-src ${escape(origins)}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
<title>${escape(review.title)} · Spindle review</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f8f7;color:#193439;font:16px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif}main{max-width:1100px;margin:36px auto;padding:0 24px}h1{font-size:clamp(25px,4vw,36px);line-height:1.2;margin:8px 0 12px}h2{font-size:19px;margin:0 0 10px}.brand{font-weight:750;color:#14766e}p{margin:10px 0}.capture-time,.hint{font-size:13px;color:#5d7470}.note{padding:12px 16px;border-left:4px solid #bd8a28;background:#fff2d4;margin:20px 0}.switcher{display:flex;gap:8px;flex-wrap:wrap;margin:22px 0 12px}button,a{font:inherit}button{cursor:pointer;min-height:44px;padding:9px 15px;border:1px solid #b4ccc4;border-radius:6px;color:inherit;background:white}button[aria-pressed=true]{color:white;background:#16776d;border-color:#16776d}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #38998e;outline-offset:3px}.stage{padding:14px;background:white;border:1px solid #d3e0da;border-radius:10px;text-align:center}.stage video,.stage img{display:block;max-width:100%;height:auto;margin:auto}.stage .phone{max-width:min(390px,100%)}a{color:#116c61;text-underline-offset:3px}.open-file{display:inline-flex;align-items:center;min-height:44px;font-size:13px}.download-box{padding:20px;background:white;border:1px solid #d3e0da;border-radius:10px;margin-top:24px}.downloads{display:flex;gap:10px;flex-wrap:wrap}.downloads a{display:inline-flex;align-items:center;min-height:44px;padding:8px 12px;border:1px solid #b4ccc4;border-radius:6px;text-decoration:none}details{margin:22px 0;border-top:1px solid #d3e0da;padding-top:8px}summary{cursor:pointer;min-height:44px;align-content:center}dl{display:grid;grid-template-columns:140px 1fr;gap:8px;font-size:13px}dt{color:#5d7470}dd{margin:0;overflow-wrap:anywhere}#media-error{color:#914300}[hidden]{display:none!important}@media(max-width:600px){main{margin:24px auto;padding:0 16px}.stage{padding:6px}.switcher button{flex:1}.downloads a{width:100%}dl{grid-template-columns:1fr}dd{margin-bottom:8px}}
</style></head><body><main>
<header><span class="brand">Spindle · Review</span><h1>${escape(review.title)}</h1><p>${escape(review.summary)}</p>
<p class="capture-time">Captured <time datetime="${captured.toISOString()}">${escape(format(captured))}</time> · Private link available until ${escape(format(expires))}</p></header>
<p class="note">${escape(review.caveat)}</p>
<div class="switcher" aria-label="Choose recording or screenshot">
<button type="button" data-view="recording" aria-pressed="true">Watch walkthrough</button>
${review.screens.map((screen, index) => `<button type="button" data-view="screen-${index}" aria-pressed="false">${escape(screen.label)}</button>`).join('')}
</div>
<div class="stage"><video id="recording" controls playsinline preload="metadata" aria-label="Walkthrough of the review screen"><source src="${escape(review.recording)}" type="video/mp4">${review.recordingFallback ? `<source src="${escape(review.recordingFallback)}" type="video/webm">` : ''}Your browser cannot play this recording.</video><img id="screen" alt="" hidden></div>
<p id="media-error" hidden>Couldn’t load the file. The private link may have expired; ask for a refreshed link on the PR.</p>
<a id="open-file" class="open-file" href="${escape(review.recording)}" target="_blank" rel="noopener noreferrer">Open recording separately</a>
<section class="download-box"><h2>Try it on your computer</h2><p>Choose your test build, extract it, and open <strong>Start Capture Check</strong>. It opens two sample windows; your other apps are not recorded.</p><div class="downloads">${review.downloads.map(item => `<a href="${escape(item.url)}" rel="noreferrer">${escape(item.label)}</a>`).join('')}</div><p class="hint">Mac: Apple Command Line Tools and Accessibility permission are needed. Windows: the reader is included; .NET Framework 4.8 is required (4.8.1 on ARM). Keep the feedback file before clearing a run.</p></section>
<details><summary>Technical details</summary><dl>
<dt>Captured app</dt><dd>${escape(review.codeVersion)}</dd><dt>Viewer</dt><dd>${escape(review.viewerVersion)}</dd>
<dt>Evidence</dt><dd>Saved sample-data walkthrough of the review screen on Linux. Not a live app or proof of Mac/Windows capture.</dd>
<dt>Test record</dt><dd><a href="${escape(review.recordUrl)}" target="_blank" rel="noopener noreferrer">Build, test results and file checksums</a></dd>
<dt>Access</dt><dd>Private, expiring file links. This page has no connection to your device or the running app.</dd>
</dl></details></main>
<script nonce="${nonce}">
const screens=${screens};
const video=document.querySelector('#recording');
const image=document.querySelector('#screen');
const error=document.querySelector('#media-error');
const original=document.querySelector('#open-file');
document.querySelector('.switcher').addEventListener('click',event=>{
 const button=event.target.closest('button[data-view]');if(!button)return;
 const isVideo=button.dataset.view==='recording';
 video.pause();video.hidden=!isVideo;image.hidden=isVideo;error.hidden=!(isVideo&&video.networkState===3);
 document.querySelectorAll('[data-view]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
 if(isVideo){original.href=video.currentSrc||video.querySelector('source').src;original.textContent='Open recording separately';}
 else{const screen=screens[Number(button.dataset.view.split('-')[1])];image.src=screen.url;image.alt=screen.label+' — saved review screen';image.className=screen.phone?'phone':'';original.href=screen.url;original.textContent='Open screenshot separately';}
});
video.addEventListener('loadedmetadata',()=>{if(!video.hidden){original.href=video.currentSrc;error.hidden=true;}});
const failedSources=new Set();
video.querySelectorAll('source').forEach(source=>source.addEventListener('error',()=>{failedSources.add(source);if(!video.hidden&&failedSources.size===video.querySelectorAll('source').length)error.hidden=false;}));
[video,image].forEach(media=>media.addEventListener('error',()=>{if(!media.hidden)error.hidden=false;}));
</script></body></html>`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(renderReviewPage(JSON.parse(readFileSync(0, 'utf8'))));
}
