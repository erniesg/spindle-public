#!/usr/bin/env bash
# One-shot owned Xvfb for the actual Linux three-surface journey. No registration
# outside the test's isolated profile, persistent service or global display cleanup.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
mkdir -p .local
run=$(mktemp -d "$PWD/.local/pomodoro-display-XXXXXX")
Xvfb -displayfd 3 -screen 0 1440x1100x24 -nolisten tcp 3>"$run/display" >"$run/stdout" 2>"$run/stderr" &
pid=$!
cleanup(){
 local status=$?
 kill -TERM "$pid" 2>/dev/null || true
 wait "$pid" 2>/dev/null || true
 if [[ $status == 0 ]]; then rm -r -- "$run"; else printf 'Owned Xvfb diagnostics retained: %s\n' "$run" >&2; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for _ in {1..50}; do
 if [[ -s "$run/display" ]]; then break; fi
 kill -0 "$pid" 2>/dev/null || break
 sleep .1
done
[[ -s "$run/display" ]] || { printf 'Xvfb readiness failed\n' >&2; exit 1; }
export DISPLAY=:$(<"$run/display")
node build/tests/pomodoro/surfaces.e2e.js
