#!/bin/bash
# Build all native addons for iOS (device + simulator)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$MOBILE_DIR")")"
DEVICE_DIR="$MOBILE_DIR/prebuilds"
SIM_DIR="$MOBILE_DIR/prebuilds-sim"

# Clean previous builds
rm -rf "$DEVICE_DIR" "$SIM_DIR"
mkdir -p "$DEVICE_DIR" "$SIM_DIR"

# List of native addons to build
ADDONS=(
    "sodium-native"
    "rocksdb-native"
    "udx-native"
    "bare-fs"
    "bare-os"
    "bare-url"
    "bare-pipe"
    "bare-tcp"
    "bare-dns"
    "bare-tty"
    "bare-crypto"
    "bare-signals"
    "bare-hrtime"
    "bare-type"
    "bare-buffer"
    "bare-subprocess"
    "bare-inspect"
    "quickbit-native"
    "simdle-native"
    "crc-native"
)

echo "Building native addons for iOS..."

for addon in "${ADDONS[@]}"; do
    addon_path="$ROOT_DIR/node_modules/$addon"
    if [ -d "$addon_path" ]; then
        echo "Building $addon for ios-arm64..."
        npx bare-link --target ios-arm64 -o "$DEVICE_DIR" "$addon_path" 2>/dev/null || echo "  Warning: Failed to build $addon for device"

        echo "Building $addon for ios-arm64-simulator..."
        npx bare-link --target ios-arm64-simulator -o "$SIM_DIR" "$addon_path" 2>/dev/null || echo "  Warning: Failed to build $addon for simulator"
    else
        echo "Skipping $addon (not found)"
    fi
done

echo ""
echo "Device frameworks:"
ls "$DEVICE_DIR"/*.framework 2>/dev/null | xargs -I{} basename {} || echo "  None"

echo ""
echo "Simulator frameworks:"
ls "$SIM_DIR"/*.framework 2>/dev/null | xargs -I{} basename {} || echo "  None"

echo ""
echo "Now run: ./scripts/create-xcframeworks.sh"
