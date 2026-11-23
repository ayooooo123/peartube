#!/bin/sh
# Build an unsigned IPA, or export an already signed iPhone product for AltStore/SideStore.
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -gt 1 ]; then
  echo "Usage: sh ios/package.sh [path/to/signed/PearTube.app]" >&2
  exit 2
fi
if [ "$#" -eq 1 ]; then
  app=$1
  [ "$(plutil -extract CFBundleIdentifier raw -o - "$app/Info.plist")" = com.peartube.app.dev ]
  [ "$(plutil -extract DTPlatformName raw -o - "$app/Info.plist")" = iphoneos ]
  codesign --verify --deep --strict "$app"
else
  node ios/project.mjs
  xcodebuild -project ios/PearTube.xcodeproj -scheme PearTube \
    -configuration Release -destination 'generic/platform=iOS' \
    -derivedDataPath ios/build/device CODE_SIGNING_ALLOWED=NO build
  app=ios/build/device/Build/Products/Release-iphoneos/PearTube.app
fi
stage=ios/build/ipa
mkdir -p "$stage/Payload"
rm -rf "$stage/Payload/PearTube.app"
ditto --norsrc --noextattr "$app" "$stage/Payload/PearTube.app"
if [ "$#" -eq 1 ]; then
  rm -f "$stage/Payload/PearTube.app/embedded.mobileprovision"
  codesign --remove-signature "$stage/Payload/PearTube.app"
else
  xcrun strip -S "$stage/Payload/PearTube.app/PearTube"
fi
version=$(node -p "require('./package.json').version")
ipa="$PWD/ios/build/PearTube-$version-ios-arm64.ipa"
rm -f "$ipa"
(cd "$stage" && COPYFILE_DISABLE=1 ditto -c -k --norsrc --noextattr --keepParent Payload "$ipa")
echo "$ipa"
