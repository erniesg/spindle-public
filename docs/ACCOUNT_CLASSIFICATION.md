# Account-hosted remote classification

The tracking server can classify **one of the signed-in account's own uploaded history records** with the operator-chosen Nebius/NVIDIA model. The server holds the provider, credential and budget. Native and web clients send only a record key, its evidence revision, a request ID and a mode. They never ship or receive a key and cannot choose a model, URL or context.

Status: source and simulated HTTP checks only. Tests use real authenticated HTTP against `startTrackingServer` with a real `TextProvider` over a **scripted transport**. No real provider, browser or native path has been exercised here, and the portal Activity view now calls these routes. The provider factory remains operator-supplied private configuration outside this repository.

## Wiring

`startTrackingServer(directory, key, port, publicOrigin, google, preparation, mail, workos, classification?, publicProxy?)` accepts an optional ninth `ClassificationConfig` (`core/account/classification-host.ts`). The existing seven- and eight-argument forms are unchanged. Without it, `/classification/config` returns `{configured:false}` and every other route returns `503 CLASSIFICATION_NOT_CONFIGURED`.

```ts
interface ClassificationConfig {
  model: ModelDeclaration;                       // public declaration, validated at start
  createProvider(context:{current():boolean; signal:AbortSignal}): TextProvider; // operator model/credential/FileCallBudget
  paused?(): boolean;                            // operator remote-processing pause
}
```

`createProvider` runs only after authentication, CSRF, consent and owned-record admission. A provider whose declared provider/model differs from `model` returns `INVALID_MODEL` without dispatch. Nothing runs at startup or on consent. There is no automatic classification and no retry.

## Routes

Every route is `POST`, needs the session cookie, an exact `Origin` and `X-CSRF-Token`, and accepts no query string. Global guards are unchanged.

| Route | Body | Effect |
| --- | --- | --- |
| `/classification/config` | `{}` | Public model `{provider,id,vision}`, `paused`, `processing`, current `consent`, `automatic:false`. Never creates a provider. |
| `/classification/consent` | `{enabled:true,fields:[...]}` or `{enabled:false}` | Fields are drawn from `appId`, `domain`, `title`, `text` and `image`. Granting requires processing on; `image` requires a vision model. Each change bumps the consent revision. |
| `/classification/classify` | `{key,evidenceRevision,requestId,mode:'text'\|'image'}` | Classifies one owned record (see below). |
| `/classification/status` | `{requestId}` | Owner-only stored result, `inflight` or `unknown`. |

## Classify admission and currentness

The first account transaction admits a request only when all of these hold:

- processing is on and consent is current for the configured model;
- the record belongs to the authenticated account, is not deleted, and is unexpired;
- `evidenceRevision` matches the record;
- the mode is consented. Image mode also needs `scopes.pixels` and a retained, unexpired image, and pins its SHA-256.

At most one job runs per account. The transaction then writes a durable `pending` request with the consent and correction revisions. Provider work happens **outside** the encrypted FIFO.

Fences:

- **Dispatch:** `current()` covers abort, pause, close, and session or context expiry. Every committed session, consent, processing or history write calls `observe()`, which aborts a job when its session is gone, consent or processing changed, the evidence was deleted or changed, the image digest changed, or a correction landed.
- **Late persist:** a final transaction re-validates all of the above before storing anything. Stale output becomes `STALE_RESULT` and is never stored.

Missing or short text ends in `insufficient-evidence` before dispatch, and the server never guesses from the source URL. Existing user corrections are frozen (`user-choice-preserved`).

## Stored inference and readback

A suggestion is stored as `labels.inferences[key]` together with the evidence revision, model, source and request ID. It is kept separate from manual `corrections`. `/sessions` and `/corrections` rehydrate it through `LocalLabels.beginSuggestion/applySuggestion`, so the label reads `source:'inference'` with `inferenceSource` and `remoteInference:{provider,model,requestId}`. A manual correction still wins, and undo restores the inference.

- Inference for deleted, changed or expired evidence is pruned.
- Turning processing off revokes consent and discards inference.
- Revoking consent cancels live work but keeps completed inference.

## Replay and cost

The request ID is the idempotency key. A replay returns the stored result. A pending record with no live job reads `unknown` (for example after a crash once admission was durable) and is **never** redispatched. Reusing an ID with different parameters returns `409 REQUEST_ID_REUSED`. Each account keeps at most 32 request records.

Cost is bounded by the operator's `TextProvider` budget (`FileCallBudget` in production). Each call carries one record and one model request.

## Not covered

- Real provider/browser/native evidence.
- Frontend controls.
- The production factory.
- Image-mode dispatch, which has no pilot test; only the denial paths are tested.
- Automatic opt-in, which should later call this same route rather than a second pipeline.
