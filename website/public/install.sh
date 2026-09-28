#!/bin/sh
# Houston CLI installer: https://houstoncode.ai/install.sh
#
#   curl -fsSL https://houstoncode.ai/install.sh | sh
#
# Downloads houston-cli.cjs from the latest GitHub Release, checks it against the
# release's SHA256SUMS, and installs it as `houston` in ~/.local/bin. Needs Node 22+.
#
# Environment:
#   HOUSTON_VERSION        install this version (e.g. 0.3.0) instead of the latest
#   HOUSTON_INSTALL_DIR    install here instead of ~/.local/bin
#   HOUSTON_DOWNLOAD_BASE  download from this base URL (testing and mirrors)
#
# The checksum guards against a corrupt or truncated download. For an end-to-end
# signature check, verify SHA256SUMS.asc with the project key as the README's
# "Verifying downloads" section describes.
#
# Everything runs inside main(), called on the last line, so a partially
# downloaded script does nothing.

set -eu

say() { printf '%s\n' "$*"; }
fail() { printf 'houston install: %s\n' "$*" >&2; exit 1; }

download() {
  # $1 url, $2 destination
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https,file' --proto-redir '=https' -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --https-only -O "$2" "$1"
  else
    fail "curl or wget is required."
  fi
}

# Runs inside $(...), where fail() would only exit the subshell, so main() checks for a
# hash tool up front and this never has to fail.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

main() {
  min_node=22
  command -v node >/dev/null 2>&1 \
    || fail "Node $min_node or newer is required, and node was not found. Install it from https://nodejs.org and re-run."
  node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  case "$node_major" in *[!0-9]*|'') node_major=0 ;; esac
  [ "$node_major" -ge "$min_node" ] \
    || fail "Node $min_node or newer is required (found $(node --version 2>/dev/null || echo unknown)). Upgrade Node and re-run."

  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
    || fail "sha256sum or shasum is required to verify the download."

  if [ -n "${HOUSTON_DOWNLOAD_BASE:-}" ]; then
    base=$HOUSTON_DOWNLOAD_BASE
  elif [ -n "${HOUSTON_VERSION:-}" ]; then
    case "$HOUSTON_VERSION" in
      *[!0-9.]*|'') fail "HOUSTON_VERSION must look like 0.3.0 (got: $HOUSTON_VERSION)." ;;
    esac
    base="https://github.com/houston-code/houston/releases/download/v$HOUSTON_VERSION"
  else
    base="https://github.com/houston-code/houston/releases/latest/download"
  fi

  [ -n "${HOME:-}" ] || [ -n "${HOUSTON_INSTALL_DIR:-}" ] || fail "HOME is not set; set HOUSTON_INSTALL_DIR."
  install_dir=${HOUSTON_INSTALL_DIR:-$HOME/.local/bin}

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 130' INT TERM

  say "Downloading the Houston CLI..."
  download "$base/houston-cli.cjs" "$tmp/houston-cli.cjs" || fail "download failed: $base/houston-cli.cjs"
  download "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"

  expected=$(awk '$2 == "houston-cli.cjs" || $2 == "*houston-cli.cjs" {print $1; exit}' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for houston-cli.cjs."
  actual=$(sha256_of "$tmp/houston-cli.cjs")
  [ "$expected" = "$actual" ] || fail "checksum mismatch for houston-cli.cjs (expected $expected, got $actual). Nothing was installed."

  mkdir -p "$install_dir" || fail "cannot create $install_dir."
  [ ! -d "$install_dir/houston" ] || fail "$install_dir/houston is a directory; move it aside and re-run."
  # Copy next to the target, then rename over it, so a running houston is never half-written.
  staged="$install_dir/.houston.$$"
  cp "$tmp/houston-cli.cjs" "$staged" || fail "cannot write to $install_dir."
  chmod 755 "$staged"
  mv -f "$staged" "$install_dir/houston"

  version=$("$install_dir/houston" --version 2>/dev/null || echo unknown)
  say "Installed Houston CLI $version to $install_dir/houston"

  case ":${PATH:-}:" in
    *":$install_dir:"*)
      found=$(command -v houston 2>/dev/null || true)
      if [ -n "$found" ] && [ "$found" != "$install_dir/houston" ]; then
        say ""
        say "Another houston comes first on your PATH: $found"
        say "Remove it, or put $install_dir earlier in PATH, to use this one."
      else
        say "Run: houston --help"
      fi
      ;;
    *)
      say ""
      say "$install_dir is not on your PATH. Add this line to your shell profile:"
      say "  export PATH=\"$install_dir:\$PATH\""
      say "Then run: houston --help"
      ;;
  esac
}

main "$@"
