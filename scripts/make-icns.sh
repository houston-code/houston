#!/usr/bin/env bash
# Build build/icon.icns from build/icon.png using macOS tools (sips + iconutil).
# Run after scripts/make-icon.mjs. Requires macOS.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f build/icon.png ]; then
  echo "build/icon.png not found — run: node scripts/make-icon.mjs" >&2
  exit 1
fi

ICONSET=build/icon.iconset
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

for s in 16 32 128 256 512; do
  sips -z "$s" "$s" build/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z "$d" "$d" build/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o build/icon.icns
rm -rf "$ICONSET"
echo "Wrote build/icon.icns"
