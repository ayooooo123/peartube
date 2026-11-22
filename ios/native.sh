#!/bin/sh
# Builds the P2P backend (peartube-native-ffi) for both iOS slices and packs them as
# ios/build/native/PearTubeNative.xcframework, with peartube_native.h as a module map.
# The app links the static library; there is no worklet or addon framework to embed.
set -eu
cd "$(dirname "$0")/.."
root=$PWD
stack=${PEARTUBE_NATIVE:?Set PEARTUBE_NATIVE to the parent of the pinned engine and its sibling crates}
out=$root/ios/build/native
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$root/ios/build/cargo-native}
export IPHONEOS_DEPLOYMENT_TARGET=17.0
cd "$stack/peartube-native"
for triple in aarch64-apple-ios aarch64-apple-ios-sim; do
  cargo build --locked -p peartube-native-ffi --target "$triple" --release
done
cd "$root"
headers=$out/Headers
mkdir -p "$headers"
cp "$stack/peartube-native/ffi/include/peartube_native.h" "$headers/"
cat > "$headers/module.modulemap" <<'EOF'
module PearTubeNative {
  header "peartube_native.h"
  export *
}
EOF
rm -rf "$out/PearTubeNative.xcframework"
xcodebuild -create-xcframework \
  -library "$CARGO_TARGET_DIR/aarch64-apple-ios/release/libpeartube_native_ffi.a" -headers "$headers" \
  -library "$CARGO_TARGET_DIR/aarch64-apple-ios-sim/release/libpeartube_native_ffi.a" -headers "$headers" \
  -output "$out/PearTubeNative.xcframework"
echo "Built $out/PearTubeNative.xcframework"
