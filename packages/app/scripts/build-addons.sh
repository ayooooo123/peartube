#!/bin/bash
# Link the Bare native addons this app depends on, for iOS device + simulator.
#
# bare-link walks the dependency graph from packages/app and emits a framework
# for every package marked `"addon": true`, so there is no addon list to keep in
# sync here. Output lands in prebuilds/ and prebuilds-sim/; create-xcframeworks.sh
# then pairs them up and keeps only the addons the packed bare bundles link.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(dirname "$SCRIPT_DIR")"
DEVICE_DIR="$MOBILE_DIR/prebuilds"
SIM_DIR="$MOBILE_DIR/prebuilds-sim"

rm -rf "$DEVICE_DIR" "$SIM_DIR"
mkdir -p "$DEVICE_DIR" "$SIM_DIR"

echo "Linking Bare addons for ios-arm64..."
npx bare-link --host ios-arm64 --out "$DEVICE_DIR" "$MOBILE_DIR"

echo "Linking Bare addons for ios-arm64-simulator..."
npx bare-link --host ios-arm64-simulator --out "$SIM_DIR" "$MOBILE_DIR"

count_frameworks() {
    find "$1" -maxdepth 1 -name '*.framework' -print 2>/dev/null | wc -l | tr -d ' '
}

echo ""
echo "Device frameworks ($(count_frameworks "$DEVICE_DIR")):"
find "$DEVICE_DIR" -maxdepth 1 -name '*.framework' -exec basename {} \; 2>/dev/null | sort

echo ""
echo "Simulator frameworks ($(count_frameworks "$SIM_DIR")):"
find "$SIM_DIR" -maxdepth 1 -name '*.framework' -exec basename {} \; 2>/dev/null | sort

echo ""
echo "Now run: ./scripts/create-xcframeworks.sh"
