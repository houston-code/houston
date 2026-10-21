#!/usr/bin/env bash
# Run a command, retrying it when it fails. release-build.yml uses it for the uploads into the
# draft release: they run after a leg has built, signed and notarized, so a dropped connection
# would otherwise mean redoing the whole leg. Only for commands that are safe to repeat
# (`gh release upload --clobber` replaces what an earlier attempt uploaded).
#
# Usage: scripts/retry.sh <command> [args...]
# RETRY_ATTEMPTS (default 3) and RETRY_DELAY (seconds, default 30) tune it.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: retry.sh <command> [args...]" >&2
  exit 2
fi
max=${RETRY_ATTEMPTS:-3}
delay=${RETRY_DELAY:-30}
what="${*:1:3}"

for attempt in $(seq 1 "$max"); do
  "$@" && exit 0
  status=$?
  if [ "$attempt" -eq "$max" ]; then
    echo "::error::$what failed $max times (last exit $status)"
    exit "$status"
  fi
  echo "::warning::$what failed (exit $status, attempt $attempt of $max); retrying in ${delay}s"
  sleep "$delay"
done
