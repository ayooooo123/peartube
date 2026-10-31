#!/bin/sh
# Build bare-kit with QuickJS instead of V8 into worklet/vendor/bare-kit:
#
#   sh worklet/bare-kit.sh [target ...]
#
# A target is an Android ABI (arm64-v8a, armeabi-v7a, x86_64, x86), giving
# android/<abi>/libbare-kit.so; darwin, giving darwin/BareKit.framework for
# this Mac; or ios-arm64 / ios-arm64-simulator, giving <target>/BareKit.framework
# (Xcode required). By default it builds for what this machine can: darwin on a
# Mac, and arm64-v8a if it finds the Android NDK.
#
# bare-kit 3 is a C library; its language bindings live in their own repos and
# build the native library their wrappers load. This builds those same CMake
# projects, with QuickJS as the engine:
#   - Android: bare-kit-kotlin's libbare-kit.so (bare-kit plus the JNI bridge
#     its Kotlin Worklet/Ipc call). The Kotlin sources are vendored in
#     android/app/src/main/java/to/holepunch/bare/kit at BARE_KIT_KOTLIN.
#   - Apple: bare-kit-swift's BareKit.framework (bare-kit with bare-kit.h in
#     Headers). The iOS app vendors the Swift sources (ios/Runtime/BareKit) at
#     BARE_KIT_SWIFT; the Mac app calls the C API from Rust.
#
# On arm64 the prebuilt libbare-kit.so is 65.5 MB. About 2.5 MB of it is
# bare, bare-kit and their built-in addons; the rest is V8, its ICU data, and
# the symbol table for V8's 66,000 exported symbols. libqjs is Holepunch's
# libjs ABI on QuickJS, so bare, bare-kit and the worker's addons are
# unchanged, and libbare-kit.so is a few MB.
#
# Builds are cached by the hash of this script and the patches. Needs git,
# npm, node 22.21+ or 24.9+, cmake 4+ and ninja; Xcode for darwin; and for
# Android the NDK, from ANDROID_NDK_HOME or the newest under ANDROID_HOME
# (default ~/Library/Android/sdk on a Mac, ~/Android/Sdk elsewhere).
set -eu

# bare-kit-kotlin v0.1.2 and bare-kit-swift v2.0.0, which fetch bare-kit v3.0.1
# themselves; libqjs main, and the libjs headers and QuickJS master that libqjs
# main was made against. libqjs fetches those two unpinned, so they are given to
# CMake from here.
BARE_KIT_KOTLIN=c3760e36630c5f5edf841f638b63a17fddb8534a
BARE_KIT_SWIFT=07327df3bdb49b2bfa2c0872756e876129ebcda0
LIBQJS=348141095737bed3a7da01c5b5756e84904ffb5f
LIBJS=a2249688df3c36b928477539c6e2bf3e08c711bc
QUICKJS=19d6bd865e709e2b5717fb4f2290c0cecc57ee4b
# bare-kit's minSdk, and the Android app's (android/app/build.gradle.kts).
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
    darwin | ios-arm64 | ios-arm64-simulator) [ "$(uname)" = Darwin ] || { echo "$target builds only on a Mac" >&2; exit 1; } ;;
    *) echo "Unknown target $target: an Android ABI, darwin, ios-arm64, or ios-arm64-simulator" >&2; exit 1 ;;
  esac
