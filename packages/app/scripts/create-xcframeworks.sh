#!/bin/bash
# Create XCFrameworks from device and simulator frameworks

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(dirname "$SCRIPT_DIR")"
DEVICE_DIR="$MOBILE_DIR/prebuilds"
SIM_DIR="$MOBILE_DIR/prebuilds-sim"
OUTPUT_DIR="$MOBILE_DIR/Frameworks"
BARE_KIT_ADDONS_DIR="$MOBILE_DIR/node_modules/react-native-bare-kit/ios/addons"

# Build a skip list for frameworks already bundled by react-native-bare-kit.
declare -A SKIP_FRAMEWORKS
if [ -d "$BARE_KIT_ADDONS_DIR" ]; then
    for addon_path in "$BARE_KIT_ADDONS_DIR"/*.xcframework; do
        if [ -d "$addon_path" ]; then
            addon_name=$(basename "$addon_path" .xcframework)
            SKIP_FRAMEWORKS["$addon_name"]=1
        fi
    done
fi

# Clean output
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# Get list of frameworks from device prebuilds
for framework_path in "$DEVICE_DIR"/*.framework; do
    if [ -d "$framework_path" ]; then
        framework_name=$(basename "$framework_path")
        name_without_ext="${framework_name%.framework}"

        # Get the binary name (same as framework name without .framework)
        device_binary="$DEVICE_DIR/$framework_name/$name_without_ext"
        sim_binary="$SIM_DIR/$framework_name/$name_without_ext"

        if [ -n "${SKIP_FRAMEWORKS[$name_without_ext]:-}" ]; then
            echo "Skipping $name_without_ext (already provided by react-native-bare-kit)"
            continue
        fi

        if [ -f "$device_binary" ] && [ -f "$sim_binary" ]; then
            echo "Creating XCFramework for $name_without_ext..."

            xcodebuild -create-xcframework \
                -framework "$DEVICE_DIR/$framework_name" \
                -framework "$SIM_DIR/$framework_name" \
                -output "$OUTPUT_DIR/$name_without_ext.xcframework"

            echo "Created $OUTPUT_DIR/$name_without_ext.xcframework"
        else
            echo "Warning: Missing binary for $framework_name"
            echo "  Device: $device_binary exists: $([ -f "$device_binary" ] && echo yes || echo no)"
            echo "  Sim: $sim_binary exists: $([ -f "$sim_binary" ] && echo yes || echo no)"
        fi
    fi
done

echo "Done! XCFrameworks created in $OUTPUT_DIR"
