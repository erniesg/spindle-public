/** Browser files for the approved Spindle app shell, served at /portal/web/<path> and staged by tools/build-assets.ts.
 * Vendored design/font files are pinned by SHA-256 (verified at build); Spindle-owned stylesheets are allowlisted only. */
export interface PortalWebFile {path:string;type:string;sha256?:string}
export const portalWebFiles:readonly PortalWebFile[]=[
 {path:'spindle.css',type:'text/css; charset=utf-8',sha256:'5883c68cdfcec7770056c5692f0d283b8f2f586fc7230970d7d8c98585cf8d26'},
 {path:'flowing-sand.svg',type:'image/svg+xml',sha256:'37b4cd2cd8e0d63d5c3dc76e55bc87441a80f5fa5b53c3960354a64b53527cce'},
 {path:'fonts/instrument.woff2',type:'font/woff2',sha256:'5eb09b5ac0e28b67c2f041c8ba6d244604ca0c0980d65912ab2d47fed84ddc31'},
 {path:'fonts/instrument-serif-italic.woff2',type:'font/woff2',sha256:'5a51946dfffa82972bc98745359c46761515641fda557c25116459a9f83da4a7'},
 {path:'fonts/dm-sans-normal.woff2',type:'font/woff2',sha256:'9fea608a947e67020c33cad9a6fe3d60c54119dfb8cff87768a8117a15ed7543'},
 {path:'fonts/dm-sans-OFL.txt',type:'text/plain; charset=utf-8',sha256:'9af36190332437f5ecd09974de43c1f7c77a310a996cdd8ceb25628b458840e1'},
 {path:'fonts/Instrument-Serif-OFL.txt',type:'text/plain; charset=utf-8',sha256:'b6b2292aa580937fb63796878d65a027a27f8c3db2d97601d0c34d9031f4ca17'},
 {path:'fonts.css',type:'text/css; charset=utf-8'},
 {path:'palette.css',type:'text/css; charset=utf-8'},
 {path:'portal.css',type:'text/css; charset=utf-8'},
];
/** Compiled files (relative to build/core) whose bytes make up the displayed portal UI fingerprint (build.json bundleSha256). */
export const portalBundleModules:readonly string[]=['account/portal/app.js','account/portal/tracking.js','account/portal/pomodoro.js','account/portal/blocking.js','account/portal/application.js','account/portal/page.js','account/client.js','pomodoro/client.js','pomodoro/protocol.js','pomodoro/focus-dial.js','pomodoro/focus-dial-style.js','account/portal/assets.js','ui/theme.js','ui/styles.js','ui/dom.js','ui/life-dial.js','ui/life-dial-geometry.js','ui/life-dial-style.js','account/portal/web-manifest.js','account/portal/brand.js','account/portal/ui.js','account/portal/context.js','account/portal/prep.js','account/portal/today.js','account/portal/review.js','account/portal/connections.js','account/portal/settings.js','account/portal/lock-in.js','account/portal/attention.js'];
