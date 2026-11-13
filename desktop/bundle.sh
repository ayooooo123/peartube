#!/bin/sh
# Builds PearTube.app into desktop/target/release: the release binary, with the
# P2P engine beside it in Contents/Frameworks, signed ad hoc.
#
#   sh desktop/bundle.sh          build it and print its path
#   sh desktop/bundle.sh --open   and open it
#   sh desktop/bundle.sh --zip    and zip it for a release, beside the app:
#                                 PearTube-<version>-macos-<arch>.zip
#   sh desktop/bundle.sh --engine rust   build it with the Rust engine
#   sh desktop/bundle.sh --engine both --zip   build both JS and Rust release zips
# --engine picks the P2P engine: js (the Bare worklet: BareKit and its addon
# frameworks) or rust (the pinned peartube-native dylib). The default is
# native.lock's engine.desktop.
#
# The js engine needs `npm ci` at the repo root and `sh worklet/bare-kit.sh
# darwin` once; the rust engine needs sync-native.py's fetch, which cargo runs
# as part of the build.
set -eu
cd "$(dirname "$0")"
version=$(node -p 'require("../package.json").version')
host=darwin-$(uname -m | sed 's/x86_64/x64/')

engine="${PEARTUBE_ENGINE:-}"
receiver=0
action=""
self="$0"
while [ $# -gt 0 ]; do
  case "$1" in
    --receiver) receiver=1 ;;
    --open|--zip) action="$1" ;;
    --engine)
      shift
      [ $# -gt 0 ] || { echo "--engine needs js, rust or both" >&2; exit 2; }
      engine="$1" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$engine" ] || engine=$(node -p 'require("../native.lock").engine.desktop')
if [ "$engine" = "both" ]; then
  [ "$action" != "--open" ] || { echo "--open cannot open both engines at once" >&2; exit 2; }
  rec_arg=""
  [ "$receiver" = "1" ] && rec_arg="--receiver"
  sh "$self" $rec_arg --engine js ${action:+"$action"}
  sh "$self" $rec_arg --engine rust ${action:+"$action"}
  exit 0
fi
case "$engine" in
  js|rust) ;;
  *) echo "--engine must be js, rust or both, not $engine" >&2; exit 2 ;;
esac

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
rustflags="--remap-path-prefix=$HOME=~"
if [ "$engine" = "rust" ]; then
  CARGO_ENCODED_RUSTFLAGS="$rustflags" cargo build --release --bin "$exe" --features engine-rust
else
  CARGO_ENCODED_RUSTFLAGS="$rustflags" cargo build --release --bin "$exe"
fi

stage="target/release/bundle-$engine"
app="$stage/$exe.app"
rm -rf "$stage"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Frameworks"
cp "target/release/$exe" "$app/Contents/MacOS/"
if [ "$engine" = "rust" ]; then
  # build.rs staged the library the build linked (pinned, or the local checkout).
  lib="target/native/$host/libpeartube_native_ffi.dylib"
  [ -f "$lib" ] || { echo "$lib is missing: the rust build staged no library" >&2; exit 1; }
  cp "$lib" "$app/Contents/Frameworks/"
else
  cp -R ../worklet/vendor/bare-kit/darwin/BareKit.framework "target/bare-addons/$host/"*.framework "$app/Contents/Frameworks/"
  # bare-kit 3 builds BareKit.framework with a real Headers directory at its
  # root, which codesign refuses to seal in an embedded framework. The app
  # loads no headers at run time.
  rm -rf "$app/Contents/Frameworks/BareKit.framework/Headers"
fi
# The bundle loads its frameworks from Contents/Frameworks only: drop the
# build's absolute rpaths, as the binary records them.
bin="$app/Contents/MacOS/$exe"
otool -l "$bin" | sed -n 's/^ *path \(.*\) (offset [0-9]*)$/\1/p' | grep -v '^@' | while IFS= read -r rpath; do
  install_name_tool -delete_rpath "$rpath" "$bin"
done
# LSMinimumSystemVersion: the app's libraries are built for macOS 13, so it
# cannot load on older ones.
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
if [ "$engine" = "rust" ]; then
  codesign --force --sign - --timestamp=none "$app/Contents/Frameworks/libpeartube_native_ffi.dylib"
else
  codesign --force --sign - --timestamp=none "$app/Contents/Frameworks/"*.framework
fi
codesign --force --sign - --timestamp=none "$app"
rm -rf "target/release/$exe.app"
ditto "$app" "target/release/$exe.app"

if [ "$action" = "--open" ]; then open "target/release/$exe.app"; fi
if [ "$action" = "--zip" ]; then
  suffix=""
  [ "$engine" = "rust" ] && suffix="-rust"
  zip="target/release/$exe-$version$suffix-macos-$(uname -m).zip"
  rm -f "$zip"
  # ditto keeps the bundle's symlinks and signatures, which zip(1) breaks.
  ditto -c -k --keepParent "$app" "$zip"
  echo "$zip"
fi
echo "target/release/$exe.app"
