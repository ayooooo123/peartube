#!/bin/bash
# Android SDK Setup Script for PearTube
# This script automates Android SDK configuration

echo "Setting up Android SDK for PearTube..."

# Detect Android SDK location
ANDROID_SDK=""
if [ -d "$HOME/Library/Android/sdk" ]; then
  ANDROID_SDK="$HOME/Library/Android/sdk"
  echo "Found Android SDK at: $ANDROID_SDK"
elif [ -d "$HOME/Android/Sdk" ]; then
  ANDROID_SDK="$HOME/Android/Sdk"
  echo "Found Android SDK at: $ANDROID_SDK"
elif [ -n "$ANDROID_HOME" ]; then
  ANDROID_SDK="$ANDROID_HOME"
  echo "Using ANDROID_HOME: $ANDROID_SDK"
else
  echo "Android SDK not found!"
  echo ""
  echo "Please install Android Studio or set ANDROID_HOME environment variable"
  echo "Android Studio will typically install to:"
  echo "  - ~/Library/Android/sdk (macOS)"
  echo "  - ~/Android/Sdk (Linux)"
  echo ""
  echo "Or set manually:"
  echo "  export ANDROID_HOME=/path/to/android/sdk"
  exit 1
fi

# Create local.properties
LOCAL_PROPS="android/local.properties"
if [ -f "$LOCAL_PROPS" ]; then
  EXISTING_SDK=$(grep "sdk.dir" "$LOCAL_PROPS" 2>/dev/null | cut -d'=' -f2)
  if [ "$EXISTING_SDK" = "$ANDROID_SDK" ]; then
    echo "local.properties already configured correctly"
  else
    echo "Updating $LOCAL_PROPS with SDK path..."
    echo "sdk.dir=$ANDROID_SDK" > "$LOCAL_PROPS"
    echo "Created: $LOCAL_PROPS"
  fi
else
  echo "Creating $LOCAL_PROPS with SDK path..."
  echo "sdk.dir=$ANDROID_SDK" > "$LOCAL_PROPS"
  echo "Created: $LOCAL_PROPS"
fi

# Set up environment variables for current session
export ANDROID_HOME="$ANDROID_SDK"
export ANDROID_SDK_ROOT="$ANDROID_SDK"
export PATH="$ANDROID_SDK/platform-tools:$ANDROID_SDK/cmdline-tools/latest/bin:$ANDROID_SDK/build-tools/36.0.0:$PATH"
echo "Environment variables set for current session"

echo ""
echo "To make these changes permanent, add to your shell profile (~/.zshrc):"
echo ""
echo "export ANDROID_HOME=\"$ANDROID_SDK\""
echo "export ANDROID_SDK_ROOT=\"$ANDROID_SDK\""
echo "export PATH=\"\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/build-tools/36.0.0:\$PATH\""
echo ""
echo "Setup complete! You can now run: npm run android"
