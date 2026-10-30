# Explicit pause and resume for whole-site blocking

Pause is a transition on the existing `sitePolicy` journal in
`chrome.storage.local` ([SITE_BLOCKING.md](SITE_BLOCKING.md)). It adds no policy
store, timer, history or second key. The capture listener already ignores changes
to `sitePolicy` and `sitePolicyRevision`. It uses no model, native host,
enrollment or account. Whole-site blocking (dynamic DNR rule 78001 plus the
registered guard) works with local controls alone. Pause works the same way.

## Behaviour

- **Pause** (`site-pause {version, seconds}`; 30–1800 whole seconds): `version`
  must equal the committed policy version (compare-and-set). Pause is refused while
  a change is pending or the policy is already paused. A pause is never extended
  silently. The browser alarm `blocking-pause` is armed at the deadline **before**
  the journal write. If it is refused, nothing changes. The pending journal entry
  holds the same host, scope and purpose, a new version and `pausedUntil` (epoch ms).
  Recovery revokes resource exceptions, stops guards and removes rule 78001, then
  commits.
- **Resume** (`site-resume {version}`), **expiry** (alarm), **startup** and
  **status** all lead to one place. If the deadline has passed, they journal the
  same policy without `pausedUntil`. The existing apply path then registers the
  guard, adds the DNR rule, reloads matching tabs and commits. Resuming an active
  policy does nothing, so a retried resume is safe. An early alarm or a worker restart re-arms the
  **original** deadline. It never extends or restarts the pause. If the browser
  was closed past the deadline, startup resumes the block.
- **Failed final save**: if the commit after rule removal fails, the record stays
  `pending` with enforcement lifted. The deadline alarm armed before the journal
  still binds it in the same live worker: at or after the deadline, the alarm,
  status and an overdue `resource-check` run the startup recovery, which applies
  the block. An early wakeup re-arms the original deadline. Without site access
  the record stays `pending` (no Active claim, no silent regain) until the user
  enables or removes the block.
- **Fails closed**: a pause more than 1800 s in the future after a clock change
  is resumed at once. A pending pause recovered after its deadline applies the
  block instead. If re-arming fails at startup, the block resumes. A paused policy
  refuses resource exceptions.
- **Wall-clock limit**: the deadline is wall-clock epoch ms, and there is no
  monotonic guarantee. Moving the clock back by up to 30 minutes is still within
  the bound, so the pause lasts longer in real time (for example, a 60 s pause
  then a 25-minute move back leaves 26 minutes). Each such move can extend it
  again, up to 1800 s from that move. Moves beyond the bound fail closed.
- **No silent regain of access**: resume uses the existing host-permission check.
  If site access was revoked during a pause, resume stays `pending` ("Policy change
  incomplete"). The user can enable the block again (with a permission prompt from
  that click) or remove it.
- **Remove / capture clear / replacement** end a pause and clear its alarm. A stale
  alarm only re-reads the policy and cannot bring one back.
- **Unsupported**: if `chrome.alarms.create` is missing, status reports
  `pause.supported:false` and pause is refused with blocking unchanged. The
  manifest already declares `alarms`, so no manifest change is needed.
- `resource-check` replies `{active:false}` during a live pause, so guards stop. It
  replies gated after the deadline while the resume runs.

## Status for a relay

`blocking-status` (and successful pause/resume) replies:

```ts
{ ok: true, sitePolicy, absenceVerified,
  state: 'none'|'active'|'paused'|'pending'|'cleanup_incomplete',
  pause: { supported: boolean, minSeconds: 30, maxSeconds: 1800 } }
```

Read `state` first. A `pending` record keeps the last committed policy at the top
level beside `pending`, so `sitePolicy.pausedUntil` can be present while `state`
is `pending` (for example, a resume whose save is incomplete). A relay must derive
`pausedUntil` only when `state === 'paused'` and otherwise report it as null. A
failed expiry that leaves a `pending` journal is reported as `ok:true` with
`state:'pending'`. Other status failures reply `ok:false`. A compare-and-set
(CAS) mismatch replies `{ok:false, error, ...snapshot}` so that a relay can return
HTTP 409 with the current state.

## What remains for the coordinator

Messages are accepted only from the extension's own `blocking.html`
(`sender.url === runtime.getURL('blocking.html')`). There is no
`externally_connectable` entry, web-origin bridge or new host permission. The
portal contract in [PORTAL_BLOCKING.md](PORTAL_BLOCKING.md) therefore needs a
reviewed relay, owned by the coordinator. It must:

1. map `/blocking/pause {expectedRevision, minutes}` to
   `site-pause {version: expectedRevision, seconds: minutes*60}`, and
   `/blocking/resume` to `site-resume`;
2. map `state`/`pausedUntil` (epoch ms → ISO, only when `state === 'paused'`) to
   `BlockingSnapshot.policy`.
   `appliedAt`/`observedAt` must come from the relay's own confirmation time, not
   the request;
3. return `site_access_required` when an operation fails on site permission, since
   access can only be granted by a click on an extension page;
4. never return `ready` without a connected, enrolled extension.

No manifest, native protocol, account API or portal module was changed here.

## Evidence

`tests/blocking/portal-pause.test.ts` runs the production worker bytes with a
fake browser and a controllable clock. It also runs the controls with a fake DOM.
This is a pure journal/DNR/alarm fixture, not Chrome, installed, native or Mac/Windows evidence.
Mutation checks were run on the built worker: removing the clock-change bound, resuming
on an early alarm, dropping the alarm armed before the journal, and ignoring pause
in `resource-check`. Each made the targeted cases fail. The failed-final-save case
was red on the unrepaired worker. Dropping the overdue pending recovery, the
early re-arm, the `resource-check` trigger, or the status `pending` reply each
makes it fail. The controls case is red on controls that keep the previous
render's buttons after an unknown-state reply.

### Real-extension scenario (not run; for coordinator selection)

Use a fresh disposable Chromium profile, the built unpacked preview extension and
a local invented host `pause.test` mapped to a loopback fixture server. The run
takes about 60 s:

1. On extension options → site blocking, enable a block for `pause.test` and
   approve the single permission prompt. Assert that the server sees no main-frame
   request.
2. Send `site-pause {version, seconds:30}` from the controls page. The 1-minute
   UI choice also works but takes longer. Navigate and assert that the server
   receives the request.
3. Without the controls page open, wait for the deadline. Navigate and assert that
   the request is blocked again, and that status is `active` with a new version.
4. Pause again and stop the worker (e.g. through `chrome://serviceworker-internals`).
   Assert that `pausedUntil` is unchanged after wake-up. Click **Resume block now**
   and assert that navigation is blocked.
5. **Remove block / recover access**, then assert that navigation is allowed and
   no `blocking-pause` alarm remains.

Record the run and log server requests as the evidence. Linux/Xvfb results are not
Mac or Windows installed acceptance.
