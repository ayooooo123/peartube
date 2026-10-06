#!/bin/sh
# Build bare-kit with QuickJS instead of V8 into mobile/vendor/bare-kit:
#
#   sh mobile/bare-kit.sh [target ...]
#
# A target is an Android ABI (arm64-v8a, armeabi-v7a, x86_64, x86), giving
# android/<abi>/libbare-kit.so, or darwin, giving darwin/BareKit.framework
# for this Mac. By default it builds for what this machine can: darwin on a
# Mac, and arm64-v8a if it finds the Android NDK.
#
# On arm64 the prebuilt libbare-kit.so is 65.5 MB. About 2.5 MB of it is
# bare, bare-kit and their built-in addons; the rest is V8, its ICU data, and
# the symbol table for V8's 66,000 exported symbols. libqjs is Holepunch's
# libjs ABI on QuickJS, so bare, bare-kit and the worker's addons are
# unchanged, and libbare-kit.so is 3.9 MB. iOS keeps the V8 prebuilds
# (mobile/setup.sh).
#
# Builds are cached by the hash of this script and the patches. Needs git,
# npm, node 22.21+ or 24.9+, cmake 4+ and ninja; Xcode for darwin; and for
# Android the NDK, from ANDROID_NDK_HOME or the newest under ANDROID_HOME
# (default ~/Library/Android/sdk on a Mac, ~/Android/Sdk elsewhere).
set -eu

# bare-kit v2.5.5, the version of setup.sh's iOS prebuilds; libqjs main; and
# the libjs headers and QuickJS master that libqjs main was made against. It
# fetches those two unpinned, so they are given to CMake from here.
BARE_KIT=78230eb57194cdfb67184220c46b29ad23d8f825
LIBQJS=177194ba544c50d4ebd780bcdf7570043c8cea2c
LIBJS=19f0f5c73f24a7d8f3b95d7dd7609d5743f4adac
QUICKJS=535a7c250ff4a577ec36c3e103daab6dadeea650
# bare-kit's minSdk, and the app's (Dioxus.toml).
API=29

cd "$(dirname "$0")"
here=$PWD
case "$(uname)" in
  Darwin) cache="$HOME/Library/Caches/peartube"; sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}" ;;
  *) cache="${XDG_CACHE_HOME:-$HOME/.cache}/peartube"; sdk="${ANDROID_HOME:-$HOME/Android/Sdk}" ;;
esac
ndk="${ANDROID_NDK_HOME:-$(ls -d "$sdk"/ndk/* 2>/dev/null | sort -V | tail -n 1)}"
if [ $# -eq 0 ]; then
  if [ "$(uname)" = Darwin ]; then set -- darwin; fi
  if [ -n "$ndk" ]; then
    set -- arm64-v8a "$@"
  else
    echo "No Android NDK (ANDROID_NDK_HOME, or $sdk/ndk): not building for Android"
  fi
  if [ $# -eq 0 ]; then echo "Nothing to build: install the Android NDK, or run this on a Mac" >&2; exit 1; fi
fi
for target in "$@"; do
  case $target in
    arm64-v8a | armeabi-v7a | x86_64 | x86) ;;
    darwin) [ "$(uname)" = Darwin ] || { echo "darwin builds only on a Mac" >&2; exit 1; } ;;
    *) echo "Unknown target $target: an Android ABI or darwin" >&2; exit 1 ;;
  esac
