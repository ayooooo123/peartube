#!/bin/bash
# Install iOS CocoaPods using the local Homebrew/Ruby environment when present.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(dirname "$SCRIPT_DIR")"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if command -v pod >/dev/null 2>&1; then
    cd "$MOBILE_DIR/ios"
    pod install
else
    cd "$MOBILE_DIR"
    npx pod-install
fi
