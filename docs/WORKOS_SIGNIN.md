# Spindle sign-in and cross-device sync

Owner outcome: ordinary system-browser sign-in on Mac, explicit sync consent, another signed-in client on the same backend sees account history and Pomodoro state. Google Gmail/Drive remains a separate connection. Direct account/service connection stays available. No recording, screenshots, retention, model, startup, or Google grant follows from sign-in.

## Chosen integration

Add AuthKit as a login adapter for the existing encrypted account/session/device/history/timer service. No auth rewrite, new database, or duplicate sync service. Use documented public-client authorization-code + S256 PKCE. No WorkOS server secret is required. The backend exchanges codes and cryptographically validates access tokens before mapping the provider subject to an internal UUID. Never merge accounts based on email/name or automatically attach existing password-account history.

Web: bounded one-time state plus browser-binding HttpOnly SameSite=Lax cookie and server-held PKCE verifier; exact backend callback issues existing HttpOnly Spindle session then returns to /portal. Native: explicit HTTPS link opens system browser, short-lived dedicated 127.0.0.1 callback listener validates random state and PKCE; trusted local bridge completes at the named backend. Native completion creates separate tracking/timer sessions so timer signout cannot invalidate tracking. Credentials stay in the existing OS-key encrypted client store or memory; never return them to the desktop UI.

WorkOS application already exists: Spindle / client_01M5068NP231S1TTFY2FCX8WGN in authorized Berlayar project Staging. Discovery confirms shared issuer https://api.workos.com/user_management/client_01KXP33HD63BY3BYYC0BDHZMRB and JWKS https://api.workos.com/sso/jwks/client_01KXP33HD63BY3BYYC0BDHZMRB. Signature, issuer, time, user-subject/session shape AND exact Spindle client_id are mandatory. No sibling-project secrets are read or reused.

The actual existing private backend is VM http://127.0.0.1:43166 via the existing Mac SSH forward. Preserve candidate 32f3a8a and its running test. New feature validation uses an isolated invented-data VM runtime on 43167 and a loopback SSH forward, not a second local backend with a matching username. Production non-loopback origins require HTTPS; no CORS/Origin/TLS exceptions.

## Implementation and verification order

1. Provider module and signed-token adversarial tests; independent native callback module and real loopback tests run in parallel.
2. Existing backend auth adapter maps provider identities and issues sessions; web state/PKCE replay tests. Existing server auth hunks are coordinator60-held until released.
3. Existing clients adopt only backend-validated sessions, verify /session, preserve account/origin/device/queue fences, retain direct login. Preview routes require existing bearer/Host/Origin and owner lifecycle controls.
4. Web and desktop show Sign in / Sync across devices, backend identity, explicit consent and truthful pending/last-sync/error. Google link remains separate.
5. Scoped regression checks, fresh independent security/integration review, repairs and fresh review of changed scope.
6. Configure only exact existing Spindle callback/logout URLs using authorized account; provider action-time gates remain. Demonstrate ordinary login, same-account second-client readback, invented history/timer changes and reconnect. Real provider/native proof is distinct from fixture tests. Do not replace the active Mac runtime/candidate.

Sources: https://workos.com/docs/authkit/applications ; https://workos.com/docs/reference/authkit/authentication ; https://workos.com/docs/reference/authkit/authentication/get-authorization-url ; https://workos.com/docs/reference/authkit/session-tokens .

## Private test configuration and session limits

`config/workos-private-test.json` contains public identifiers only. The explicit backend CLI retains its original arguments and accepts that public config as the last optional argument. The isolated listener is `http://[::1]:43167`; native callback is exactly `http://127.0.0.1:43168/auth/callback`. The web callback is exactly `http://[::1]:43167/auth/workos/callback`, and sign-out return is `http://[::1]:43167/portal`. No wildcard, DNS, public binding, TLS exception, server key or Google client is needed for this private test. An existing SSH loopback route must reach this ONE VM listener.

The future desktop branch opens its shared workspace explicitly in the system browser at the same 43167 backend, preserving browser-cookie ownership. Its native controls perform the separate PKCE callback/adoption ceremony. Candidate 32f3a8a still uses 43166 and is untouched.

Verified WorkOS identity creates ordinary Spindle sessions with the existing 12-hour lifetime. Local sign-out revokes that Spindle session. WorkOS remote revocation is not continuously polled, and no WorkOS refresh token is persisted; expired Spindle sessions require browser sign-in again. Do not claim immediate environment-wide WorkOS logout or a long-lived refresh lifecycle. Existing password accounts/data are not automatically linked or migrated.

Development evidence distinguishes signed-token fixtures from actual provider/native acceptance. Provider adapter security review at 041e780 found no actionable defects. Ceremony review at 13f6927 identified shutdown fencing, browser previous-session rotation and premature native callback-response settlement; fixes and final integrated review remain required. Ordinary real WorkOS web sign-in has now passed on the Mac through the isolated IPv6 VM route, followed by explicit shared-view consent, a one-minute Start/Pause at revision2 and reload preserving the same backend account and timer. No seeded session or copied credential was used. This does not establish native or second-client real-provider acceptance.

The isolated web backend binds IPv6 loopback `::1`; its cookies belong to `[::1]`, separate from active candidate IPv4 `127.0.0.1`. Ports alone do not isolate browser cookies. Native callback stays the registered IPv4 loopback path and never consumes or sets application session cookies. The existing default IPv4 listener is unchanged when WorkOS IPv6 callback configuration is absent.

## Local account queues and cleanup ownership

WorkOS clients select the existing encrypted client-store implementation under a deterministic local directory derived from the canonical backend origin and verified account UUID. The legacy direct-account directory is preserved byte-for-byte; authentication never moves or adopts its pending history. The active selection is saved only after successful authentication and parent settings commit.

Native completion journals both issued Spindle session leases in the existing OS-key encrypted Preview settings before adoption. Failed logout or uncertain journal writes remain pending; key recovery restores and retries known authority. Parent settings retain both leases until adoption commits. Successful tracking credentials belong to the durable tracking store; the successful timer credential remains encrypted only as cleanup authority and is reclaimed after restart rather than silently restoring a timer/extension grant. No WorkOS refresh token is saved.

Packaged jose runtime bytes, dependency parsing and receipts derive from one verified immutable snapshot anchored to the official tarball’s lockfile SHA512 and committed file hashes. Tampering, missing files, unknown bare imports and graph/copy/receipt races fail closed or preserve the verified snapshot. Full provider/native acceptance remains distinct from signed-token fixture, packaging and Mac compile evidence.
