# Study → earned leisure

The device bridge is integrated source, not installed enforcement or real-study acceptance. [#78](https://github.com/erniesg/spindle/issues/78) and [#143](https://github.com/erniesg/spindle/pull/143) own current source-bound proof and remaining acceptance; synthetic-history API checks do not establish genuine study or browser enforcement. The account routes exist in `core/tracking/server.ts`. The
desktop app proxies them through `TrackingClient.earnedLeisure` and
[`core/preview/earned-control.ts`](../core/preview/earned-control.ts). The Chrome blocking
page ([`browser-extension/blocking/earned.ts`](../browser-extension/blocking/earned.ts))
spends earned time as the existing lease pause. Evidence so far: Linux Chromium with the
production worker and Native Messaging host, plus the account server. That is not native
capture or installed acceptance.

### Device bridge (desktop app ↔ Chrome)

- **Grant.** The local page has a checkbox: “Let this paired Chrome profile use earned
  leisure”. It is off by default and kept in memory only. It is separate from timer access,
  and pairing alone grants nothing. It ends on re-pair, revoke, account or client change,
  timer sign-in or sign-out, store invalidation, or app quit.
- **Extension IPC kind `earned`.** It has its own Native Messaging slot and a 4 KiB
  message bound. It allows exactly `read`, `redeem {requestId, host, policyVersion, seconds}`
  and `status {requestId}`. The client always inserts this host's own `deviceId`, validates
  account/device bindings, then projects only requestId, host, policyVersion, seconds,
  issuedAt and expiresAt for a lease. Replies contain no stable
  account/device identifiers, cookies, CSRF tokens or device secrets.
  One request runs at a time under the existing control owner, and identity is checked
  again after every await. A late reply after retirement is `EARNED_RESPONSE_RETIRED`.
- **Local routes.** `POST /earned/read`, `/earned/opt-in {enabled}` and
  `/earned/access {enabled}` require the bearer token, exact Origin and JSON.
- **Uncertain local actions.** Lost opt-in/out or access replies remain unknown until
  an authoritative balance or access readback. The page never claims rollback or
  retries the mutation automatically; idle polling reconciles access in both directions.
- **Chrome page.** It reads the balance and the current `blocking-status` host and version.
  It redeems with a fresh UUID and sends `leasePauseMessage(lease)`. It reports *applied*
  only when `leaseStatus` on worker readback says so. After an uncertain reply it reads
  back the **same** `requestId` (`status`); not found means not debited. It never redeems
  again and never refunds. Manual pause stays separate and is labelled voluntary.

This is an opt-in rule. Observed time that the user has labelled as learning
earns the same number of seconds of leisure. The user spends that leisure as an
existing timed whole-site pause ([BLOCKING_PAUSE.md](BLOCKING_PAUSE.md)). It adds
no policy store, database, timer, DNR rule, Chrome permission or backend clock.

- Ledger: [`core/blocking/earned-time.ts`](../core/blocking/earned-time.ts). It is
  made of pure functions. It is safe to run in a browser because its imports are
  types only.
- Enforcement: the optional `lease` on the existing `site-pause` message in
  [`browser-extension/blocking/worker.ts`](../browser-extension/blocking/worker.ts).
- Tests: [`tests/blocking/earned-time.test.ts`](../tests/blocking/earned-time.test.ts).

## The chosen policy (reversible defaults)

| Rule | Value |
| --- | --- |
| Rate | 1 eligible learning second → 1 leisure second (`CREDIT_RATIO`) |
| Window | Credits and spends both roll off after 24 h (`WINDOW_MS`) |
| Lease size | 30–1800 whole seconds, the same as the existing pause bounds |
| Opt-in | Off by default. Turning it on starts at server `now`, so earlier time does not count. Turning it off drops unspent credit. |
| Refunds | None. Deletions and corrections only reduce future balance. The balance never goes negative. |

**What counts.** A visit from `projectSession(accountId, …)` counts only if all
of these hold:

- Its label is owned by that account.
- The label's `source` is `override` (the user's exact correction) or `rule`.
- The category is `learning`.
- Coverage is `observed`, the device is available, and the visit is awake,
  unlocked and has no clock conflict.

