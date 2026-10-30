# Public developer preview: runbook and abuse bounds

This is the runbook for the public origin `https://spindle.berlayar.ai`. It supersedes the private test routes for the public default. The 43166/43167 routes in [WORKOS_SIGNIN.md](WORKOS_SIGNIN.md), [MAC_DESKTOP_SHELL.md](MAC_DESKTOP_SHELL.md), [MAC_WORKSPACE_RUNTIME_HANDOFF.md](MAC_WORKSPACE_RUNTIME_HANDOFF.md) and [MAC_TEST_INSTALL.txt](MAC_TEST_INSTALL.txt) remain the scope of the historical private tests only.

## Production adapter (what users actually get)

- **Desktop workspace.** The Mac app opens `https://spindle.berlayar.ai/portal` in the **system browser** (`NSWorkspace.open`). AuthKit and Spindle cookies therefore live in that browser.
- **Native window.** The app's own window keeps only capture and the timer.
- **No developer tooling for end users.** Users need no SSH forward, repository checkout, Command Line Tools or Python.
- **The 135 recovery proof does not carry over.** The in-app WKWebView workspace recovery in 135 (link replay, `workspaceUnavailable`, response-status cancel) is unreachable here because `wantsWorkspace` is never set. Its Mac proof therefore does not apply. Fresh Mac proof of the system-browser workspace and of native WorkOS against the public origin is **pending**.
- **Known gap.** `ownsWorkspace` still allows in-app navigation to the public origin. There is no script bridge, but this behaviour is not separately proven.

## Capacity (initial developer preview only)

- At most 100 accounts and a 32 MB encrypted store.
- At most 500 live sessions (12 h each). Exceeding a limit returns a transparent `507`/`503` (`ACCOUNT_BOUND`, `SESSION_BOUND`).
- This is not unlimited SaaS. Account registration has no invite list or hidden reservation. Paid preparation has the temporary, explicit operator-owned pilot boundary below; registration is not paid-processing authority.
- Remaining residual risk: many distinct clients can still fill the shared account and session caps.

## Trusted edge contract (`PublicProxyConfig`, optional final argument)

`startTrackingServer(..., classificationConfig, publicProxy)` takes `publicProxy` as its **10th** argument. `startPreparationAccount({... publicProxy})` forwards it unchanged. The config is `{token}`, where `token` is exactly 64 lowercase hex characters and private. Without `publicOrigin` the server refuses to start (`PUBLIC_PROXY_REQUIRES_PUBLIC_ORIGIN`). Any other shape fails with `PUBLIC_PROXY_CONFIG_INVALID`.

The edge (Worker; implementation owned by infra 62) must do this on **every** request:

1. Strip any client-supplied `X-Spindle-Proxy-Token` and `X-Spindle-Client`.
2. Set `X-Spindle-Proxy-Token: <token>`.
3. Set `X-Spindle-Client: <64 lowercase hex HMAC-SHA256(edge secret, real client IP)>`. The HMAC key stays at the edge.
4. Pass `Host: spindle.berlayar.ai`, `Origin` and `Cookie` through unchanged. Use TLS only, no CORS and no wildcard. The listener stays on loopback `127.0.0.1:43180`.

Node checks the token in constant time before it trusts the client tag. A missing or wrong token, or a missing or malformed tag (including repeated headers), gets `403 PROXY_DENIED` on every route, `/portal` and the WorkOS callback included. Node never reads `CF-*`, `X-Forwarded-*`, `Forwarded` or `Origin` as client identity, and it never logs the IP, tag or token. Exact Host and Origin, CSRF and `Secure` cookies are unchanged.

When the config is present, these limits apply per verified client tag:

| Route | Per-client limit | Shared caps kept |
|---|---|---|
| `POST /register`, `POST /signin`, `POST /auth/workos/native` | 20 per rolling minute → `429 AUTH_BUSY` | one scrypt at a time (AuthBusy), 8 in flight, 16 connections |
| `GET /auth/workos/begin` | 4 per rolling 5 minutes → `429 AUTH_BUSY` (checked before the handler) | 64 pending PKCE attempts with a 5-minute TTL |

