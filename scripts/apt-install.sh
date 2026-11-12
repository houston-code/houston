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
#   - With APT_DEB_CACHE set, the .deb files apt downloads are kept in that directory, which
#     the workflow saves with actions/cache. A later run installs straight from them with
#     dpkg and never contacts a mirror, so a mirror outage (every mirror unresolvable for the
#     whole retry budget has happened) no longer fails the job.
#
# Env: APT_DEB_CACHE is the directory of cached .deb files (unset: no caching).
# APT_DEB_CACHE_FRESH=true says they were saved on this same runner image, so they are
# installed without trying apt. Otherwise they are a fallback: apt gets one attempt (so a new
# image picks up current packages), and the cached files are used only if that fails.
# APT_ATTEMPTS (default 3), APT_RETRY_DELAY seconds (default 10) and APT_TIMEOUT seconds
# per apt call (default 75) tune it. The defaults cap the worst case (every call timing out on
# every attempt) near 8 minutes, inside the 15-minute timeout of the jobs that use this.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: apt-install.sh <package> [package...]" >&2
  exit 2
fi
cache=${APT_DEB_CACHE:-}
fresh=${APT_DEB_CACHE_FRESH:-false}
max=${APT_ATTEMPTS:-3}
delay=${APT_RETRY_DELAY:-10}
limit=${APT_TIMEOUT:-75}

missing=()
find_missing() {
  missing=()
  local pkg status
  for pkg in "$@"; do
    status=$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null || true)
    [ "$status" = installed ] || missing+=("$pkg")
  done
}
find_missing "$@"
if [ "${#missing[@]}" -eq 0 ]; then
  echo "Already installed: $*"
  exit 0
fi

have_cached_debs() { [ -n "$cache" ] && compgen -G "$cache/*.deb" >/dev/null; }

# Installs every cached .deb in one dpkg call (they are one apt transaction's downloads, so
# they satisfy each other's dependencies), then checks the requested packages really landed.
install_from_cache() {
  timeout -k 10 "$limit" sudo env DEBIAN_FRONTEND=noninteractive dpkg -i "$cache"/*.deb || return 1
  find_missing "$@"
  [ "${#missing[@]}" -eq 0 ]
}

if have_cached_debs && [ "$fresh" = true ]; then
  if install_from_cache "$@"; then
    echo "Installed from the cached packages, without contacting a mirror: $*"
    exit 0
  fi
  echo "::warning::installing the cached packages failed; falling back to apt-get"
  find_missing "$@"
  if [ "${#missing[@]}" -eq 0 ]; then missing=("$@"); fi
fi

# apt downloads into a staging directory, so the cache only ever holds one complete,
# successful transaction and a failed attempt cannot mix versions into it.
stage=
archives=()
if [ -n "$cache" ]; then
  stage=$(mktemp -d)
  sudo mkdir -p "$stage/partial"
  archives=(-o "Dir::Cache::Archives=$stage")
  # A usable fallback is on disk: don't spend the whole retry budget on a dead mirror.
  if have_cached_debs; then max=1; fi
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
  status=0
  apt install -y ${archives[@]+"${archives[@]}"} "${missing[@]}" || status=$?
  if [ "$status" -eq 0 ]; then
    if [ -n "$cache" ] && compgen -G "$stage/*.deb" >/dev/null; then
      mkdir -p "$cache"
      rm -f "$cache"/*.deb
      cp "$stage"/*.deb "$cache"/
    fi
    exit 0
  fi
  if [ "$attempt" -eq "$max" ]; then
    if have_cached_debs; then
      echo "::warning::apt-get install ${missing[*]} failed (exit $status); installing the cached packages instead"
      if install_from_cache "$@"; then
        # Not saved again: the next run on this image should retry apt for current packages.
        rm -rf "$cache"
        exit 0
      fi
    fi
    echo "::error::apt-get install ${missing[*]} failed $max times (last exit $status)"
    exit "$status"
  fi
  echo "::warning::apt-get install ${missing[*]} failed (exit $status, attempt $attempt of $max); retrying in ${delay}s"
  sleep "$delay"
done
