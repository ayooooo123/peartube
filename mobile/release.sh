#!/bin/sh
# Builds the signed arm64 release APK into target/release-apk/.
# The key is android/'s release key, read from ~/.gradle/gradle.properties:
# peartube.keystore, peartube.keystorePassword, peartube.keyAlias and
# peartube.keyPassword. dx signs only with passwords written into Dioxus.toml,
# so this script assembles and signs the release itself.
set -eu

cd "$(dirname "$0")"
props="$HOME/.gradle/gradle.properties"
prop() {
  value=$(sed -n "s/^$1=//p" "$props")
  [ -n "$value" ] || { echo "$1 is not set in $props" >&2; exit 1; }
  printf '%s' "$value"
}
keystore=$(prop peartube.keystore)
alias=$(prop peartube.keyAlias)
PEARTUBE_KS_PASS=$(prop peartube.keystorePassword)
PEARTUBE_KEY_PASS=$(prop peartube.keyPassword)
export PEARTUBE_KS_PASS PEARTUBE_KEY_PASS

: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
tools=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n 1)
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n 1)

# dx copies the worklet's native addons into the APK only when it links the
# app, and skips the link when nothing changed: force one.
touch src/main.rs
dx build --android --release --target aarch64-linux-android

app=target/dx/PearTube/release/android/app
(cd "$app" && ./gradlew --quiet assembleRelease)

mkdir -p target/release-apk
out="target/release-apk/PearTube-$version-arm64.apk"
cp "$app/app/build/outputs/apk/release/app-release-unsigned.apk" "$out.unsigned"
# libVLC ships four ABIs; the app's own libraries are arm64 only. With other
# ABIs present, an x86_64 or armv7 device would install the app and crash.
zip -q -d "$out.unsigned" 'lib/armeabi-v7a/*' 'lib/x86/*' 'lib/x86_64/*'
"$tools/zipalign" -f -P 16 4 "$out.unsigned" "$out.aligned"
"$tools/apksigner" sign --ks "$keystore" --ks-key-alias "$alias" \
  --ks-pass env:PEARTUBE_KS_PASS --key-pass env:PEARTUBE_KEY_PASS \
  --out "$out" "$out.aligned"
rm -f "$out.unsigned" "$out.aligned" "$out.idsig"
# An assignment, so set -e stops the script when verification fails.
certs=$("$tools/apksigner" verify --print-certs "$out" 2>/dev/null)
printf '%s\n' "$certs" | sed -n 's/^.*Signer.* certificate SHA-256 digest: /signer sha256: /p'
echo "$out"