done
key=$(cat bare-kit.sh patches/*.patch | shasum -a 256 | cut -c1-16)
out="$cache/bare-kit-qjs-$key"
work="${TMPDIR:-/tmp}/peartube-bare-kit-$key"

fetch() {
  mkdir -p "$3"
  git -C "$3" init -q
  git -C "$3" fetch -q --depth 1 "https://github.com/$1.git" "$2"
  git -C "$3" checkout -q FETCH_HEAD
}

sources() {
  [ -f "$work/src/ready" ] && return
  # bare-kit's bundler segfaults in its lexer addon under older Node.
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a === 22 && b >= 21 || a === 24 && b >= 9 || a > 24 ? 0 : 1)' ||
    { echo "Building bare-kit needs node 22.21+ or 24.9+, not $(node -v)" >&2; exit 1; }
  rm -rf "$work/src"
  fetch holepunchto/bare-kit $BARE_KIT "$work/src/bare-kit"
  fetch holepunchto/libqjs $LIBQJS "$work/src/libqjs"
  fetch holepunchto/libjs $LIBJS "$work/src/libjs"
  fetch bellard/quickjs $QUICKJS "$work/src/quickjs"
  (cd "$work/src/bare-kit" && npm ci --ignore-scripts --no-audit --no-fund --silent)
  (cd "$work/src/libqjs" && npm install --ignore-scripts --no-audit --no-fund --silent)
  (cd "$work/src/libjs" && npm install --ignore-scripts --no-audit --no-fund --silent)
  # What libqjs's own CMake would apply to QuickJS: every patch, in order.
  for patch in "$work/src/libqjs/patches/"*.patch; do
    git -C "$work/src/quickjs" apply "$patch"
  done
  git -C "$work/src/libqjs" apply "$here/patches/libqjs-function-source.patch"
  touch "$work/src/ready"
}

# build <name> <cmake flags...>: configure and build bare_kit in $work/<name>.
build() {
  name=$1
  shift
  log="$work/$name.log"
  echo "Building bare-kit on QuickJS for $name (log: $log)"
  { cmake -S "$work/src/bare-kit" -B "$work/$name" -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo \
      "-DBARE_ENGINE=github:holepunchto/libqjs#$LIBQJS" \
      "-DFETCHCONTENT_SOURCE_DIR_GITHUB+HOLEPUNCHTO+LIBQJS=$work/src/libqjs" \
      "-DFETCHCONTENT_SOURCE_DIR_GITHUB+HOLEPUNCHTO+LIBJS=$work/src/libjs" \
      "-DFETCHCONTENT_SOURCE_DIR_GITHUB+BELLARD+QUICKJS=$work/src/quickjs" \
      "$@" &&
    cmake --build "$work/$name" --target bare_kit; } >"$log" 2>&1 ||
    { tail -n 30 "$log" >&2; echo "bare-kit build failed: $log" >&2; exit 1; }
}

android() {
  case $1 in
    arm64-v8a) triple=aarch64-linux-android ;;
    armeabi-v7a) triple=arm-linux-androideabi ;;
    x86_64) triple=x86_64-linux-android ;;
    x86) triple=i686-linux-android ;;
  esac
  if [ ! -f "$out/android/$1/libbare-kit.so" ]; then
    [ -f "$ndk/build/cmake/android.toolchain.cmake" ] ||
      { echo "Building for $1 needs the Android NDK: set ANDROID_NDK_HOME, or install it under $sdk/ndk" >&2; exit 1; }
    sources
    llvm=$(echo "$ndk"/toolchains/llvm/prebuilt/*)
    build "android-$1" "-DCMAKE_TOOLCHAIN_FILE=$ndk/build/cmake/android.toolchain.cmake" \
      "-DANDROID_ABI=$1" "-DANDROID_PLATFORM=android-$API" -DANDROID_STL=c++_shared
    mkdir -p "$out/android/$1.part"
    # The NDK's libc++_shared.so carries 8 MB of debug info.
    for lib in "$work/android-$1/android/libbare-kit.so" "$llvm/sysroot/usr/lib/$triple/libc++_shared.so"; do
      "$llvm/bin/llvm-strip" --strip-unneeded -o "$out/android/$1.part/${lib##*/}" "$lib"
    done
    mv "$out/android/$1.part" "$out/android/$1"
  fi
  mkdir -p vendor/bare-kit/android
  rm -rf "vendor/bare-kit/android/$1"
  cp -R "$out/android/$1" "vendor/bare-kit/android/$1"
}

darwin() {
  arch=$(uname -m)
  if [ ! -d "$out/darwin-$arch/BareKit.framework" ]; then
    sources
    build "darwin-$arch" "-DCMAKE_OSX_ARCHITECTURES=$arch" -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0
    mkdir -p "$out/darwin-$arch.part"
    cp -R "$work/darwin-$arch/apple/BareKit.framework" "$out/darwin-$arch.part/"
    mv "$out/darwin-$arch.part" "$out/darwin-$arch"
  fi
  mkdir -p vendor/bare-kit/darwin
  rm -rf vendor/bare-kit/darwin/BareKit.framework
  cp -R "$out/darwin-$arch/BareKit.framework" vendor/bare-kit/darwin/
}

for target in "$@"; do
  case $target in
    darwin) darwin ;;
    *) android "$target" ;;
  esac
done
# Only the outputs are kept; sources and build trees are ~1 GB per target.
rm -rf "$work"
echo "bare-kit on QuickJS in mobile/vendor/bare-kit: $*"
