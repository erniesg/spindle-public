# Precompiled Mac Preview helper cache

An ordinary Mac package does not need Command Line Tools, an SDK, Python, git or a repository on the user's Mac. A developer Mac that already has the tools produces a precompiled `SpindlePreview`/`SpindleFixture` cache once per Swift input. The packager carries that cache and the packaged launcher checks it with bundled Node before anything starts. The local Swift compile is only for an explicitly recognised source checkout.

## Build on a Mac (external facility needed)

You need Apple Silicon or Intel macOS with the installed Command Line Tools/Xcode, macOS 15+ SDK, `git` and `/usr/bin/python3` (the CLT Python 3.9 is enough). Nothing is downloaded or installed. From a clean checkout of the exact commit to package:

```sh
git status --porcelain   # must print nothing
/usr/bin/python3 tools/build_macos_preview.py --output .local/macos-native-cache
```

It compiles `platforms/macos/Preview.swift` with the same flags as the source launcher (`swiftc -swift-version 5 -O -target arm64-apple-macos15.0`, AppKit/ApplicationServices/ScreenCaptureKit/Vision/CoreImage/Security). Then it ad-hoc signs (`codesign --force --sign -`), runs `codesign --verify --strict`, checks the Mach-O and copies identical bytes to `SpindleFixture`. Finally it writes `macos-native-build.json` and moves the finished cache into a new or empty output directory. It refuses a dirty tree (including untracked files), an SDK older than 15, a non-arm64/non-signed result or source changing during the build. It never runs the helper, requests permissions, touches xattr/spctl/Gatekeeper, notarizes or registers anything.

Return the whole output directory with its printed JSON. Producing it proves a Mac compile and ad-hoc signature only. It does **not** prove that the helper ran or captured anything, and it is not installed acceptance; that still needs the [TESTING.md](TESTING.md) native/installed evidence.

## Cache record

`macos-native-build.json` has exactly these keys: `schema` `spindle-macos-preview-native/v1`, `target` `macos-arm64`, 40-hex `sourceRevision`/`sourceTree`, `sourceDirty: false`, `inputs` containing only the SHA-256 of `platforms/macos/Preview.swift`, `binarySha256`, `fixtureSha256`, `bytes`, `compiler` (first `swiftc --version` line), `sdk`, `minMacos` `15.0` and the producer fact `codesignVerified: true`. Unknown keys, such as an acceptance claim, are rejected.

A cache built at one revision may be packaged at another only when the packaged `Preview.swift` hash equals `inputs`. Both validators then report `producerSourceRevision`, `packageSource` and `reusedAcrossRevisions: true` rather than hiding the difference.

## Packaging

```sh
python3 tools/package_preview.py --target macos-arm64 --macos-native-cache .local/macos-native-cache
```

A `macos-arm64` target requires `--macos-native-cache`; it no longer needs `--dotnet`/`--windows-native-cache` and never runs a Windows build. A Windows-only `--target windows-x64` neither needs nor accepts a Mac cache. With no `--target`, both platforms and both native inputs are required. There is no source-only ordinary Mac package. Before cleaning `build/`, compiling, downloading Node or staging anything, the packager runs `verify_cache(DIR, ROOT, HEAD)` on the cache. It then re-verifies a private snapshot of the bytes it read and packages only those bytes. A missing or invalid cache stops with `MAC_NATIVE_CACHE_INVALID: <code>`.

The ZIP adds `runtime/SpindlePreview`, an identical `runtime/SpindleFixture` (both mode 755, like `runtime/node` and the `.command` files) and the unchanged `runtime/macos-native-build.json`. It also adds `build/tools/verify-macos-preview.js` and its import closure. `preview-build.json` records `nativeBuild: macos-precompiled-cache`, `nativeExecution: not-run` and `installedAcceptance: not-validated`. Its `macosNativeCache` holds the structural check result: `check: structural-only`, `producerSourceRevision`, `packageSource`, `reusedAcrossRevisions`, `inputs`, `binarySha256` and `producerRecord: unattested-producer-metadata`. A producer revision different from the package `HEAD` is reused only because the packaged `Preview.swift` hash matches. The producer record is not a trusted build attestation.

## Packaged launch

`Start Spindle Preview.command` at a package root checks, in order:

1. Apple Silicon (`uname`) and macOS 15+ (`sw_vers`).
2. `preview-build.json` is present (`MAC_PACKAGE_INCOMPLETE`).
3. The bundled `runtime/node` is executable (`BUNDLED_NODE_REQUIRED`). Ambient Node is never used.
4. `runtime/macos-native-build.json` is present (`MAC_NATIVE_CACHE_REQUIRED`).
5. Bundled Node runs `build/tools/verify-macos-preview.js` (`MAC_NATIVE_CACHE_INVALID`; the content-free result is in `.local/macos-native-check.json`).
6. If the built-in `/usr/bin/codesign` exists, it runs `--verify --strict` on the helper (`MAC_NATIVE_SIGNATURE_INVALID`).

Only then does it start `build/core/preview/app.js`. It never calls `xcrun`/`swiftc`, compiles, falls back to compiling or adopts an older unrecorded helper. It changes no xattr/spctl/Gatekeeper/security setting and grants no permission. Running the launcher from `platforms/macos/` inside a git checkout that has `package.json` keeps the developer CLT compile path. Any other layout fails with `MAC_PACKAGE_INCOMPLETE`.

## Validation

- `python3 tools/build_macos_preview.py --verify-cache DIR [--package-source SHA]` runs anywhere, including this Linux VM. The directory must contain only the three entries.
- `node build/tools/verify-macos-preview.js [--root PACKAGE]` checks `runtime/macos-native-build.json`, `runtime/SpindlePreview`, `runtime/SpindleFixture` and `platforms/macos/Preview.swift`. If `preview-build.json` exists, the validator also checks its `source` and listed `Preview.swift` hash. It prints a content-free JSON result and exits 2 before launch when the cache is invalid. A user Mac needs only bundled Node.

Both validators reject symlinked, non-regular, missing or oversize (64 MiB binary) entries. They also reject manifest/hash/fixture/source-input mismatches and anything other than a thin 64-bit arm64 `MH_EXECUTE` with a macOS `LC_BUILD_VERSION` minimum of 15.0 and a code-signature load command. A valid result is `check: structural-only`, `nativeExecution: not-run`, `installedAcceptance: not-validated`. The validators check structure; they do not re-run `codesign --verify` and are not native evidence.

`tests/test_macos_preview_native.py` and `tests/test_macos_preview_package.py` use **synthetic Mach-O headers, a synthetic Node wrapper and synthetic uname/sw_vers/xcrun/codesign stand-ins, not real Mac binaries**. They prove validators, producer binding, package contents and launcher ordering. They do not prove compilation, Gatekeeper behaviour for a downloaded ad-hoc-signed helper, execution, permissions or installed acceptance. Those still need a real Mac run of the exact package.
