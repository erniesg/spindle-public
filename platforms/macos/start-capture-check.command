#!/bin/bash
# Development runner: no startup registration, no security-setting changes.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$DIR/contracts/capture-check.package.json" ]; then ROOT="$DIR"; else ROOT="$(cd "$DIR/../.." && pwd)"; fi
NODE="$ROOT/runtime/node"
if [ ! -x "$NODE" ]; then NODE="$(command -v node || true)"; fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "This source checkout needs Node 22+. The review ZIP includes it. No software was installed."
  read -r -p "Press Enter to close. " _
  exit 1
fi
if [ ! -f "$ROOT/build/core/capture-check/app.js" ]; then
  echo "Source checkout: run npm ci --ignore-scripts and npm run build first. Review ZIPs already include generated JavaScript."
  exit 1
fi
BUILD="$ROOT/.local/capture-check"
APP="$BUILD/SpindleCaptureCheck.app"
mkdir -p "$APP/Contents/MacOS"
DEV_DIR="$(xcode-select -p 2>/dev/null || true)"
if [ -z "$DEV_DIR" ] || [ ! -d "$DEV_DIR" ] || ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "Apple Command Line Tools are needed for this first source-runner build."
  echo "To install them yourself, run: xcode-select --install"
  echo "Opening the local inspector with a shareable failure code…"
  export SPINDLE_CHECK_MAC_FAILURE=MAC_TOOLS_REQUIRED
  exec "$NODE" "$ROOT/build/core/capture-check/app.js"
fi
SOURCE="$ROOT/platforms/macos/CaptureCheck.swift"
HASH="$( { shasum -a 256 "$SOURCE"; xcrun swiftc --version; uname -m; } | shasum -a 256 | cut -d' ' -f1)"
OLD="$(head -n 1 "$BUILD/source-hash" 2>/dev/null || true)"
if [ "$HASH" != "$OLD" ] || [ ! -x "$APP/Contents/MacOS/SpindleCaptureCheck" ] || ! codesign --verify "$APP" >/dev/null 2>&1; then
  echo "Building the native Mac reader (first launch or source update)…"
  if ! MACOSX_DEPLOYMENT_TARGET=13.0 xcrun swiftc -swift-version 5 -O -framework AppKit -framework ApplicationServices "$SOURCE" -o "$APP/Contents/MacOS/SpindleCaptureCheck" >"$BUILD/build.log" 2>&1; then
    echo "Mac build failed. The inspector will offer a content-free feedback file. Raw compiler output stays local."
    export SPINDLE_CHECK_MAC_FAILURE=MAC_BUILD_FAILED
    exec "$NODE" "$ROOT/build/core/capture-check/app.js"
  fi
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>SpindleCaptureCheck</string><key>CFBundleIdentifier</key><string>ai.berlayar.spindle.capturecheck.development</string><key>CFBundleName</key><string>Spindle Capture Check</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>13.0</string></dict></plist>' >"$APP/Contents/Info.plist"
  if ! codesign --force --sign - "$APP" >>"$BUILD/build.log" 2>&1; then
    export SPINDLE_CHECK_MAC_FAILURE=MAC_BUILD_FAILED
    exec "$NODE" "$ROOT/build/core/capture-check/app.js"
  fi
  printf '%s\n' "$HASH" >"$BUILD/source-hash"
fi
exec "$NODE" "$ROOT/build/core/capture-check/app.js"
