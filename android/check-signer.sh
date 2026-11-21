#!/bin/sh
# Fails unless the APK verifies and every signer certificate is the PearTube release key.
#   sh android/check-signer.sh <apk>
# The pin is the SHA-256 of the release certificate (CN=PearTube), the key of every published APK.
# It is a public certificate digest, not a secret.
set -eu

expected=1754ebd33f160fffcefcd19e68981519d983f9d6ff7304b36ba196ba4d892811

[ $# -eq 1 ] || { echo "usage: sh android/check-signer.sh <apk>" >&2; exit 2; }
apk="$1"
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
tools=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n 1)

# An assignment, so set -e stops here when apksigner rejects the APK.
certs=$("$tools/apksigner" verify --print-certs "$apk" 2>/dev/null)
# "V2 Signer: certificate SHA-256 digest: …" (build-tools 37) or "Signer #1 certificate SHA-256 digest: …" (older).
digests=$(printf '%s\n' "$certs" | sed -n 's/^.*Signer.*certificate SHA-256 digest: //p')
[ -n "$digests" ] || { echo "$apk: no signer certificate found" >&2; exit 1; }
for digest in $digests; do
  [ "$digest" = "$expected" ] || { echo "$apk: signer sha256 $digest is not the release key $expected" >&2; exit 1; }
done
echo "signer sha256: $expected (release key)"
