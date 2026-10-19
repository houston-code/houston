#!/usr/bin/env bash
# Run a package.json dist script (`npm run <dist> -- --publish never`), retrying on macOS
# when, and only when, it hits electron-builder's dmg detach flake. Used by ci.yml's
# `package` job and release-build.yml's `Package` step.
#
# Usage: scripts/dist-with-retry.sh <dist-script>
#
# The flake: something on the runner holds the freshly built dmg volume open, dmgbuild's
# own detach retries (12, with backoff) run out, and it force-detaches and fails with
# "Unable to detach device cleanly ... Resource busy". A fresh attempt builds a fresh
# volume. Any other failure, and every failure off macOS, fails on the first attempt.
#
# A retry reruns the whole dist script, so on a signing leg it re-signs and re-notarizes
# the app (a second notarization submission, which Apple accepts). The dmg itself is not
# signed or notarized. Every output in release/ is rewritten under the same name.
#
# Env: DIST_MAX_ATTEMPTS (default 3) and DIST_RETRY_DELAY seconds (default 15) exist for
# the tests.
set -uo pipefail

dist=${1:?usage: dist-with-retry.sh <dist-script>}
max=${DIST_MAX_ATTEMPTS:-3}
delay=${DIST_RETRY_DELAY:-15}
log="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/dist-with-retry.$$.log"
trap 'rm -f "$log"' EXIT

for attempt in $(seq 1 "$max"); do
  if npm run "$dist" -- --publish never 2>&1 | tee "$log"; then
    exit 0
  fi
  if [ "${RUNNER_OS:-}" != macOS ] || [ "$attempt" -eq "$max" ] \
    || ! grep -q 'Unable to detach device cleanly' "$log"; then
    exit 1
  fi
  echo "::warning::dmg detach flake (hdiutil Resource busy) on attempt $attempt of $max, retrying"
  # Force-detach any image still attached from this workspace. Images from elsewhere
  # (simulator runtimes and other runner images) are left alone.
  hdiutil info | awk -v ws="${GITHUB_WORKSPACE:-$PWD}/" '
    /^image-path/ { path = substr($0, index($0, ":") + 2); next }
    /^\/dev\/disk[0-9]+[[:space:]]/ && path != "" {
      if (index(path, ws) == 1) print $1
      path = ""
    }' | while read -r dev; do
    echo "force-detaching leftover $dev"
    hdiutil detach -force "$dev" || true
  done
  sleep "$delay"
done
