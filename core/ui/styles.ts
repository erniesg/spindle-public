import {themeCss} from './theme.js';

// Primitive rules reference theme tokens only: no colour, font or palette literals here.
export const primitiveCss = `
.sp-theme{font:400 var(--sp-body-size)/1.5 var(--sp-font);color:var(--sp-ink);background:var(--sp-paper)}
.sp-theme :where(h1,h2,h3){font-weight:400;margin:0}
.sp-title{font:400 var(--sp-section-title)/1.2 var(--sp-display-font);letter-spacing:-.02em;margin:0}
.sp-muted{color:var(--sp-muted);font-size:var(--sp-caption-size);line-height:1.6;margin:0}
.sp-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-space-2)}
.sp-button{display:inline-flex;align-items:center;justify-content:center;gap:var(--sp-space-2);box-sizing:border-box;min-height:var(--sp-control-height);padding:var(--sp-space-2) 14px;border:var(--sp-line-width) solid var(--sp-line);border-radius:var(--sp-radius-sm);background:var(--sp-paper);color:var(--sp-ink);font:500 var(--sp-control-size)/1.35 var(--sp-font);cursor:pointer;transition:background-color var(--sp-duration-fast) var(--sp-ease),border-color var(--sp-duration-fast) var(--sp-ease),color var(--sp-duration-fast) var(--sp-ease)}
.sp-button:hover:enabled{border-color:var(--sp-border-hover);color:var(--sp-action)}
.sp-button:active:enabled{background:var(--sp-action-soft)}
.sp-button[data-variant=primary]{background:var(--sp-action);border-color:var(--sp-action);color:var(--sp-on-action)}
.sp-button[data-variant=primary]:hover:enabled{background:var(--sp-action-hover);border-color:var(--sp-action-hover);color:var(--sp-on-action)}
.sp-button[data-variant=primary]:active:enabled{background:var(--sp-action-pressed)}
.sp-button[data-variant=quiet]{background:transparent;border-color:transparent;color:var(--sp-muted)}
.sp-button:focus-visible{outline:var(--sp-focus-width) solid var(--sp-focus);outline-offset:2px}
.sp-button:disabled{opacity:var(--sp-disabled-opacity);cursor:not-allowed}
.sp-text-field{display:grid;gap:var(--sp-space-2);min-width:0}
.sp-label{font:500 var(--sp-caption-size)/1.4 var(--sp-font);color:var(--sp-ink)}
.sp-field{box-sizing:border-box;width:100%;min-height:var(--sp-control-height);padding:var(--sp-space-2) 11px;border:var(--sp-line-width) solid var(--sp-line);border-radius:var(--sp-radius-sm);background:var(--sp-paper);color:var(--sp-ink);font:400 var(--sp-control-size)/1.35 var(--sp-font)}
.sp-field:hover:enabled{border-color:var(--sp-border-hover)}
.sp-field:focus-visible{outline:var(--sp-focus-width) solid var(--sp-focus);outline-offset:2px}
.sp-field:disabled{background:var(--sp-surface);color:var(--sp-muted);cursor:not-allowed}
.sp-field[aria-invalid=true]{border-color:var(--sp-status-error-ink)}
.sp-hint{font:400 var(--sp-caption-size)/1.5 var(--sp-font);color:var(--sp-muted);margin:0}
.sp-card{display:grid;gap:var(--sp-space-4);box-sizing:border-box;min-width:0;padding:var(--sp-space-6);border:var(--sp-line-width) solid var(--sp-line);border-radius:var(--sp-radius-md);background:var(--sp-paper);color:var(--sp-ink)}
.sp-card>*{margin:0}
.sp-card-title{font:500 var(--sp-heading-size)/1.35 var(--sp-font)}
.sp-status{box-sizing:border-box;margin:0;padding:var(--sp-space-3) var(--sp-space-4);border-left:var(--sp-focus-width) solid var(--sp-status-neutral-line);background:var(--sp-status-neutral-surface);color:var(--sp-status-neutral-ink);font:400 var(--sp-caption-size)/1.6 var(--sp-font)}
.sp-status[data-state=idle]:empty{padding:0;border:0}
.sp-status[data-state=loading]{border-color:var(--sp-status-working-line);background:var(--sp-status-working-surface);color:var(--sp-status-working-ink)}
.sp-status[data-state=loading]::before{content:"";display:inline-block;width:.8em;height:.8em;margin-right:var(--sp-space-2);vertical-align:-.1em;border:var(--sp-focus-width) solid currentColor;border-right-color:transparent;border-radius:var(--sp-radius-pill);animation:sp-spin .9s linear infinite}
.sp-status[data-state=success]{border-color:var(--sp-status-success-line);background:var(--sp-status-success-surface);color:var(--sp-status-success-ink)}
.sp-status[data-state=error]{border-color:var(--sp-status-error-ink);background:var(--sp-status-error-surface);color:var(--sp-status-error-ink)}
@keyframes sp-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.sp-button{transition:none}.sp-status[data-state=loading]::before{animation:none}}
@media(pointer:coarse){.sp-button,.sp-field{min-height:44px}}
`.trim();

// The complete stylesheet every surface ships: theme tokens first, then primitives.
export const spindleUiCss = `${themeCss}\n${primitiveCss}\n`;
