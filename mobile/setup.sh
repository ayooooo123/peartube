#!/bin/sh
# Fetch bare-kit's prebuilt runtime (Android, iOS, macOS) into mobile/vendor.
# The release archive is ~420 MB, so it is downloaded once into a cache.
set -eu

VERSION=2.5.5
SHA256=fc68740347c8532ba49d45bf61fae9ca1f1040dc7d6c99f2f92dc30c40e84e46

cd "$(dirname "$0")"
case "$(uname)" in
  Darwin) cache="$HOME/Library/Caches/peartube" ;;
  *) cache="${XDG_CACHE_HOME:-$HOME/.cache}/peartube" ;;
esac
zip="$cache/bare-kit-v$VERSION.zip"

if [ ! -f "$zip" ]; then
  mkdir -p "$cache"
  curl -fL --retry 3 -o "$zip.part" "https://github.com/holepunchto/bare-kit/releases/download/v$VERSION/prebuilds.zip"
  mv "$zip.part" "$zip"
fi
echo "$SHA256  $zip" | shasum -a 256 -c - || { rm -f "$zip"; echo "Checksum mismatch: removed $zip, run again" >&2; exit 1; }

rm -rf vendor/bare-kit
mkdir -p vendor/bare-kit
unzip -q "$zip" 'android/bare-kit/jni/*' 'ios/BareKit.xcframework/*' 'darwin/BareKit.xcframework/*' -d vendor/bare-kit
echo "bare-kit v$VERSION in mobile/vendor/bare-kit"
