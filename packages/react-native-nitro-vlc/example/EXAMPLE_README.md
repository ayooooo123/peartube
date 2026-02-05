# NitroVLC Example App

This example app demonstrates the usage of `react-native-nitro-vlc` - a high-performance VLC player for React Native using Nitro Modules.

## Prerequisites

- Node.js 18+
- iOS: Xcode 15+, CocoaPods
- Android: Android Studio, JDK 17

## Setup

```bash
cd example
npm install

# iOS
cd ios && pod install && cd ..

# Run
npx expo run:ios
# or
npx expo run:android
```

## Features Demonstrated

- NitroVLCView component rendering
- Video playback controls (play, pause, seek)
- Progress tracking
- Video info loading

## Test Video

The example uses Big Buck Bunny as a test video:
https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4

## Known Issues

- Nitro modules require New Architecture to be enabled (set by default)
- MobileVLCKit 3.7.0 is used for stable iOS builds
