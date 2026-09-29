#!/bin/sh
# Build the iOS app with dx, then add what dx leaves out: BareKit and the
# worker's native addons, which Bare loads as frameworks at run time.
#
#   sh mobile/ios.sh             debug build for the simulator, installed and
#                                launched on the booted simulator
#   sh mobile/ios.sh --release   the same, release build
#
# A device build needs IOS_TARGET=aarch64-apple-ios and IOS_IDENTITY set to
# the signing identity dx used; it is built and signed, not installed.
set -eu
cd "$(dirname "$0")"

profile=debug
release=
if [ "${1:-}" = "--release" ]; then profile=release; release=--release; fi

target="${IOS_TARGET:-aarch64-apple-ios-sim}"
case "$target" in
  aarch64-apple-ios-sim) host=ios-arm64-simulator; slice=ios-arm64_x86_64-simulator; identity=- ;;
  aarch64-apple-ios) host=ios-arm64; slice=ios-arm64; identity="${IOS_IDENTITY:?set IOS_IDENTITY for a device build}" ;;
  *) echo "Unsupported IOS_TARGET $target" >&2; exit 1 ;;
esac

dx build --ios --target "$target" $release

app="target/dx/PearTube/$profile/ios/PearTube.app"
# dx only puts .dylib link inputs here, and this app has none.
rm -rf "$app/Frameworks"
mkdir -p "$app/Frameworks"
cp -R "vendor/bare-kit/ios/BareKit.xcframework/$slice/BareKit.framework" "$app/Frameworks/"
cp -R "target/bare-addons/$host/"*.framework "$app/Frameworks/"
for framework in "$app/Frameworks/"*.framework; do
  codesign --force --sign "$identity" --timestamp=none "$framework"
done
codesign --force --sign "$identity" --timestamp=none --preserve-metadata=entitlements "$app"

if [ "$identity" = - ]; then
  xcrun simctl install booted "$app"
  xcrun simctl launch booted com.peartube.app
fi
echo "$app"
