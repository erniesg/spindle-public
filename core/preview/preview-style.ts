// Layout for the local desktop controls over the shared spindle-ui.css and the
// approved focus dial. Browser-safe string, tokens only: no colour, font or
// palette literal and no token override. Served at /preview.css.
export const previewCss = `
.px-page{box-sizing:border-box;max-width:1180px;margin:0 auto;padding:var(--sp-space-6) var(--sp-space-5) var(--sp-space-10)}
.px-header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:var(--sp-space-4);margin-bottom:var(--sp-space-6)}
.px-header>div{display:grid;gap:var(--sp-space-1)}
.px-eyebrow{margin:0;font:400 var(--sp-caption-size)/1.5 var(--sp-font);color:var(--sp-muted);letter-spacing:.07em;text-transform:uppercase}
.px-state{max-width:52ch}
.px-layout{display:grid;grid-template-columns:minmax(300px,420px) minmax(0,1fr);gap:var(--sp-space-6);align-items:start}
.px-timer{display:grid;gap:var(--sp-space-3)}
.px-controls{display:grid;gap:var(--sp-space-4);min-width:0}
.px-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:var(--sp-space-3)}
.px-narrow{max-width:240px}
.px-check{display:flex;align-items:flex-start;gap:var(--sp-space-2);font:400 var(--sp-control-size)/1.45 var(--sp-font)}
.px-check input{margin-top:.2em;accent-color:var(--sp-action)}
.px-balance{font:500 var(--sp-heading-size)/1.35 var(--sp-font);font-variant-numeric:tabular-nums}
.px-details{font:400 var(--sp-caption-size)/1.6 var(--sp-font);color:var(--sp-muted)}
.px-details>summary{cursor:pointer;color:var(--sp-ink);font:500 var(--sp-control-size)/1.5 var(--sp-font)}
.px-details>summary:focus-visible{outline:var(--sp-focus-width) solid var(--sp-focus);outline-offset:2px}
.px-details[open]{display:grid;gap:var(--sp-space-3)}
.px-details :is(p,h3){margin:0}
.px-advanced section{display:grid;gap:var(--sp-space-3);padding-top:var(--sp-space-3);border-top:var(--sp-line-width) solid var(--sp-line)}
.px-advanced h3{font:500 var(--sp-control-size)/1.4 var(--sp-font);color:var(--sp-ink)}
.px-page code{font-family:var(--sp-mono-font);background:var(--sp-surface);padding:0 var(--sp-space-1);border-radius:var(--sp-radius-sm)}
.px-page pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:400 var(--sp-caption-size)/1.6 var(--sp-mono-font);background:var(--sp-surface);padding:var(--sp-space-3);border-radius:var(--sp-radius-sm)}
.px-page pre:empty{display:none}
.px-page a{color:var(--sp-action);text-underline-offset:3px}
.px-page a.sp-button{text-decoration:none}
.px-page img{max-width:100%}
.px-visits{display:grid;gap:var(--sp-space-3)}
.px-visits article{display:grid;gap:var(--sp-space-2);padding:var(--sp-space-4);border:var(--sp-line-width) solid var(--sp-line);border-radius:var(--sp-radius-md);background:var(--sp-paper)}
.px-visits article :is(h2,p){margin:0}
.px-visits article h2{font:500 var(--sp-control-size)/1.4 var(--sp-font)}
.px-page [hidden]{display:none!important}
dialog.sp-card{max-width:520px}
dialog.sp-card:not([open]){display:none}
.px-timer .pomodoro-view header{display:grid;gap:var(--sp-space-1);text-align:center}
.px-timer .pomodoro-view header :is(p,h1){margin:0}
.px-timer .pomodoro-view header h1{font:400 var(--sp-section-title)/1.2 var(--sp-display-font);letter-spacing:-.02em}
.px-timer .pomodoro-view header p{font:400 var(--sp-caption-size)/1.5 var(--sp-font);color:var(--sp-muted)}
.px-timer .pomodoro-view header .eyebrow{letter-spacing:.07em;text-transform:uppercase}
.px-timer .pomodoro-view article{text-align:center}
.px-timer .pomodoro-view article>:is(.phase,.countdown){display:none}
.px-timer .pomodoro-view .timer-status{margin:0;font:400 var(--sp-caption-size)/1.6 var(--sp-font);color:var(--sp-muted)}
.px-timer .pomodoro-view .actions{display:flex;flex-wrap:wrap;justify-content:center;gap:var(--sp-space-3);margin-top:var(--sp-space-4)}
.px-timer .pomodoro-view :is(fieldset,form){display:grid;gap:var(--sp-space-3);margin:var(--sp-space-4) 0 0;padding:var(--sp-space-4);border:var(--sp-line-width) solid var(--sp-line);border-radius:var(--sp-radius-md)}
.px-timer .pomodoro-view legend{font:500 var(--sp-caption-size)/1.4 var(--sp-font);color:var(--sp-muted)}
.px-timer .pomodoro-view label{display:grid;gap:var(--sp-space-1);font:500 var(--sp-caption-size)/1.4 var(--sp-font)}
.px-timer .pomodoro-view label.check{display:flex;align-items:center}
.px-timer .pomodoro-view :is(.account,.revision,.duration-note){margin:0;font:400 var(--sp-caption-size)/1.6 var(--sp-font);color:var(--sp-muted);text-align:center}
.px-timer .pomodoro-view .connection{margin:var(--sp-space-3) 0 0}
.px-timer .pomodoro-view footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:var(--sp-space-2);margin-top:var(--sp-space-4)}
@media(max-width:900px){.px-layout{grid-template-columns:1fr}}
`.trim();
