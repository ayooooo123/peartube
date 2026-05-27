#!/bin/bash
# Run Expo iOS with CocoaPods/Homebrew visible to Expo's pod checks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(dirname "$SCRIPT_DIR")"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$MOBILE_DIR"
expo run:ios "$@"
