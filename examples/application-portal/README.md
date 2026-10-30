# Fictional loopback application portal (partial #40)

`startPortal(storageDirectory, config?, options?)` starts an independent Node 22 HTTP destination on `127.0.0.1`. The returned `origin` is the actual browser URL; `close()` stops the server. No capture, Google, deployment or provider activity occurs.

Fields and attachment labels/order/required state, MIME type and byte limits are configurable. Ordinary multipart POST `/applications` commits uploaded bytes and an atomic receipt metadata rename before redirecting to `/receipts/<sha256-of-submission-identity>`. The visible submission identity permits reconciliation by ordinary receipt GET after a response loss. Reusing it for different content returns 409. `loseResponseOnce` drops the first post-commit response for recovery tests. Storage is separate from the capture vault; retain it across restarts. Use invented data only.

Compile and run the focused real-HTTP regressions:

```sh
./node_modules/.bin/tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --outDir /tmp/spindle-portal-build examples/application-portal/*.ts tests/portal/*.ts
node --test /tmp/spindle-portal-build/tests/portal/*.test.js
```

## Explicit remaining acceptance

This is a bounded useful subset, not completed #40 or connected-journey acceptance. Field constraints, MIME, byte limits, bounded PDF structure, JPEG frame metadata and PNG checksums/decompressed scanlines are checked. Configured photos support 8-bit noninterlaced RGB PNG with validated CRCs, bounded inflate, scanline filter types, dimensions and byte limits. RGBA is supported for ordinary attachments but rejected for RGB photos. JPEG photo validation is explicitly rejected as unsupported: three JPEG components do not establish RGB color space. The base 400 × 514 RGB JPEG requirement, full JPEG decoding, background and visual-quality verification remain pending. Ordinary JPEG attachments retain bounded structural/frame metadata checks, not full decoded validity. PDF checks inspect header, catalog/page markers, xref offset, trailer/root and EOF; they are not a complete PDF parser, rendering or safety guarantee. The store assumes one server process per directory; no multi-process lock or power-loss fsync guarantee exists. No CLI launcher, Windows check, independent review or Gmail URL demonstration is claimed. `tests/portal/browser.mjs` exercises real Chromium labelled fill, PDF upload, submit and receipt revisit; its ignored local screenshots require inspection and do not establish the connected-agent journey. Test discovery/build registration is coordinator-owned. Revisit and uploaded-byte identity are exercised through actual HTTP and filesystem reads, not a success fixture route.
