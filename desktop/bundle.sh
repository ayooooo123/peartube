#!/bin/sh
# Builds PearTube.app into desktop/target/release: the release binary, with
# BareKit and the worklet's native addons in Contents/Frameworks, signed ad hoc.
#
#   sh desktop/bundle.sh          build it and print its path
#   sh desktop/bundle.sh --open   and open it
#   sh desktop/bundle.sh --zip    and zip it for a release, beside the app:
#                                 PearTube-<version>-macos-<arch>.zip
#
# Needs `npm ci` at the repo root and `sh worklet/bare-kit.sh darwin` once.
set -eu
cd "$(dirname "$0")"
version=$(node -p 'require("../package.json").version')
host=darwin-$(uname -m | sed 's/x86_64/x64/')

receiver=0
action=""
for arg in "$@"; do
  case "$arg" in
    --receiver) receiver=1 ;;
    --open|--zip) action="$arg" ;;
  esac
done

if [ "$receiver" = "1" ]; then
  exe="PearTubeReceiver"
  bundle_id="com.peartube.receiver"
  bundle_name="PearTube Receiver"
else
  exe="PearTube"
  bundle_id="com.peartube.app"
  bundle_name="PearTube"
fi

# Panic messages name source files; write this machine's home directory as ~.
CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build --release --bin "$exe"

app="target/release/$exe.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Frameworks"
cp "target/release/$exe" "$app/Contents/MacOS/"
cp -R ../worklet/vendor/bare-kit/darwin/BareKit.framework "target/bare-addons/$host/"*.framework "$app/Contents/Frameworks/"
# Strip unsealed C headers from the embedded macOS framework root before codesign seals her tight.
rm -rf "$app/Contents/Frameworks/BareKit.framework/Headers"
# The bundle loads its frameworks from Contents/Frameworks only: drop the
# build's absolute rpaths, as the binary records them.
bin="$app/Contents/MacOS/$exe"
otool -l "$bin" | sed -n 's/^ *path \(.*\) (offset [0-9]*)$/\1/p' | grep -v '^@' | while IFS= read -r rpath; do
  install_name_tool -delete_rpath "$rpath" "$bin"
done
# LSMinimumSystemVersion: the worklet's addon frameworks (rocksdb-native,
# udx-native, …) are built for macOS 13, so the app cannot load on older ones.
url_types=""
if [ "$receiver" = "0" ]; then
  url_types="  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>com.peartube.uri</string>
      <key>CFBundleURLSchemes</key><array><string>peartube</string></array>
    </dict>
  </array>"
fi
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>$exe</string>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleName</key><string>$bundle_name</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSLocalNetworkUsageDescription</key><string>PearTube connects directly to peers on your network.</string>
$url_types
</dict>
</plist>
EOF
codesign --force --sign - --timestamp=none "$app/Contents/Frameworks/"*.framework
codesign --force --sign - --timestamp=none "$app"

if [ "$action" = "--open" ]; then open "$app"; fi
if [ "$action" = "--zip" ]; then
  zip="target/release/$exe-$version-macos-$(uname -m).zip"
  rm -f "$zip"
  # ditto keeps the bundle's symlinks and signatures, which zip(1) breaks.
  ditto -c -k --keepParent "$app" "$zip"
  echo "$zip"
fi
echo "$app"