- The callback is still authorised only by its state and browser binding. The IP is never used for authorisation.
- The per-client tables expire entries and hold at most 4096 clients. When full, the table denies new clients rather than growing.

**Without the config,** behaviour is unchanged. All requests share the single global 20/min window and the proxy headers are ignored. The public baseline **must** run with the config.

> Entrypoint gap: `core/tracking/run.ts` (the plain CLI) does not forward this argument. Run the public baseline through `startPreparationAccount` with `publicProxy`, or forward it in `run.ts` after review.

## Temporary public paid-preparation gate (local preparation, not activation)

`PreparationAccountConfig.publicPaidAccess` is trusted executable host configuration, not an HTTP field. Its exported `PublicPaidAccess` type is:

```ts
{mode: 'connection-only'}
// OR, only after separate owner activation/one-paid-pilot GO:
{mode: 'owned-pilot', accountId: '<exact verified authenticated account UUID>',
 scopeId: '<stable operator-owned pilot scope>'}
```

A concrete **invented, inactive** configuration fragment for the closed stage is:

```js
publicOrigin: 'https://spindle.berlayar.ai',
publicProxy: {token: proxyToken}, // existing secret; never publish its value
publicPaidAccess: {mode: 'connection-only'},
mailEnabled: false,
processingPaused: true,
```

The separately reviewed pilot-stage fragment changes only the trusted access boundary (and explicitly unpauses preparation when authorized):

```js
publicPaidAccess: {
  mode: 'owned-pilot',
  accountId: '11111111-1111-4111-8111-111111111111', // invented; replace with verified exact account ID
  scopeId: 'operator-preparation-pilot-1', // stable; never rotate automatically
},
mailEnabled: false,
processingPaused: false,
```

- **Fail closed.** A public HTTPS host defaults to `connection-only` if the field is absent, including direct `startTrackingServer` callers. The optional **11th** argument is `publicPaidAccess`; the existing 10th `publicProxy` argument is unchanged. A private loopback host with neither public origin nor access policy keeps legacy behavior. Proxy configuration still requires a public origin. Invalid policy shapes fail with `PUBLIC_PAID_ACCESS_INVALID` before listener/account-store mutation. Account IDs must be canonical lowercase UUIDs; scope IDs are 1–128 ASCII letters/digits/`._:-`, starting with a letter/digit. The host copies the policy, so caller mutation cannot change a running gate.
- **Closed stage is still useful.** Normal registration/sign-in, connections, Google OAuth/callback, roots and existing scoped Google APIs stay available. Startup constructs no preparation/mail service, agent/evidence store, fictional browser portal or budget/model factory in this stage. Only normal local account/Google state is created. A supplied preparation configuration cannot open the server gate. No retained Task is resumed at startup.
- **Mail is off throughout both stages.** Startup forces it off when `mailEnabled` is absent or false; explicit true fails with `PUBLIC_PILOT_MAIL_DISABLED` before state creation. Direct server callers supplying a mail service configuration under the gate also fail. `/mail/*` APIs remain unavailable; there is no mail provider, autosend or background mail task. Private defaults are unchanged.
- **Exact account only.** Authenticated session ownership, never request `accountId`, pilot or scope fields, selects the allowed account. Every other account is denied before preparation Task lookup/initialization, Google binding, source/provider/effect dispatch or quota writes. Normal processing consent, an owned connected Google identity and selected root remain mandatory for the pilot. Existing N4 two-new-Tasks/rolling-24h quota, clock rollback checks and whole-Task model/tool budgets remain additional guards. Classification configuration/flags are separate and unchanged; this is no authorization or workaround for classification.
- **One admission ever per scope.** The same encrypted account-store FIFO transaction reserves the pilot identity and N4 admission before SQLite Task creation. The actual Task ID must be bound durably before enqueue. Additive `paidTasks.pilots?: {scopeId, identity, taskId?}[]` history never expires, refunds or resets daily admissions/unknowns. A second identity is denied even after 24h. A scope cannot be reassigned to another account in that store. At 64 scopes per account, new scopes fail closed rather than pruning any history. A changed scope is a new trusted operator/owner decision, not a daily reset or request option; former scope history stays retained.
- **Conservative recovery.** Failed creation or binding permanently holds an unknown slot; it is not refunded. The stable-identity admission initializer may complete its own interrupted binding, but the public retained-request/continuation path deliberately does **not** adopt an unbound Task. Replays of already-bound matching Tasks return retained receipts without a model call; status/artifact/browser-review reads and cancellation remain local readback/control only. Source/save/correct/resume/browser-approve/browser-reconcile paths use the existing `PreparationService.reconcilePaidTask` hook and require the same already-bound pilot Task. Missing, foreign, pre-pilot or unbound reservations cannot authorize work. A create/bind crash can therefore leave an inspectable but non-resumable pilot Task; no automatic recovery, second identity or new scope is authorized by that crash.
- **Availability without identity disclosure.** `/preparation/config` requires normal authentication/CSRF and returns `configured:false`, `processingPaused:true` and `access:'connection-only'|'owned-pilot'` when unavailable to that session. It discloses no allowed account or scope. An eligible configured pilot also reports `access:'owned-pilot'`. Closed requests get `503 PREPARATION_NOT_CONFIGURED`; other accounts get `403 PREPARATION_PUBLIC_PAID_ACCESS_DENIED`; exhausted/conflicting admissions get `429 PAID_TASK_QUOTA`.

