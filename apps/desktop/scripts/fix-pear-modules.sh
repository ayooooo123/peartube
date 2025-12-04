#!/bin/bash
# Workaround for Pear Runtime's incompatibility with pnpm symlinks
# This copies pear-electron as a real directory instead of a symlink

set -e

DESKTOP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_MODULES="$DESKTOP_DIR/node_modules"

echo "Fixing pear-electron for Pear Runtime compatibility..."

# Check if pear-electron exists and is a symlink
if [ -L "$NODE_MODULES/pear-electron" ]; then
    # Get the resolved path
    REAL_PATH=$(realpath "$NODE_MODULES/pear-electron")

    # Remove the symlink
    rm "$NODE_MODULES/pear-electron"

    # Copy the actual directory
    cp -r "$REAL_PATH" "$NODE_MODULES/pear-electron"

    echo "Replaced pear-electron symlink with actual directory"
else
    echo "pear-electron is already a directory or doesn't exist"
fi
