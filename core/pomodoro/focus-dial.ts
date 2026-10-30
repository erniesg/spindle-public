// Approved focus-timer dial: the Lock-in ring and central time from the owner-approved
// export (ui/prototype dist/lock-in.js `.li-clock`, SHA-256 3375ae08…0de7). Browser-safe and
// pure: it builds elements on the document it is given and paints values it is handed. It owns
// no timer, clock, storage, network or navigation; the caller passes the existing
// PomodoroClient's remaining time and the actual phase duration. See docs/FOCUS_DIAL_UI.md.
//
// NOT the landing life-dial (dist/life-dial.js is an age / life-in-weeks canvas).

/** Ring geometry copied from lock-in.js: viewBox 300, centre 150, radius 141, pathLength 1. */
export const DIAL = Object.freeze({viewBox: 300, centre: 150, radius: 141, pathLength: 1});
const SVG_NS = 'http://www.w3.org/2000/svg';

export type DialPhase = 'focus' | 'break';
export type DialStatus = 'idle' | 'running' | 'paused' | 'completed';
export interface DialModel {
  phase?: DialPhase;
  status?: DialStatus;
  /** Milliseconds left in the current phase, from the existing timer client. Undefined = not loaded. */
  remainingMs?: number;
  /** Full length of the current phase, from the snapshot's actual durations. */
  totalMs?: number;
}
type DialDocument = Pick<Document, 'createElement'> & Partial<Pick<Document, 'createElementNS'>>;
export interface FocusDial {
  /** The `.pomodoro-clock` block: state label, ring, central time and phase word. */
  root: HTMLElement;
  update(model: DialModel): void;
}

/** MM:SS rounded up, as lock-in.js `clock()`. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

/**
 * Progress arc offset on a pathLength-1 circle, as lock-in.js (`remaining / duration`): 1 draws
 * nothing at the start and 0 closes the ring. An unknown or invalid length draws nothing, never a guess.
 */
export function dialOffset(remainingMs: number | undefined, totalMs: number | undefined): number {
  if (remainingMs === undefined || totalMs === undefined || !(totalMs > 0) || !Number.isFinite(remainingMs)) return 1;
  return Math.min(1, Math.max(0, remainingMs / totalMs));
}

/** Short state label above the ring. Wording follows lock-in.js; a finished phase is shown as waiting. */
export function stateLabel(model: DialModel): string {
  if (model.status === undefined) return 'Timer not loaded';
  if (model.status === 'completed') return 'Phase complete';
  if (model.status === 'paused') return 'Paused';
  if (model.status === 'idle') return 'Ready when you are';
  return model.phase === 'break' ? 'Take a breather' : 'In focus';
}

export function createFocusDial(doc: DialDocument): FocusDial {
  const html = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  // SVG elements expose className as read-only, so classes go through setAttribute.
  const svg = (tag: string, attributes: Record<string, string>) => {
    const node = (doc.createElementNS ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag as 'div')) as Element;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  };
  const circle = {cx: String(DIAL.centre), cy: String(DIAL.centre), r: String(DIAL.radius)};
  const ring = svg('svg', {class: 'fd-ring', viewBox: `0 0 ${DIAL.viewBox} ${DIAL.viewBox}`, 'aria-hidden': 'true'});
  const track = svg('circle', circle);
  const progress = svg('circle', {...circle, class: 'fd-progress', pathLength: String(DIAL.pathLength), 'stroke-dasharray': String(DIAL.pathLength), 'stroke-dashoffset': '1'});
  ring.append(track, progress);
  const face = html('div', 'fd-clock');
  const countdown = html('output', 'pomodoro-countdown fd-time');
  countdown.setAttribute('role', 'timer');
  countdown.setAttribute('aria-label', 'Remaining time');
  const phase = html('span', 'pomodoro-phase fd-phase');
  face.append(ring, countdown, phase);
  const label = html('p', 'fd-eyebrow');
  const root = html('div', 'pomodoro-clock fd-timer');
  root.append(label, face);
  return {
    root,
    update(model) {
      label.textContent = stateLabel(model);
      phase.textContent = model.phase === 'break' ? 'Break' : 'Focus';
      countdown.textContent = model.remainingMs === undefined ? '—' : formatClock(model.remainingMs);
      progress.setAttribute('stroke-dashoffset', dialOffset(model.remainingMs, model.totalMs).toFixed(4));
    },
  };
}
