import type { CheckState } from './types.js';
const $ = (id: string) => { const element = document.getElementById(id); if (!element) throw new Error('MISSING_UI_ELEMENT'); return element; };
const button = (id: string) => { const element = $(id); if (!(element instanceof HTMLButtonElement)) throw new Error('MISSING_BUTTON'); return element; };
const dialog = $('feedback-dialog');
const preview = $('feedback-preview');
if (!(dialog instanceof HTMLDialogElement) || !(preview instanceof HTMLTextAreaElement)) throw new Error('MISSING_FEEDBACK_UI');
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
let selected: string | null = null, state: CheckState | null = null;
let selectedSample = -1, stopped = false, busy = false, exportText = '';
const explanations: Record<string, string> = {
  STARTING: 'The native reader is starting. The Windows review ZIP includes the compiled reader.',
  OK: 'Run the test, wait about 11 seconds, then return here. Check that A → B → A → B are separate visits and their text updates match the right window.',
  MAC_ACCESSIBILITY_REQUIRED: 'Click Allow Accessibility. In System Settings → Privacy & Security → Accessibility, enable the app/terminal macOS identifies for this runner. Then return here; permission is checked again automatically. If it still is not ready, quit and reopen the launcher once. No Screen Recording permission is requested.',
  MAC_TOOLS_REQUIRED: 'This first Mac source runner needs Apple Command Line Tools. If you choose to install them, run xcode-select --install in Terminal, then reopen the launcher. No tools were installed automatically.',
  MAC_BUILD_FAILED: 'The Mac native reader did not build. Run Start Capture Check.command in Terminal and check that Apple Command Line Tools are installed. Send the content-free build failure feedback, not raw compiler logs with private paths.',
  WINDOWS_HELPER_MISSING: 'The Windows reader is missing. Use the complete extracted review ZIP, not a source ZIP. Developers can build the reader using the command in docs/TRY_CAPTURE.md; users do not need an SDK.',
  HELPER_EXITED: 'The native reader stopped. Quit and relaunch the same package once. Windows requires the OS-provided .NET Framework 4.8 runtime (4.8.1 on ARM); if unavailable or policy blocks execution, send the feedback/build ID rather than changing system policy.',
  NATIVE_UNAVAILABLE: 'This is not a native test host. The Mac/Windows reader cannot run here. UI/replay tests do not count as capture evidence.',
  MAC_COVERAGE_GAP: 'The Mac reader was delayed for over one second. Recording stopped at its last observed boundary; later switches/text may be missing. Save feedback, then start a fresh test. Missing time is not counted as continuous activity.',
  WINDOWS_COVERAGE_GAP: 'The Windows reader was delayed for over one second. Recording stopped at its last reliable observation; later switches/text may be missing. Save feedback, then start a fresh test. Missing time is not counted as continuous activity.',
  FIXTURE_FAILED: 'A test window closed or Windows/macOS refused a focus change. Clear, then run once more without clicking other apps during the automatic sequence. Send feedback if it repeats.',
  CANCELLED: 'The pending start was cancelled; no new recording was started.',
};
async function request(path: string, body?: Record<string, never>) {
  const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.code || 'HELPER_EXITED');
  return result;
}
function message(code: string) { $('message').textContent = explanations[code] || 'The local request failed. Quit/relaunch and send the feedback file if it repeats.'; }
function draw() {
  if (!state) return;
  const { stage, visits, counts } = state;
  $('status').textContent = state.recording ? `Recording · ${state.sequence}` : stage.helper === 'ready' ? 'Paused · text stays local' : stage.helper === 'failed' ? 'Native reader unavailable' : 'Starting native reader…';
  $('environment').textContent = state.platform === 'linux' ? 'LINUX / UI DEVELOPMENT ONLY — this is not a native capture demonstration.' : 'Experimental native accessibility check · local memory only · not yet accepted on this machine';
  $('build').textContent = `Build ${state.build} · ${state.platform} · ${state.sourceCommit}`;
  $('visits').textContent = String(visits.length);
  $('readable').textContent = String(visits.filter(v => v.samples.length).length);
  $('updates').textContent = String(counts.textUpdates);
  $('rejected').textContent = String(counts.rejected);
  $('permission').hidden = !(state.platform === 'darwin' && stage.helper === 'ready' && stage.permission !== true);
  for (const id of ['normal', 'fast', 'manual']) button(id).disabled = busy || stage.helper !== 'ready' || stage.permission !== true;
  $('help').textContent = explanations[stage.code] || explanations.HELPER_EXITED;
  const list = $('visit-list');
  list.replaceChildren();
  if (!visits.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Nothing recorded yet. Start a test above.'; list.append(empty); }
  if (!visits.some(v => v.id === selected)) { selected = visits.at(-1)?.id ?? null; selectedSample = -1; }
  for (const visit of visits.slice(-40).reverse()) {
    const button = document.createElement('button');
    button.className = `visit${visit.id === selected ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', String(visit.id === selected));
    const name = document.createElement('span'); name.textContent = visit.title || 'Untitled fixture window';
    const sub = document.createElement('small'); sub.textContent = visit.samples.length ? `${visit.samples.length} recent text snapshot(s)` : 'Text unavailable for this visit'; name.append(sub);
    const duration = document.createElement('span'); duration.textContent = `${(Math.max(0, (visit.end ?? state.nativeNow) - visit.start) / 1000).toFixed(2)}s`;
    button.append(name, duration);
    button.addEventListener('click', () => { selected = visit.id; selectedSample = -1; draw(); }); list.append(button);
  }
  const visit = visits.find(v => v.id === selected);
  $('selected-title').textContent = visit?.title || 'Inspect a visit';
  $('selected-info').textContent = visit ? `Visit ${visits.indexOf(visit) + 1} · ${visit.end === null ? 'active' : 'closed'} · native accessibility text, not OCR` : 'Select a visit to see its captured native text.';
  $('samples').replaceChildren();
  for (const [index, sample] of (visit?.samples ?? []).entries()) {
    const button = document.createElement('button'); const latest = index === (visit?.samples.length ?? 0) - 1;
    button.textContent = `${latest ? 'Latest' : 'Earlier'} · +${((sample.at - (visit?.start ?? 0)) / 1000).toFixed(2)}s`;
    button.addEventListener('click', () => { selectedSample = latest ? -1 : index; draw(); }); $('samples').append(button);
  }
  const sample = selectedSample < 0 ? visit?.samples.at(-1) : visit?.samples[selectedSample];
  $('content').textContent = sample?.text || (visit ? 'No readable native text was returned for this visit. It is not filled with text from another window.' : 'Start a test to inspect real native text from the supplied windows.');
}
async function poll() {
  if (stopped) return;
  try { state = await request('state'); draw(); }
  catch { $('status').textContent = 'Runner disconnected'; $('help').textContent = 'The local runner stopped or this tab has no session token. Relaunch using the supplied launcher; do not send the local URL/token.'; }
}
for (const action of ['normal', 'fast', 'manual', 'pause', 'clear', 'permission', 'quit']) {
  $(action).addEventListener('click', async () => {
    busy = true; draw(); $('message').textContent = 'Working locally…';
    try {
      await request(action, {});
      $('message').textContent = ['normal', 'fast', 'manual'].includes(action) ? 'Test started. Switch between the A and B windows, then return here.' : '';
      if (action === 'quit') { stopped = true; clearInterval(interval); $('status').textContent = 'Quit · cleared'; $('visit-list').replaceChildren(); $('content').textContent = 'Capture stopped. Local text cleared. You can close this tab.'; state = null; }
    } catch (error) { message(error instanceof Error ? error.message : 'HELPER_EXITED'); }
    finally { busy = false; if (!stopped) await poll(); }
  });
}
$('feedback').addEventListener('click', async () => {
  try { exportText = JSON.stringify(await request('feedback'), null, 2) + '\n'; preview.value = exportText; dialog.showModal(); }
  catch (error) { message(error instanceof Error ? error.message : 'HELPER_EXITED'); }
});
$('close-feedback').addEventListener('click', () => dialog.close());
$('save-feedback').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([exportText], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `spindle-feedback-${state?.platform || 'unknown'}-${(state?.build || 'dev').slice(0, 12)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
const interval = setInterval(poll, 750);
await poll();
