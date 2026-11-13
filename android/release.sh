#!/bin/sh
# Builds the signed arm64 release APK(s) into android/build/release-apk/.
#   sh android/release.sh                    default engine in native.lock (or $PEARTUBE_ENGINE)
#   sh android/release.sh --engine rust      pinned Rust native engine (-rust-arm64.apk)
#   sh android/release.sh --engine both      both JS and Rust release APKs side by side
# Gradle signs with ~/.gradle/gradle.properties (peartube.keystore{,Password}, peartube.key{Alias,Password}).
set -eu

self="$0"
cd "$(dirname "$0")"
engine="${PEARTUBE_ENGINE:-}"
native_local=""
while [ $# -gt 0 ]; do
  case "$1" in
    --engine) shift; [ $# -gt 0 ] || { echo "--engine needs js, rust or both" >&2; exit 2; }; engine="$1" ;;
    --native-local) shift; [ $# -gt 0 ] || { echo "--native-local needs a path" >&2; exit 2; }; native_local="$1" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$engine" ] || engine=$(node -p 'require("../native.lock").engine["android-app"]')
if [ "$engine" = "both" ]; then
  sh "$self" --engine js ${native_local:+--native-local "$native_local"}
  sh "$self" --engine rust ${native_local:+--native-local "$native_local"}
  exit 0
fi
case "$engine" in js|rust) ;; *) echo "--engine must be js, rust or both, not $engine" >&2; exit 2 ;; esac
props="$HOME/.gradle/gradle.properties"
for key in keystore keystorePassword keyAlias keyPassword; do
  grep -q "^peartube\.$key=" "$props" 2>/dev/null || { echo "peartube.$key is not set in $props" >&2; exit 1; }
done
if [ -x /usr/libexec/java_home ]; then JAVA_HOME=$(/usr/libexec/java_home -v 17); export JAVA_HOME; fi
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
export ANDROID_HOME
tools=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n 1)
version=$(node -p 'require("../package.json").version')

./gradlew --console=plain :app:assembleRelease "-Ppeartube.engine=$engine" ${native_local:+"-Ppeartube.nativeLocal=$native_local"}
mkdir -p build/release-apk
suffix=""
[ "$engine" = "rust" ] && suffix="-rust"
out="build/release-apk/PearTube-$version$suffix-arm64.apk"
cp app/build/outputs/apk/release/app-release.apk "$out"
# An assignment, so set -e stops the script when verification fails.
certs=$("$tools/apksigner" verify --print-certs "$out" 2>/dev/null)
printf '%s\n' "$certs" | sed -n 's/^.*Signer.* certificate SHA-256 digest: /signer sha256: /p'
echo "$out"
