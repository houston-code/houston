#!/usr/bin/env bash
# Install apt packages on a CI runner without letting a stalled mirror hang the job.
# Used by ci.yml's `linux-sandbox` and `package` jobs.
#
# Usage: scripts/apt-install.sh <package> [package...]
#
# Why: a bare `sudo apt-get update` has no overall deadline. When the runner's Ubuntu mirror
# stops answering mid-download, apt waits on the open connection until the job's own timeout
# cancels it, which fails a required check without a single test having run.
#
# What this does instead:
#   - Packages already on the runner image are not fetched at all.
#   - Each apt call gets per-connection timeouts and a hard wall-clock limit, so a stall
#     ends in seconds or minutes rather than at the job timeout.
#   - A failed or timed-out attempt is retried. `apt-get update` failing is not fatal on its
#     own: the install still runs against whatever package lists the runner has.
#
# Env: APT_ATTEMPTS (default 3), APT_RETRY_DELAY seconds (default 10) and APT_TIMEOUT seconds
# per apt call (default 120) tune it.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: apt-install.sh <package> [package...]" >&2
  exit 2
fi
max=${APT_ATTEMPTS:-3}
delay=${APT_RETRY_DELAY:-10}
limit=${APT_TIMEOUT:-120}

missing=()
for pkg in "$@"; do
  status=$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null || true)
  [ "$status" = installed ] || missing+=("$pkg")
done
if [ "${#missing[@]}" -eq 0 ]; then
  echo "Already installed: $*"
  exit 0
fi

# -k: a process that ignores the first signal is killed 10s later.
apt() {
  timeout -k 10 "$limit" sudo env DEBIAN_FRONTEND=noninteractive apt-get \
    -o Acquire::Retries=2 \
    -o Acquire::http::Timeout=20 \
    -o Acquire::https::Timeout=20 \
    -o DPkg::Lock::Timeout=60 \
    "$@"
}

for attempt in $(seq 1 "$max"); do
  apt update || echo "::warning::apt-get update failed or timed out (exit $?); installing from the existing package lists"
  apt install -y "${missing[@]}" && exit 0
  status=$?
  if [ "$attempt" -eq "$max" ]; then
    echo "::error::apt-get install ${missing[*]} failed $max times (last exit $status)"
    exit "$status"
  fi
  echo "::warning::apt-get install ${missing[*]} failed (exit $status, attempt $attempt of $max); retrying in ${delay}s"
  sleep "$delay"
done
