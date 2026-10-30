#!/bin/bash
set -euo pipefail
umask 077
here=$(cd -- "$(dirname -- "$0")" && pwd)
if [[ -d "$here/build/core/preview" ]]; then root="$here"; else root=$(cd "$here/../.." && pwd); fi
mkdir -p "$root/.local"
fail(){ printf '{"schema":"spindle-preview-launch/v1","code":"%s","nativeAcceptance":"not-validated"}\n' "$1" >"$root/.local/launcher-feedback.json"; echo "$1: see READ ME FIRST; no software or security setting changed."; exit 2; }
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || fail MAC_ARM64_REQUIRED
version=$(/usr/bin/sw_vers -productVersion); (( ${version%%.*} >= 15 )) || fail MAC_OS_15_REQUIRED
[[ -f "$root/build/core/preview/app.js" ]] || fail RUN_NPM_BUILD_FIRST
if [[ "$root" == "$here" ]]; then
 # Downloaded package: bundled Node checks the precompiled helper before anything starts.
 # Never compile, use CLT/SDK or ambient Node, or fall back when the cache is missing/invalid.
 [[ -f "$root/preview-build.json" ]] || fail MAC_PACKAGE_INCOMPLETE
 node="$root/runtime/node"; [[ -x "$node" ]] || fail BUNDLED_NODE_REQUIRED
 [[ -f "$root/runtime/macos-native-build.json" ]] || fail MAC_NATIVE_CACHE_REQUIRED
 "$node" "$root/build/tools/verify-macos-preview.js" --root "$root" >"$root/.local/macos-native-check.json" 2>/dev/null || fail MAC_NATIVE_CACHE_INVALID
 # Built-in macOS signature check only; no xattr/spctl/Gatekeeper change.
 if [[ -x /usr/bin/codesign ]]; then /usr/bin/codesign --verify --strict "$root/runtime/SpindlePreview" >/dev/null 2>&1 || fail MAC_NATIVE_SIGNATURE_INVALID; fi
elif [[ "$here" == "$root/platforms/macos" && -e "$root/.git" && -f "$root/package.json" ]]; then
 # Developer source checkout only: local Command Line Tools compile.
 /usr/bin/xcrun --find swiftc >/dev/null 2>&1 || fail MAC_TOOLS_REQUIRED
 sdk=$(/usr/bin/xcrun --sdk macosx --show-sdk-version); (( ${sdk%%.*} >= 15 )) || fail MAC_SDK_15_REQUIRED
 node="$root/runtime/node"; [[ -x "$node" ]] || node=$(command -v node || true)
 [[ -n "$node" && -x "$node" ]] || fail NODE_REQUIRED
 mkdir -p "$root/runtime"
 hash=$( { /usr/bin/shasum -a 256 "$root/platforms/macos/Preview.swift"; /usr/bin/xcrun swiftc --version; echo "$sdk"; } | /usr/bin/shasum -a 256); hash=${hash%% *}
 old=$(head -1 "$root/.local/preview-source-hash" 2>/dev/null || true)
 if [[ "$hash" != "$old" || ! -x "$root/runtime/SpindlePreview" ]]; then
  mkdir -p "$root/.local/preview-native"
  cp "$root/platforms/macos/Preview.swift" "$root/.local/preview-native/main.swift"
  /usr/bin/xcrun swiftc -swift-version 5 -O -target arm64-apple-macos15.0 "$root/.local/preview-native/main.swift" -o "$root/runtime/SpindlePreview.tmp" -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit -framework Vision -framework CoreImage -framework Security >"$root/.local/native-build.log" 2>&1 || fail MAC_BUILD_FAILED
  /usr/bin/codesign --force --sign - "$root/runtime/SpindlePreview.tmp" >>"$root/.local/native-build.log" 2>&1 || fail MAC_SIGN_FAILED
  mv "$root/runtime/SpindlePreview.tmp" "$root/runtime/SpindlePreview"
  cp "$root/runtime/SpindlePreview" "$root/runtime/SpindleFixture"
  printf '%s\n' "$hash" >"$root/.local/preview-source-hash"
 fi
else
 fail MAC_PACKAGE_INCOMPLETE
fi
exec "$node" "$root/build/core/preview/app.js" "$@"