done
key=$( { cat bare-kit.sh patches/*.patch; echo "$BARE_KIT_KOTLIN $BARE_KIT_SWIFT $LIBQJS $LIBJS $QUICKJS"; } | shasum -a 256 | cut -c1-16)
out="$cache/bare-kit-qjs-$key"
# Not $TMPDIR: the build path ends up in the libraries (C __FILE__ strings,
# and the module paths of bare's embedded JS bundle), and on a Mac $TMPDIR is
# a per-user folder under /var/folders. /tmp names no machine or user. Its
# resolved path, though: on a Mac /tmp links to /private/tmp, and bare-kit's
# bundler makes its paths relative to the resolved working directory, so a
# /tmp source tree gives /../../… paths the worklet's bootstrap can't load
# (MODULE_NOT_FOUND for src/worklet.js).
work="$(cd /tmp && pwd -P)/peartube-bare-kit-$key"

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
  fetch holepunchto/bare-kit-kotlin $BARE_KIT_KOTLIN "$work/src/bare-kit-kotlin"
  fetch holepunchto/bare-kit-swift $BARE_KIT_SWIFT "$work/src/bare-kit-swift"
  fetch holepunchto/libqjs $LIBQJS "$work/src/libqjs"
  fetch holepunchto/libjs $LIBJS "$work/src/libjs"
  fetch bellard/quickjs $QUICKJS "$work/src/quickjs"
  for dir in bare-kit-kotlin bare-kit-swift libqjs libjs; do
    (cd "$work/src/$dir" && npm install --ignore-scripts --no-audit --no-fund --silent)
  done
  # What libqjs's own CMake would apply to QuickJS: every patch, in order.
  for patch in "$work/src/libqjs/patches/"*.patch; do
    git -C "$work/src/quickjs" apply "$patch"
  done
  for patch in function-source deferred-release; do
    git -C "$work/src/libqjs" apply "$here/patches/libqjs-$patch.patch"
  done
  touch "$work/src/ready"
}

# build <binding> <target> <name> <cmake flags...>: configure the binding's
# CMake project in $work/<name> and build its library target.
build() {
  binding=$1
  target=$2
  name=$3
  shift 3
  log="$work/$name.log"
  echo "Building bare-kit on QuickJS for $name (log: $log)"
  { cmake -S "$work/src/$binding" -B "$work/$name" -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo \
      "-DCMAKE_C_FLAGS=-I$work/$name/_deps/github+libuv+libuv-src/include" \
      "-DBARE_ENGINE=github:holepunchto/libqjs#$LIBQJS" \
      "-DFETCHCONTENT_SOURCE_DIR_GITHUB+HOLEPUNCHTO+LIBQJS=$work/src/libqjs" \
      "-DFETCHCONTENT_SOURCE_DIR_GITHUB+HOLEPUNCHTO+LIBJS=$work/src/libjs" \
      "-DFETCHCONTENT_SOURCE_DIR_GITHUB+BELLARD+QUICKJS=$work/src/quickjs" \
      "$@" &&
    cmake --build "$work/$name" --target "$target"; } >"$log" 2>&1 ||
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
    build bare-kit-kotlin bare_kit_kotlin "android-$1" "-DCMAKE_TOOLCHAIN_FILE=$ndk/build/cmake/android.toolchain.cmake" \
      "-DANDROID_ABI=$1" "-DANDROID_PLATFORM=android-$API"
    mkdir -p "$out/android/$1.part"
    # libbare-kit.so links libc++ statically (bare-kit-kotlin's choice); the
    # worker's addons still load libc++_shared.so. The NDK's copy carries 8 MB
    # of debug info.
    for lib in "$work/android-$1/libbare-kit.so" "$llvm/sysroot/usr/lib/$triple/libc++_shared.so"; do
      "$llvm/bin/llvm-strip" --strip-unneeded -o "$out/android/$1.part/${lib##*/}" "$lib"
    done
    mv "$out/android/$1.part" "$out/android/$1"
  fi
  mkdir -p vendor/bare-kit/android
  rm -rf "vendor/bare-kit/android/$1"
  cp -R "$out/android/$1" "vendor/bare-kit/android/$1"
}

# apple <name> <cmake flags...>: bare-kit-swift's BareKit.framework, installed
# so its Headers carry bare-kit.h.
apple() {
  name=$1
  shift
  if [ ! -d "$out/$name/BareKit.framework" ]; then
    sources
    build bare-kit-swift bare_kit_framework "$name" "$@"
    cmake --install "$work/$name" --prefix "$work/$name-install" >>"$work/$name.log" 2>&1
    mkdir -p "$out/$name.part"
    cp -R "$(find "$work/$name-install" -maxdepth 2 -name BareKit.framework -type d)" "$out/$name.part/"
    mv "$out/$name.part" "$out/$name"
  fi
  mkdir -p "vendor/bare-kit/$name"
  rm -rf "vendor/bare-kit/$name/BareKit.framework"
  cp -R "$out/$name/BareKit.framework" "vendor/bare-kit/$name/"
}

for target in "$@"; do
  case $target in
    darwin)
      arch=$(uname -m)
      # The framework is built per architecture but vendored as darwin/.
      apple "darwin-$arch" "-DCMAKE_OSX_ARCHITECTURES=$arch" -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0
      rm -rf vendor/bare-kit/darwin
      mv "vendor/bare-kit/darwin-$arch" vendor/bare-kit/darwin
      ;;
    # bare's own executable target installs as a bundle on iOS unless told otherwise.
    ios-arm64) apple ios-arm64 -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphoneos -DCMAKE_OSX_ARCHITECTURES=arm64 \
      -DCMAKE_OSX_DEPLOYMENT_TARGET=16.0 -DCMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED=NO -DCMAKE_MACOSX_BUNDLE=OFF ;;
    ios-arm64-simulator) apple ios-arm64-simulator -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphonesimulator \
      -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=16.0 -DCMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED=NO -DCMAKE_MACOSX_BUNDLE=OFF ;;
    *) android "$target" ;;
  esac
done
# Only the outputs are kept; sources and build trees are ~1 GB per target.
rm -rf "$work"
echo "bare-kit on QuickJS in worklet/vendor/bare-kit: $*"
