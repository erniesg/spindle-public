// Styles for the approved focus-timer dial and its surrounding Lock-in composition. Browser-safe,
// no imports. Values come from the lock-in.css rules of the owner-approved export (SHA-256
// fde2f0fd…23224cf2) expressed only through the shared `--sp-*` tokens in core/ui/theme.ts: no colour,
// font or palette literal and no token override lives here. Scoped to `.pomodoro-view` so the
// legacy portal rules around it are unchanged. See docs/FOCUS_DIAL_UI.md.

/** Served at /portal/fonts.css. Binary files are staged locally and hash-checked, never in Git. */
export const focusDialFontFaceCss = [
  '@font-face{font-family:Instrument Serif;src:url(/portal/fonts/instrument.woff2) format(woff2);font-style:normal;font-weight:400;font-display:swap}',
  '@font-face{font-family:DM Sans;src:url(/portal/fonts/dm-sans-normal.woff2) format(woff2);font-style:normal;font-weight:100 900;font-display:swap}',
].join('\n') + '\n';

export const focusDialCss = `
.pomodoro-view{box-sizing:border-box;margin:var(--sp-space-4) 0;padding:var(--sp-space-8) var(--sp-space-6) var(--sp-space-6);border:var(--sp-line-width) solid var(--sp-line);border-radius:var(--sp-radius-md)}
.pomodoro-view :is(h2,p){margin:0}
.pomodoro-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--sp-space-4)}
.pomodoro-view .pomodoro-eyebrow,.pomodoro-view .fd-eyebrow{font:400 var(--sp-caption-size)/1.5 var(--sp-font);color:var(--sp-muted);letter-spacing:.07em;text-transform:uppercase}
.pomodoro-view .pomodoro-title{font:400 var(--sp-section-title)/1.2 var(--sp-display-font);letter-spacing:-.02em;margin-top:var(--sp-space-1)}
.pomodoro-view .pomodoro-connection{flex:none;padding:var(--sp-space-1) var(--sp-space-3);border-radius:var(--sp-radius-pill);font-weight:500}
.pomodoro-view .pomodoro-connection::before{margin-right:var(--sp-space-1)}
.pomodoro-account{margin-top:var(--sp-space-2)!important;font:400 var(--sp-caption-size)/1.6 var(--sp-font);color:var(--sp-muted)}
.pomodoro-view .fd-timer{display:block;margin:0;padding:var(--sp-space-5) 0 26px;background:none;border-radius:0;text-align:center}
.fd-clock{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;box-sizing:border-box;width:236px;height:236px;max-width:100%;margin:18px auto}
.fd-ring{position:absolute;inset:0;width:100%;height:100%;fill:none;stroke:var(--sp-line);stroke-width:.8;transform:rotate(-90deg);pointer-events:none}
.fd-ring .fd-progress{stroke:var(--sp-action);stroke-width:2;stroke-linecap:round}
.pomodoro-view .fd-time{display:block;font:400 62px/1.1 var(--sp-font);font-variant-numeric:tabular-nums;letter-spacing:-.045em;color:var(--sp-ink)}
.pomodoro-view .fd-phase{margin-top:9px;font:400 var(--sp-caption-size)/1.5 var(--sp-font);color:var(--sp-muted);text-transform:lowercase}
.pomodoro-view .pomodoro-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:var(--sp-space-5);margin:var(--sp-space-5) 0 0}
.pomodoro-actions .sp-button{min-height:44px;min-width:150px}
.pomodoro-view .pomodoro-timer-status{max-width:46ch;margin:var(--sp-space-4) auto 0;font:400 var(--sp-caption-size)/1.6 var(--sp-font);color:var(--sp-muted);text-align:center}
.pomodoro-view .pomodoro-error{margin-top:var(--sp-space-4)}
.pomodoro-view .pomodoro-error[hidden]{display:none}
.pomodoro-timing{margin:var(--sp-space-6) 0 0;border-top:var(--sp-line-width) solid var(--sp-line);border-bottom:var(--sp-line-width) solid var(--sp-line)}
.pomodoro-timing>summary{list-style:none;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) 14px;align-items:center;gap:var(--sp-space-4);min-height:60px;font:500 var(--sp-control-size)/1.5 var(--sp-font);cursor:pointer}
.pomodoro-timing>summary::-webkit-details-marker{display:none}
.pomodoro-timing>summary::after{content:'+';color:var(--sp-muted);font-size:20px;text-align:right}
.pomodoro-timing[open]>summary::after{content:'−'}
.pomodoro-timing>summary>span:nth-child(2){text-align:right;font-size:var(--sp-caption-size);font-weight:400;color:var(--sp-muted);overflow-wrap:anywhere}
.pomodoro-timing>summary:focus-visible{outline:var(--sp-focus-width) solid var(--sp-focus);outline-offset:3px}
.fd-presets{display:flex;flex-wrap:wrap;gap:var(--sp-space-2);margin:0 0 var(--sp-space-4)}
.fd-presets .sp-button[aria-pressed=true]{border-color:var(--sp-action);background:var(--sp-action-soft);color:var(--sp-action)}
.pomodoro-durations{display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-space-4);min-width:0;margin:0;padding:var(--sp-space-2) 0 var(--sp-space-5);border:0}
.pomodoro-durations .pomodoro-legend{grid-column:1/-1;padding:0;font:500 var(--sp-caption-size)/1.4 var(--sp-font);color:var(--sp-muted)}
.pomodoro-durations .pomodoro-duration-note{grid-column:1/-1;font:400 var(--sp-caption-size)/1.65 var(--sp-font);color:var(--sp-muted)}
.pomodoro-view .pomodoro-footer{border:0;padding:0;display:flex;align-items:center;justify-content:space-between;gap:var(--sp-space-4);flex-wrap:wrap;margin-top:var(--sp-space-5)}
.pomodoro-view .pomodoro-revision{font:400 var(--sp-caption-size)/1.5 var(--sp-font);color:var(--sp-muted)}
.pomodoro-view .pomodoro-privacy{margin-top:var(--sp-space-4);max-width:46ch;font:400 var(--sp-caption-size)/1.6 var(--sp-font);color:var(--sp-muted)}
.pomodoro-view [hidden]{display:none!important}
@media(max-width:680px){.pomodoro-view{padding:var(--sp-space-5) var(--sp-space-4)}.fd-clock{width:220px;height:220px}.pomodoro-view .fd-time{font-size:56px}.pomodoro-timing>summary{gap:10px;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr) 12px}.pomodoro-durations{grid-template-columns:1fr 1fr}.pomodoro-actions .sp-button{min-width:0;flex:1 1 140px}}
`.trim();