This is a temporary operator release boundary, **not** permanent product eligibility. Source/tests are preparation only: no public activation, payment, deployment, live config/flag change, Google connection/root or real provider call is implied. A new exact candidate and fresh independent root security/configuration review are required before a separate owner GO. The earlier candidate review does not approve these bytes. Backend-only invented-transport tests need no native capture visual evidence and do not establish real Google/provider, native or public-edge acceptance. Historical N4 public mail/multi-account HTTP fixtures assumed unrestricted public paid access; those assumptions are intentionally closed by this gate, not preserved as runtime exceptions.

## Hosted classification quota

`ClassificationConfig.quota = {perMinute, perDay}` defaults to **2 per minute and 12 per day per account**. Validation requires integers with `1 ≤ perMinute ≤ perDay ≤ 1000`.

- **Where admissions are stored.** They live in the existing account `classification.admissions` field: a list of times from the last 24 hours. They are committed in the same transaction as the pending request, before any provider is created.
- **No refunds.** An admission that ends as `unknown`, cancelled or failed is not refunded.
- **Replays are free.** A replay of the same `requestId` returns the stored result and does not use quota.
- **Clock rollback fails closed.** If a stored admission is later than now, new requests get `503 CLASSIFICATION_CLOCK_UNTRUSTED`.
- **Honest errors and status.** Over the quota, the response is `429 CLASSIFICATION_QUOTA`. `/classification/config` reports `quota: {perMinute, perDay, usedMinute, usedDay, clockTrusted}`.
- **Evicted IDs.** A `requestId` evicted from the 32-record history counts as a new admission.
- **The shared budget is still the final cap.** The operator's fresh `FileCallBudget` (1.50 total, ≤ 0.25 per task) remains the overall limit. 100 accounts × 12/day can still drain a shared budget. The per-account quota stops one account from doing it alone.
- **F5 is unchanged.** Pending `unknown` requests are never retried or freed. After 32 of them, that account gets `507 CLASSIFICATION_REQUEST_BOUND`.

**Classification stays unconfigured on the public baseline** until the owner accepts it and the real factory has been proven.

## Reserved names

Direct `/register` rejects the exact WorkOS-derived form `workos.<32 hex>` with `400 ACCOUNT_NAME_RESERVED`. Existing direct sign-in and other names are unchanged, and there is no email-based account linking.

## Gates outside this change

- Infra review of the 62 Worker identity (real Cloudflare client IP → HMAC tag), with real edge proof.
- WorkOS dashboard ACK for the production callback, sign-up policy and environment.
- Font staging.
- The real Google callback.
- Fresh Mac proof of the system-browser workspace.

None of these are claimed by the fixture tests in `tests/account/public-abuse.test.ts`. Those tests use a fixture token and synthetic tags.
