# Draft: Nitro Modules for VLC Player Research

## Requirements (confirmed)
- **Goal**: Both performance AND simplicity
- **Scope**: Full rewrite including HLS transcoding integration
- **iOS New Architecture**: Yes, enable it
- Focus on mobile (iOS/Android) VLC player implementation

## CRITICAL FINDING: No existing Nitro/JSI VLC implementation
This would be pioneering work - no JSI-based VLC library exists anywhere.
We would be creating `react-native-nitro-vlc` from scratch.

## Current VLC Architecture

### Component Stack
```
React Components (VlcVideoView.tsx)
    ↓
React Native Bridge (VLCPlayer.js) - uses requireNativeComponent
    ↓
Native Implementation (iOS: RCTVLCPlayer.m / Android: ReactVlcPlayerView.java)
    ↓
libvlc (iOS: MobileVLCKit 3.5.1 / Android: libvlc-all 3.6.3)
```

### Key Files Identified
- `packages/app/components/video-player/VlcVideoView.tsx` - Main wrapper
- `packages/app/vendor/react-native-vlc-media-player/VLCPlayer.js` - JS bridge
- `packages/app/vendor/react-native-vlc-media-player/ios/RCTVLCPlayer/` - iOS native
- `packages/app/vendor/react-native-vlc-media-player/android/` - Android native
- `packages/app/ios/PearTube/VLCPiPPlayer.m` - Custom PiP with vmem callbacks

### Current Bridge Pattern (Legacy)
- Uses `requireNativeComponent("RCTVLCPlayer")` 
- `RCT_EXPORT_MODULE()` / `RCT_EXPORT_VIEW_PROPERTY()` macros
- Async bridge communication via `UIManager.dispatchViewManagerCommand()`
- Events via native event emitters

## Nitro Modules Research

### What Are Nitro Modules?
- Framework by mrousavy (Margelo) for building fast native modules
- Statically compiled JSI bindings (no bridge serialization)
- TypeScript-first with code generation via "Nitrogen"
- Supports Swift, Kotlin, and C++ implementations

### Architecture Comparison
```
Turbo Modules:  JS → C++ → Objective-C → Swift
Nitro Modules:  JS → C++ → Swift (direct)
```

### Key Benefits
1. **Synchronous calls** - No async bridge overhead
2. **Zero-copy ArrayBuffers** - Direct memory sharing
3. **Type-safe** - Generated from TypeScript interfaces
4. **HybridObject pattern** - Object-oriented native modules
5. **HybridView support** - Native view components with methods

### HybridObject Example (from docs)
```typescript
interface Video extends HybridObject<{ ios: 'swift', android: 'kotlin' }> {
  readonly duration: number
  readonly fps: number
  extractFrame(timestamp: number): Promise<Image>
}
```

### HybridView Pattern (for video players)
```typescript
interface CameraProps extends HybridViewProps { ... }
interface CameraMethods extends HybridViewMethods {
  takePhoto(): Promise<Image>
}
export type CameraView = HybridView<CameraProps, CameraMethods>
```

## Performance Pain Points in Current VLC

### From Research:
1. **Video startup delay**: 3.4 seconds VLC initialized → first frame
2. **Bridge latency**: All commands go through async RCT bridge
3. **PiP complexity**: Custom vmem callbacks for frame rendering
4. **Seeking**: Normalized position (0-1) passed as prop, not method
5. **Event handling**: Events via RCT event emitters (batched, not immediate)

### VideoToolbox Issues (documented)
- Hardware decode can corrupt memory with 10-bit HEVC
- Requires user toggle to disable (`PEARTUBE_ENABLE_VT_DECODE=0`)
- Hardware encoder frame reuse causes corruption

## Nitro Modules Potential Benefits for VLC

### High-Impact Opportunities
| Current Pain | Nitro Solution |
|--------------|----------------|
| Async bridge commands | Synchronous JSI calls |
| Event batching delays | Direct callback invocation |
| Seek via prop changes | Direct method calls |
| No frame access | ArrayBuffer for video frames |
| Complex PiP vmem callbacks | HybridView with direct methods |

### Architectural Simplification
- Replace `requireNativeComponent` + `UIManager.dispatchViewManagerCommand` with `HybridView`
- Replace `RCT_EXPORT_MODULE` with `HybridObject` registration
- Replace async events with synchronous callbacks where needed
- TypeScript interfaces generate native protocols automatically

## Technical Decisions

### Implementation Language
- **iOS**: Swift (direct C++ bridge, cleaner than ObjC)
- **Android**: Kotlin (Nitrogen generates JNI bindings)
- **Shared logic**: Could use C++ for common VLC wrapper

### HybridView vs HybridObject
- **HybridView**: For the VLCPlayer component itself (renders video)
- **HybridObject**: For VLC controller/session management

