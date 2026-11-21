#!/bin/sh
# Builds the signed arm64 release APK(s) into android/build/release-apk/.
#   sh android/release.sh                    default engine in native.lock (or $PEARTUBE_ENGINE)
#   sh android/release.sh --engine rust      pinned Rust native engine (-rust-arm64.apk)
#   sh android/release.sh --engine both      both JS and Rust release APKs side by side
# Gradle signs only when the script passes -Ppeartube.signRelease; every other Gradle run
# (help, debug, -Ppeartube.dev) reads no password.
# Gradle signs with ~/.gradle/gradle.properties (peartube.keystore, peartube.keyAlias) and the two passwords
# (peartube.keystorePassword, peartube.keyPassword) from there or from the login Keychain (service peartube-release).
# check-signer.sh then refuses any APK not signed by the release key.
set -eu

self="./$(basename "$0")"
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
[ -n "$engine" ] || engine=$(node -p 'JSON.parse(fs.readFileSync("../native.lock", "utf8")).engine["android-app"]')
if [ "$engine" = "both" ]; then
  sh "$self" --engine js ${native_local:+--native-local "$native_local"}
  sh "$self" --engine rust ${native_local:+--native-local "$native_local"}
  exit 0
fi
case "$engine" in js|rust) ;; *) echo "--engine must be js, rust or both, not $engine" >&2; exit 2 ;; esac
props="${GRADLE_USER_HOME:-$HOME/.gradle}/gradle.properties"
for key in keystore keyAlias; do
  grep -q "^peartube\.$key=" "$props" 2>/dev/null || { echo "peartube.$key is not set in $props" >&2; exit 1; }
done
for key in keystorePassword keyPassword; do
  grep -q "^peartube\.$key=" "$props" 2>/dev/null || security find-generic-password -s peartube-release -a "$key" >/dev/null 2>&1 \
    || { echo "peartube.$key is in neither $props nor the login Keychain (service peartube-release)" >&2; exit 1; }
done
if [ -x /usr/libexec/java_home ]; then JAVA_HOME=$(/usr/libexec/java_home -v 17); export JAVA_HOME; fi
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
export ANDROID_HOME
version=$(node -p 'require("../package.json").version')

./gradlew --console=plain :app:assembleRelease -Ppeartube.signRelease "-Ppeartube.engine=$engine" ${native_local:+"-Ppeartube.nativeLocal=$native_local"}
mkdir -p build/release-apk
suffix=""
[ "$engine" = "rust" ] && suffix="-rust"
out="build/release-apk/PearTube-$version$suffix-arm64.apk"
cp app/build/outputs/apk/release/app-release.apk "$out"
sh ./check-signer.sh "$out" || { rm -f "$out"; exit 1; }
echo "$out"
