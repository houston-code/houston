#!/usr/bin/env bash
# Run a package.json dist script (`npm run <dist> -- --publish never`), retrying on macOS
# when, and only when, it hits one of two known flakes. Used by ci.yml's `package` job and
# release-build.yml's `Package` step.
#
# Usage: scripts/dist-with-retry.sh <dist-script>
#
# The dmg detach flake: something on the runner holds the freshly built dmg volume open,
# dmgbuild's own detach retries (12, with backoff) run out, and it force-detaches and fails
# with "Unable to detach device cleanly ... Resource busy". A fresh attempt builds a fresh
# volume.
#
# The staple flake (signing legs only): after notarization, @electron/notarize staples the
# ticket, which looks it up on Apple's servers (api.apple-cloudkit.com). A dropped connection
# fails it with "The staple and validate action failed! Error 68" and an NSURLErrorDomain
# error. Both must appear, so a stapling failure that isn't a network error is not retried.
#
# Any other failure, and every failure off macOS, fails on the first attempt.
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
  flake=
  if grep -q 'Unable to detach device cleanly' "$log"; then
    flake=detach
  elif grep -q 'The staple and validate action failed! Error 68' "$log" \
    && grep -q 'NSURLErrorDomain' "$log"; then
    flake=staple
  fi
  if [ "${RUNNER_OS:-}" != macOS ] || [ "$attempt" -eq "$max" ] || [ -z "$flake" ]; then
    exit 1
  fi
  if [ "$flake" = staple ]; then
    echo "::warning::stapling lost its connection to Apple on attempt $attempt of $max, retrying"
    sleep "$delay"
    continue
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