### Dependencies
- `react-native-nitro-modules` - Core framework
- Nitrogen CLI - Code generation
- Existing MobileVLCKit/libvlc-all dependencies remain

## Open Questions

1. **VisionCamera as reference?** - Same author, uses Nitro, handles video
2. **Expo compatibility?** - PearTube uses Expo; need to verify Nitro works
3. **PiP support?** - Current VLCPiPPlayer uses complex vmem callbacks
4. **Migration strategy?** - Incremental or full rewrite?
5. **Performance benchmarks?** - Need concrete measurements before/after

## Research Findings Summary

### What We Know
- Current VLC uses legacy RCT bridge (performant but verbose)
- Nitro provides faster, simpler native module pattern
- HybridView pattern fits video player use case well
- No existing Nitro-based VLC implementation found
- VisionCamera (mrousavy) uses Nitro for camera - similar domain

### What We Need to Clarify
- Exact performance gains for video player scenario
- Expo SDK compatibility with Nitro Modules
- Effort to migrate ~3000 lines of native VLC code
- Whether PiP vmem pattern can work with Nitro

## Scope Boundaries

### INCLUDE
- VLC player component rewrite using Nitro HybridView
- TypeScript interface definitions
- iOS Swift implementation
- Android Kotlin implementation
- Basic playback controls (play, pause, seek, volume)
- Event callbacks (progress, state changes, errors)

### EXCLUDE (potential future work)
- PiP player (VLCPiPPlayer) - complex vmem callbacks
- Desktop/Pear (uses MPV, not VLC)
- HLS transcoding pipeline (backend, not player)
- Chromecast integration

## Detailed Nitro Performance Benchmarks

**Source: NitroBenchmarks (100,000 native method calls)**

| Operation | ExpoModules | TurboModules | NitroModules | Speedup |
|-----------|-------------|--------------|--------------|---------|
| `addNumbers(...)` | 434.85ms | 115.86ms | **7.27ms** | 59x vs Expo, 15x vs Turbo |
| `addStrings(...)` | 429.53ms | 179.02ms | **29.94ms** | 13x vs Expo, 5x vs Turbo |

## Minimum Requirements for Nitro

**iOS:**
- React Native 0.75+
- Xcode 16.4+
- Swift 5.9+

**Android:**
- React Native 0.75+
- compileSdkVersion 34+
- ndkVersion 27+

**PearTube Status:**
- Currently uses Expo with React Native (need to verify version)
- New Architecture is enabled on Android (`newArchEnabled=true`)
- iOS New Architecture NOT enabled (`RCT_NEW_ARCH_ENABLED` defaults to '0')

## Existing Nitro Media Libraries

From Awesome Nitro Modules:
- `react-native-video` - Video playback (Nitro version exists!)
- `react-native-nitro-image` - Superfast in-memory Image type
- `react-native-nitro-player` - Powerful audio player
- `react-native-nitro-audio-manager` - Audio session and routing
- `react-native-vision-camera` - Uses Nitro for camera (9.2k stars)

**Key Insight**: `react-native-video` already has a Nitro version - could serve as reference architecture!

## HybridView for Video Players

Nitro supports `HybridView` for native view components:

```typescript
interface VLCPlayerProps extends HybridViewProps {
  source: { uri: string }
  paused: boolean
  rate: number
  volume: number
  // ... other props
}

interface VLCPlayerMethods extends HybridViewMethods {
  seek(time: number): void
  snapshot(path: string): Promise<string>
  // ... other methods
}

export type VLCPlayerView = HybridView<VLCPlayerProps, VLCPlayerMethods>
```

## Migration Considerations

### What Would Change

| Current (Legacy RCT) | Nitro Equivalent |
|---------------------|------------------|
| `requireNativeComponent()` | `HybridView` |
| `RCT_EXPORT_MODULE()` | `HybridObject` registration in `nitro.json` |
| `UIManager.dispatchViewManagerCommand()` | Direct method calls on HybridView |
| `RCT_EXPORT_VIEW_PROPERTY()` | TypeScript interface properties |
| Event emitters | Synchronous callbacks or native properties |
| Async bridge batching | Synchronous JSI calls |

### What Stays the Same

- MobileVLCKit (iOS) / libvlc-all (Android) dependencies
- Core VLC player logic
- Video rendering to native surfaces
- Hardware codec support

## Next Steps for Planning

1. Clarify user's primary goals (performance vs simplicity vs both?)
2. Confirm Expo compatibility requirement
3. Decide on scope (basic player only, or include PiP?)
4. Determine migration strategy (incremental vs rewrite)
5. Set success criteria (startup time, frame latency, etc.)
6. Check if PearTube meets minimum requirements (RN 0.75+, Xcode 16.4+)
7. Investigate `react-native-video` Nitro implementation as reference
