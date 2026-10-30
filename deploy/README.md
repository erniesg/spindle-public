# Deploying Spindle at https://spindle.berlayar.ai

**The public app and reviewed preview downloads are already deployed.** Use the current [delivery issue](https://github.com/erniesg/spindle/issues/51) and [integrated candidate](https://github.com/erniesg/spindle/pull/143) for the selected source, private configuration owner and remaining acceptance gates. Merge is not a new deployment or permission to enable processing.

The initial-installation recipe below records how this target was prepared; **do not rerun E1–E4 against existing production** or copy its example paths/configuration over the active installation. Reuse the actual production data, key and journal after reconciliation. A planned source/unit transition is single-writer, separately reviewed, with its exact prior unit/configuration retained. The runtime custodian owns classification availability; do not bypass a denied flag write through another writer, environment or configuration.

This is one public HTTPS origin, built only from resources that already exist:

```
browser ──HTTPS──▶ Cloudflare custom domain spindle.berlayar.ai (existing, Workers-managed DNS + cert)
                    └─ Worker `spindle-downloads` (existing name, new version from deploy/spindle-web)
                        ├─ /downloads/*  → R2 `spindle-downloads` (existing dedicated bucket), manifest-allowlisted keys only
                        └─ everything else → Workers VPC service → tunnel `rucksack-stg` (existing connector)
                                              → 127.0.0.1:43180 only → deploy/vm/spindle-production.service (fresh data)
```

- **No DNS write and no new hostname.** The live custom-domain binding stays. Its DNS record is Workers-managed. None of our credentials can read or write zone DNS records anyway.
- **No change to cloudflared, nginx, caddy or ports 80/443.** Workers VPC does not use tunnel ingress rules. The VPC service fixes HTTP to `127.0.0.1:43180` with HTTPS absent/disabled, so no request can pick another VM port. The API rejects using the same endpoint for both schemes (5101, verified no service created). Installed Wrangler omits an unset HTTPS field; read back the created service and refuse/delete only that new ID if HTTPS443 or any other target appears. The tunnel's `http_status:404` catch-all is unchanged.
- **No change to the private `127.0.0.1:43166` instance or its data.** Production uses its own release checkout, data directory, key and port.
- The Worker adds no CORS headers. It forwards `Origin`, `Cookie`, `X-CSRF-Token` and `Sec-Fetch-*` as the browser sent them. It sets `Host: spindle.berlayar.ai` through the fetch URL; per Workers VPC, the URL host becomes the Host header and the service config controls routing. So the app's own exact Host/Origin/CSRF checks and `Secure; HttpOnly; SameSite=Strict` session cookie stay authoritative. Only `publicOrigin: 'https://spindle.berlayar.ai'` enables those Secure-cookie semantics.
- App forwarding requires two existing internal65 secrets, `SPINDLE_PROXY_TOKEN` and `SPINDLE_CLIENT_ID_KEY` (32-byte lowercase hex, not provider credentials). The Worker replaces caller-supplied `X-Spindle-Client`/`X-Spindle-Proxy-Token`, HMACs only the edge-supplied CF client network, and strips caller IP-forwarding headers. IPv4 remains unaggregated; IPv6 is parsed/canonicalized and grouped by /64 BEFORE HMAC (host rotation/compression cannot mint new tags); IPv4-mapped IPv6 uses its IPv4 identity. This is per-network abuse control, not unlimited availability against many independent networks. Missing identity/secrets fails closed. Node's reviewed production `publicProxy: {token}` MUST validate the constant token before trusting the strict64hex pseudonym. No CORS/Host/Origin/CSRF exception or raw-IP logging. Downloads/root redirects remain public and need no proxy secrets.
- Downloads are served only for names in `spindle-web/src/downloads.manifest.json`. Each entry is bound to an R2 key under `releases/<revision>/`, a SHA-256 checked by readback, a size and the live R2 etag. If the stored object changes, the download returns 503 instead of serving it. There is no bucket listing and no other key. The legacy key `installers/windows/…` is not served.

Historical takeover inventory and pre-cutover backup: [readiness/ship6h/infra/inventory-and-plan.md](../readiness/ship6h/infra/inventory-and-plan.md). These snapshots are recovery evidence, not the current deployment state.

## Local checks (no effects)

```sh
node --test deploy/spindle-web/tests/worker.test.mjs
(cd deploy/spindle-web && WRANGLER_SEND_METRICS=false wrangler deploy --dry-run --outdir "$RUCKSACK_SCRATCH_ROOT/spindle-web-dryrun")
node deploy/spindle-web/tools/stage-downloads.mjs plan /abs/private/spec.json
```

These prove the routing, allowlist and header logic with fakes, plus bundling. Also run a real local runtime smoke (stop only this foreground process afterwards):

```sh
cd deploy/spindle-web
wrangler dev --local --ip 127.0.0.1 --port 18787 --local-upstream spindle.berlayar.ai --upstream-protocol https
# Separate terminal: / => 302, manifest => 200; /connections => 502 without the remote VPC binding.
curl -sSI http://127.0.0.1:18787/
curl -sS http://127.0.0.1:18787/downloads/manifest.json
```

The compatibility date is supported by the installed workerd. None of these checks proves edge behaviour, VPC connectivity or the live app.

## Historical initial-installation effects

These are not a production rerun script. Each sensitive effect needs its applicable authority and current-state reconciliation before execution; an old approval or a fresh directory is not authority to replace existing production.

Auth is the existing `wrangler login` OAuth for account `5b25778cf6d9821373d913f5236e1606`. Its scopes include workers/workers_scripts/workers_routes write, connectivity admin, zone read and R2 via workers. Never pass tokens in argv or env on the command line.

| # | Effect | Command | Rollback |
|---|---|---|---|
| E1 | Create a private VPC service. Nothing public. | `CLOUDFLARE_ACCOUNT_ID=5b25778cf6d9821373d913f5236e1606 CI=1 wrangler vpc service create spindle-production-origin --type http --tunnel-id 1b7e92d3-5529-4ca9-96b4-8df5f9e63848 --ipv4 127.0.0.1 --http-port 43180`; read back exact tunnel/127.0.0.1/HTTP43180 and HTTPS absent/disabled, then put the id into `spindle-web/wrangler.jsonc` and commit. List before any replay; no duplicate create on unknown outcomes | `wrangler vpc service delete <id>` |
| E2 | Release checkout and build on the VM, at the product integrator's release head `<R>` | `git -C ~/code/erniesg/spindle fetch origin && git -C ~/code/erniesg/spindle worktree add ~/code/erniesg/spindle-release <R>` then in it `npm ci --ignore-scripts && npm run build` (honour the existing npm lock and reviewed host shim; no package-manager migration) | `git -C ~/code/erniesg/spindle worktree remove ~/code/erniesg/spindle-release` |
| E3 | Fresh production config and data (0700/0600) | `install -d -m700 ~/.config/spindle/production ~/.local/share/spindle-production`; first confirm the key, budget journal and account data do not exist; create the key using `(umask 077; set -C; head -c 32 /dev/urandom > ~/.config/spindle/production/account.key)`; existing or partial state requires reconciliation, NEVER overwrite/reinitialization; copy `deploy/vm/account-config.example.mjs` to `account-config.mjs`; write `release.json` (`{revision,tree,buildIdentity}` of `<R>`), `google-web-client.json` and `models.mjs` from 60/65's reviewed values. Create the journal with exclusive creation (`set -C`, umask 077), using exactly `{"provider":"nebius","currency":"USD","hardTaskLimit":<TOTAL_APPROVED_BY_60_65_LE_3>,"reservedWorstCase":0,"observedSpend":0,"requests":[]}`; substitute the actually approved total before execution, never recreate/reset an existing journal | Stop the service and move the directories to a dated `.retired` name. Do not delete them without data-owner approval |
| E4 | Start the origin (loopback only) | `cp deploy/vm/spindle-production.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user start spindle-production` | `systemctl --user stop spindle-production` |
| E5 | Prove VPC reachability without public traffic | `cd deploy/spindle-web && wrangler dev --ip 127.0.0.1 --port 8787 --local-upstream spindle.berlayar.ai --upstream-protocol https` (VPC binding is `remote: true`), then `curl -sS http://127.0.0.1:8787/portal`. Expect actual app HTML, or the unique marker from `node deploy/vm/vpc-probe-origin.mjs` during the earlier data-free capability pilot (start from repo root, reserve43180, log only static path/Host, stop both owned processes afterwards). A marker proves private routing/Host only, NOT a working app. Both flags preserve the canonical HTTPS request URL; no production origin check is bypassed | Stop `wrangler dev` |
| E6 | Upload the approved public artifacts | `node deploy/spindle-web/tools/stage-downloads.mjs upload <spec>` then `… verify <spec>` (writes the manifest), then commit the manifest | Retain published approved objects on rollback; any later deletion needs separate release-owner authority and the exact recorded content-addressed key |
| E7 | **Cutover.** Upload the version, then send 100% of traffic to it | `cd deploy/spindle-web && wrangler versions upload --secrets-file /home/ubuntu/.config/spindle/production/worker-secrets.json --message "spindle <R>"` then `wrangler versions deploy <new-version-id>@100% --yes` | `wrangler versions deploy <recorded-prior-working-version-id>@100% --name spindle-downloads --yes`; record and verify the actual prior serving version before activation, not merely the latest uploaded version |
| E8 | Optional, after E7 is verified: stop public r2.dev access, so allowlisted Worker paths are the only public way to bucket objects | `wrangler r2 bucket dev-url disable spindle-downloads` | `wrangler r2 bucket dev-url enable spindle-downloads` (restores the legacy page's Windows ZIP link) |

Before E7,65 supplies600-mode `proxy-token` and `client-id-key` under the private production config directory. A trusted local program synthesizes600-mode `worker-secrets.json` with ONLY `SPINDLE_PROXY_TOKEN`/`SPINDLE_CLIENT_ID_KEY`, reading those files in memory. Never print values, put them in argv/vars/source, package them in app/extension, rotate/recreate them on retry or use provider keys. `versions upload --secrets-file` stages code and encrypted secret bindings together WITHOUT deploying; never use live `secret put` as a substitute. Check the actual reviewed app rejects private-origin requests missing/forging the proxy token, and accepts a correct-token/HMAC-identity proxy request, before public activation. The actual production config must forward optional10th `publicProxy`; an old source silently ignoring it is NOT eligible. A private paired test still is not HTTPS/browser/native acceptance.

**E6 is already public publication, not private staging:** the existing bucket's r2.dev URL is enabled. Upload ONLY independently reviewed, explicitly public product ZIPs; record that exposure before E6, not just E7. No private test receipts, source profiles, credentials or review archives. E8 remains optional to avoid unnecessarily breaking the retained legacy direct link; if selected, disable it before E6 and retain the documented reversal. The Worker's allowlist/etag checks do not apply to direct r2.dev URLs.

E3 is create-only. If the key, journal or account data already exists, stop and reconcile/reuse the exact deployment; do not remove it to make initialization succeed. Both files must be exclusive-created in the same guarded shell; retain partial state on failure. Real Google/model/WorkOS config and budget values come from60/65. Start paused; enabling processing requires their actual configuration/budget approval and the working new-account journey, not an inferred config spread override. No owner-only registration window or invite requirement may silently replace the requested new-account use case.

Never run plain `wrangler deploy` with a different config under the name `spindle-downloads`. Never bind `spindle-legacy-backups`, `rucksack-host-offload` or any review bucket. Never enable `workers_dev` or preview URLs.

## Verification after E7

Use invented test accounts and no personal data:

```sh
curl -sSI https://spindle.berlayar.ai/ | grep -iE '^(HTTP|location)'            # 302 → /portal
curl -sS  -o /dev/null -w '%{http_code}\n' https://spindle.berlayar.ai/portal        # 200, from the app
curl -sS  https://spindle.berlayar.ai/downloads/manifest.json                     # only the reviewed artifacts
curl -sSL https://spindle.berlayar.ai/downloads/<name> | sha256sum                   # equals the manifest sha256
curl -sS  -o /dev/null -w '%{http_code}\n' https://spindle.berlayar.ai/downloads/installers/windows/x.zip  # 404
curl -sS  -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: https://evil.example' -H 'content-type: application/json' -d '{}' https://spindle.berlayar.ai/session   # 403 ORIGIN_DENIED
curl -sSI https://spindle.berlayar.ai/ | grep -i access-control                    # none
curl -sSI http://spindle.berlayar.ai/ | grep -iE '^(HTTP|location)'               # HTTPS redirect/upgrade by zone settings
wrangler tail spindle-downloads --format pretty                                    # during checks only
```

Then: register, sign in and log out in a real browser, which needs a `Secure` cookie on `spindle.berlayar.ai`. Do Google connect once the redirect URI is registered. Check the protected instance (`ss -ltnp | grep 43166`, same pid) and the other tunnel hostnames are unaffected.

## Recovery: restore the affected layer, preserve the working app

1. **Worker/download-only failure:** restore the prior working Worker version recorded before that activation, then verify its actual traffic allocation and HTTPS app/catalogue behavior. For the reviewed download-manifest activation, the retained prior version is `fcdeab93-8272-420d-bdbc-0b0a0f63a466`: it preserves the app proxy but has no selected download aliases. Do not stop a healthy Node host, change classification availability, delete approved objects or remove the active VPC service for a download-only rollback.
2. **Node source/configuration failure:** the sole unit operator normally stops only the owned failed instance, confirms zero writers, restores the exact reviewed prior unit/source/configuration and verifies private token guards plus canonical HTTPS source/account health. Keep classification paused until its custodian has the applicable new-PID approval. Preserve all production data, keys, journals, unknown reservations and QA histories; no lock deletion, fresh-store substitution or blind replay.
3. **Decommissioning is not rollback.** Deleting the VPC service, moving production data or changing bucket access needs its separate ownership/authority and proof that no live consumer needs it. Never delete the shared tunnel or selected hostname. Preserve the legacy direct-download compatibility decision if considering E8.

Legacy assets-only version `c3dd4a40-6391-4807-b6f1-ebe21f20609a` and its [byte backup](../readiness/ship6h/infra/legacy-live-backup-20261029T1527Z/) remain retained recovery material. Selecting it would hide the working Spindle app; it is not the normal rollback for the current app/download deployment.
