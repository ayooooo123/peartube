#!/bin/sh
# Put bare-kit into mobile/vendor, built on QuickJS by mobile/bare-kit.sh for
# the targets given (sh mobile/setup.sh darwin) or else for what this machine
# can build: Android if it has the NDK, macOS on a Mac. On a Mac it also adds
# the prebuilt iOS framework from bare-kit's release. That archive is ~420 MB,
# so it is downloaded once into a cache.
set -eu

VERSION=2.5.5
SHA256=fc68740347c8532ba49d45bf61fae9ca1f1040dc7d6c99f2f92dc30c40e84e46

cd "$(dirname "$0")"
rm -rf vendor/bare-kit
mkdir -p vendor/bare-kit
if [ "$(uname)" = Darwin ]; then
  cache="$HOME/Library/Caches/peartube"
  zip="$cache/bare-kit-v$VERSION.zip"
  if [ ! -f "$zip" ]; then
    mkdir -p "$cache"
    curl -fL --retry 3 -o "$zip.part" "https://github.com/holepunchto/bare-kit/releases/download/v$VERSION/prebuilds.zip"
    mv "$zip.part" "$zip"
  fi
  echo "$SHA256  $zip" | shasum -a 256 -c - || { rm -f "$zip"; echo "Checksum mismatch: removed $zip, run again" >&2; exit 1; }
  unzip -q "$zip" 'ios/BareKit.xcframework/*' -d vendor/bare-kit
  echo "bare-kit v$VERSION iOS prebuilds in mobile/vendor/bare-kit"
fi
sh bare-kit.sh "$@"