**What never counts.** Model inference, confidence values, abstention, unknown
or partial coverage, Pomodoro completion, and window titles on their own.

This is **self-labelled observed time**. It does not show verified learning or
attention, and `earnedBalance().basis` says so.

**No double credit.** Credits are keyed by history `recordKey`
(device/recording/visit). A replay or a new revision replaces that key's
credit. An older revision is ignored. The balance is the length of the union of
all credited intervals, so time that overlaps on two devices or in two visits
counts once. A visit whose label can no longer be seen (its context has
expired) keeps the credit it already has but cannot gain more. A deletion
tombstone, or a correction away from learning, removes that key's credit.

## Host integration contract (coordinator60)

**State.** Add one optional field, `earnedLeisure?: EarnedLeisureState`, to the
existing encrypted account record, next to `labels` and `pomodoro`. Read it with
`validateEarnedLeisure(value, account.id)`. This throws on corrupt or foreign
state, and the host must then refuse. It must never reset the state, because a
reset would forget spends. Use `emptyEarnedLeisure(account.id)` only when the
field is absent.

**Each step below is one pure transition inside the account's existing FIFO
transaction.** Inject the server's `now`, and make no network calls inside the
transaction.

1. **Opt-in or opt-out:** `setEarnedOptIn(state, enabled, now)`. This needs an
   explicit choice by the owner.
2. **Settle:** take `range = settlementRange(state, now)`. Then call
   `projectSession(account.id, liveEntries, account.labels, range.from, range.to).visits`
   and pass the result, plus the tombstone keys, to
   `settleEarnedCredits(state, {visits, deletedKeys, now})`. Work page by page,
   with at most 512 visits per projection. Settle before reading a balance.
3. **Balance:** `earnedBalance(state, now)` returns
   `{earnedSeconds, spentSeconds, availableSeconds, basis}`.
4. **Redeem:** `redeemEarnedLeisure(state, {requestId, deviceId, host, policyVersion, seconds}, now)`
   returns `{state, lease, replayed}`. Persist the new state before you return
   the lease. Rules:
   - `requestId` is a caller UUID.
   - `deviceId` is the authenticated device. `host` and `policyVersion` come
     from the profile's current `blocking-status`.
   - Sending the same `requestId` again returns the same lease and does not
     debit again.
   - Sending the same `requestId` with a different body fails with
     `EARNED_REQUEST_CONFLICT`.
   - Other errors are `EARNED_OPT_IN_REQUIRED`, `EARNED_TIME_INSUFFICIENT` and
     `EARNED_REQUEST_INVALID`.
5. **Deliver** the lease over the current profile-bound native IPC to the
   extension page. That page sends `leasePauseMessage(lease)`:
   `{type:'site-pause', version, seconds, lease:{id, host, until}}`.

   The worker keeps all of the existing pause checks: version compare-and-set,
   30–1800 s, the alarm is armed before the journal, and it fails closed on
   restart, overdue time or a failed save. It also does three new things:
   - It refuses an expired lease, or one whose host does not match.
   - It sets `pausedUntil = min(now + seconds, until)`, so a late delivery
     shortens the pause and never extends it.
   - It writes `earnedLease: id` into the paused `sitePolicy`. Resume and expiry
     remove that field.
6. **If the reply is uncertain,** read back `blocking-status` and use
   `leaseStatus(lease, status.sitePolicy, now)`. It returns one of:
   - `applied`: a committed policy matches the lease and host, with an integer
     live pausedUntil no later than the lease expiry.
   - `pending`: recovery is incomplete; show unknown and read back this lease,
     without sending another pause or debit.
   - `unapplied`: you may send the *same* message again. Version
     compare-and-set keeps it single-use.
   - `superseded` or `expired`: stop. Do not debit again and do not refund.

A manual `site-pause` with no `lease` behaves exactly as it does today. Earned
leisure does not gate manual pause. Whether it should is a product decision for
the host.

## Remaining before this is active

- Account service: the persisted field and the routes for opt-in, balance and
  redeem (coordinator60).
- Native bridge or extension page: deliver the lease and show the balance, the
  opt-in, and the plain policy text above.
- An actual demo on the installed path, recorded with invented activity only.
