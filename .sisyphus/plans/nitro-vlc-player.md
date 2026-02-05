# Nitro Modules VLC Player for PearTube

## TL;DR

> **Quick Summary**: Create a high-performance VLC player using Nitro Modules (HybridView/HybridObject pattern) to replace the legacy RCT bridge implementation, achieving 15-60x faster native calls while simplifying the codebase.
> 
> **Deliverables**:
> - Standalone `react-native-nitro-vlc` npm package with TypeScript interfaces
> - Swift implementation for iOS using MobileVLCKit
> - Kotlin implementation for Android using libvlc-all
> - iOS New Architecture enabled in PearTube
> - Integration layer replacing old VLC with feature flag
> - Comprehensive test suite (TDD approach)
> 
> **Estimated Effort**: XL (4-6 weeks)
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 1 → Task 3 → Task 5 → Task 8 → Task 11 → Task 14

---

## Context

### Original Request
Create a Nitro Modules-based VLC player to improve both performance and code simplicity for PearTube mobile app.

### Interview Summary
**Key Discussions**:
- **Goal**: Both performance AND simplicity (not just one)
- **Scope**: VLC player + HLS coordination only (NOT rewriting FFmpeg/transcoder)
- **Migration**: Create standalone package first, then integrate into PearTube
- **iOS New Arch**: User agreed to enable it (currently disabled)
- **Testing**: TDD approach with tests before implementation

**Research Findings**:
- No existing Nitro/JSI VLC implementation exists anywhere - this is pioneering work
- Nitro provides 15-60x faster native calls than Turbo Modules
- Current VLC uses ~2500+ lines of native code with legacy RCT bridge
- PearTube uses React Native 0.81.4 (meets Nitro's 0.75+ requirement)
- Known issues in current VLC: iOS 17 simulator crash, Android seek stuttering, excessive callbacks

### Metis Review
**Identified Gaps** (addressed):
- PiP support scope unclear → Explicitly deferred to Phase 2
- MediaSession integration question → Keep existing integration, compatibility layer
- Certificate dialog handling → Match existing behavior
- Need performance baselines → Added measurement task before implementation
- iOS New Arch risk → Separate validation phase before VLC work

---

## Work Objectives

### Core Objective
Create `react-native-nitro-vlc`, a standalone Nitro Modules package that wraps MobileVLCKit (iOS) and libvlc-all (Android) using the HybridView pattern, then integrate it into PearTube to replace the legacy VLC implementation.

### Concrete Deliverables
- `packages/react-native-nitro-vlc/` - New standalone npm package
- `packages/react-native-nitro-vlc/src/NitroVLC.nitro.ts` - TypeScript HybridView interface
- `packages/react-native-nitro-vlc/ios/` - Swift native implementation
- `packages/react-native-nitro-vlc/android/` - Kotlin native implementation
- `packages/react-native-nitro-vlc/nitrogen/` - Generated C++ bindings
- `packages/react-native-nitro-vlc/example/` - Test app
- Feature flag `USE_NITRO_VLC` in PearTube
- Updated `VlcVideoView.tsx` with Nitro integration

### Definition of Done
- [x] `npm run build` succeeds in react-native-nitro-vlc package
- [x] Example app plays video on iOS simulator
- [x] Example app plays video on Android emulator
- [x] PearTube builds with iOS New Architecture enabled
- [x] PearTube video playback works with `USE_NITRO_VLC=true`
- [ ] All tests pass (`npm test`)
- [x] No TypeScript errors (`npx tsc --noEmit`)

### Must Have
- Basic playback: play, pause, stop, seek (0-1 normalized)
- Volume/mute control
- Playback rate control
- Callbacks: onProgress, onPlaying, onPaused, onBuffering, onEnded, onError
- Network stream support (HTTP/HTTPS including local blob server)
- Hardware acceleration support (existing settings preserved)

### Must NOT Have (Guardrails)
- **NO PiP support** - Deferred to Phase 2 (complex vmem callbacks)
- **NO Desktop/Pear support** - Mobile only, desktop uses MPV
- **NO Recording/Snapshot** - Deferred to Phase 2
- **NO Subtitle track selection** - Deferred to Phase 2
- **NO Audio track selection** - Deferred to Phase 2
- **NO VideoPlayerContext.tsx refactoring** - Use compatibility layer instead
- **NO HLS transcoder changes** - Backend is out of scope
- **NO New native dependencies** - Only MobileVLCKit/libvlc-all

---

## Verification Strategy

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
>
> ALL tasks in this plan MUST be verifiable WITHOUT any human action.
> The executing agent will directly run the deliverable and verify it.

### Test Decision
- **Infrastructure exists**: YES (bun test available in monorepo)
- **Automated tests**: YES (TDD)
- **Framework**: bun test / jest

### If TDD Enabled

Each TODO follows RED-GREEN-REFACTOR:

**Task Structure:**
1. **RED**: Write failing test first
2. **GREEN**: Implement minimum code to pass
3. **REFACTOR**: Clean up while keeping green

### Agent-Executed QA Scenarios (MANDATORY - ALL tasks)

**Verification Tool by Deliverable Type:**

| Type | Tool | How Agent Verifies |
|------|------|-------------------|
| **Package Build** | Bash (npm/bun) | Run build, assert exit code 0 |
| **iOS Build** | Bash (xcodebuild) | Build workspace, assert success |
| **Android Build** | Bash (gradle) | Run assembleDebug, assert success |
| **TypeScript** | Bash (tsc) | Run --noEmit, assert no errors |
| **Video Playback** | Playwright | Navigate to example app, verify video plays |
| **Native Logs** | Bash (adb logcat / xcrun simctl) | Check for expected log patterns |

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately):
├── Task 1: Capture performance baselines [no dependencies]
├── Task 2: Enable iOS New Architecture [no dependencies]
└── Task 3: Create package scaffolding [no dependencies]

Wave 2 (After Wave 1):
├── Task 4: Proof-of-concept validation [depends: 2, 3]
├── Task 5: Define TypeScript interfaces [depends: 3]
├── Task 6: iOS Swift implementation [depends: 5]
└── Task 7: Android Kotlin implementation [depends: 5]

Wave 3 (After Wave 2):
├── Task 8: Run Nitrogen codegen [depends: 5, 6, 7]
├── Task 9: Create example app [depends: 8]
├── Task 10: iOS native tests [depends: 6, 9]
└── Task 11: Android native tests [depends: 7, 9]

Wave 4 (After Wave 3):
├── Task 12: Integration layer [depends: 9, 10, 11]
├── Task 13: HLS coordination update [depends: 12]
└── Task 14: Final integration tests [depends: 12, 13]
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | None | 2, 3 |
| 2 | None | 4 | 1, 3 |
| 3 | None | 4, 5 | 1, 2 |
| 4 | 2, 3 | None | None (validation gate) |
| 5 | 3 | 6, 7, 8 | None |
| 6 | 5 | 8, 10 | 7 |
| 7 | 5 | 8, 11 | 6 |
| 8 | 5, 6, 7 | 9 | None |
| 9 | 8 | 10, 11, 12 | None |
| 10 | 6, 9 | 12 | 11 |
| 11 | 7, 9 | 12 | 10 |
| 12 | 9, 10, 11 | 13, 14 | None |
| 13 | 12 | 14 | None |
| 14 | 12, 13 | None | None (final) |

### Agent Dispatch Summary

| Wave | Tasks | Recommended Agents |
|------|-------|-------------------|
| 1 | 1, 2, 3 | delegate_task(category="quick", load_skills=["holepunch-p2p-architect"]) |
| 2 | 4, 5, 6, 7 | delegate_task(category="deep", load_skills=["react-native-best-practices"]) |
| 3 | 8, 9, 10, 11 | delegate_task(category="unspecified-high", load_skills=["expo-dev-client"]) |
| 4 | 12, 13, 14 | delegate_task(category="deep", load_skills=["holepunch-p2p-architect"]) |

---

## TODOs

### Phase 0: Preparation

- [x] 1. Capture Performance Baselines (Phase 1) ✅

  **What to do**:
  - Measure current VLC video start time (loadAndPlayVideo → first onProgress)
  - Measure current VLC seek latency (seekTo → onProgress reflecting new position)
  - Document measurements in `.sisyphus/evidence/vlc-baselines.md`
  - These baselines will be compared against Nitro VLC performance

  **Must NOT do**:
  - Do not modify any code
  - Do not install new dependencies

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single measurement task, no code changes
  - **Skills**: [`react-native-best-practices`]
    - `react-native-best-practices`: Understands RN performance measurement

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - `packages/app/lib/VideoPlayerContext.tsx:609-650` - loadAndPlayVideo function
  - `packages/app/lib/VideoPlayerContext.tsx:730-740` - seek handling
  - `RESEARCH-P2P-VIDEO-STARTUP.md` - Existing performance documentation

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Measure video start time
    Tool: Bash (adb logcat)
    Preconditions: Android emulator running, PearTube installed
    Steps:
      1. adb logcat -c  # Clear logs
      2. Launch PearTube and tap a video
      3. adb logcat | grep -E "loadAndPlayVideo|onProgress" | head -20
      4. Calculate time delta between loadAndPlayVideo and first onProgress
    Expected Result: Timestamp delta captured
    Evidence: .sisyphus/evidence/vlc-baselines.md created with measurements

  Scenario: Measure seek latency
    Tool: Bash (adb logcat)
    Preconditions: Video playing in PearTube
    Steps:
      1. adb logcat -c
      2. Seek to 50% via UI or adb shell input
      3. adb logcat | grep "onProgress" | head -10
      4. Calculate time from seek action to position change
    Expected Result: Seek latency documented
    Evidence: .sisyphus/evidence/vlc-baselines.md updated
  ```

  **Commit**: NO (measurement only)

---

- [x] 2. Enable iOS New Architecture (Phase 1) ✅

  **What to do**:
  - Set `RCT_NEW_ARCH_ENABLED=1` in Podfile
  - Run `npx pod-install`
  - Build iOS app with New Architecture
  - Run smoke tests to verify existing functionality
  - Document any breaking changes

  **Must NOT do**:
  - Do not make functional changes beyond New Arch enablement
  - Do not fix unrelated issues

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Configuration change with verification
  - **Skills**: [`expo-dev-client`]
    - `expo-dev-client`: Understands Expo/RN build configuration

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Task 4
  - **Blocked By**: None

  **References**:
  - `packages/app/ios/Podfile:1-50` - Pod configuration
  - `packages/app/android/gradle.properties:34-36` - Android New Arch (already enabled)

  **Acceptance Criteria**:

  **TDD:**
  - Test file: Not applicable (configuration task)
  - Verification: Build succeeds

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: iOS New Architecture build succeeds
    Tool: Bash (xcodebuild)
    Preconditions: macOS with Xcode 16.4+
    Steps:
      1. cd packages/app
      2. Edit ios/Podfile to set ENV['RCT_NEW_ARCH_ENABLED'] = '1'
      3. npx pod-install
      4. xcodebuild -workspace ios/PearTube.xcworkspace -scheme PearTube -sdk iphonesimulator -configuration Debug build 2>&1 | tail -50
    Expected Result: ** BUILD SUCCEEDED ** in output
    Evidence: Build log saved to .sisyphus/evidence/task-2-ios-newarch-build.log

  Scenario: App launches on iOS simulator
    Tool: Bash (xcrun simctl)
    Preconditions: iOS build succeeded
    Steps:
      1. xcrun simctl boot "iPhone 16"
      2. xcrun simctl install booted packages/app/ios/build/Build/Products/Debug-iphonesimulator/PearTube.app
      3. xcrun simctl launch booted com.peartube.app
      4. sleep 5
      5. xcrun simctl get_app_container booted com.peartube.app
    Expected Result: App container path returned (app launched)
    Evidence: .sisyphus/evidence/task-2-ios-launch.log
  ```

  **Commit**: YES
  - Message: `feat(ios): enable New Architecture for Nitro Modules support`
  - Files: `packages/app/ios/Podfile`

---

- [x] 3. Create Package Scaffolding (Phase 1) ✅

  **What to do**:
  - Create `packages/react-native-nitro-vlc/` directory structure
  - Initialize package.json with correct dependencies
  - Create nitro.json configuration
  - Set up TypeScript config
  - Create placeholder files for iOS/Android native code
  - Add package to monorepo workspace

  **Must NOT do**:
  - Do not implement any functionality yet
  - Do not write native code beyond scaffolding

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: File creation and configuration
  - **Skills**: [`mcp-builder`]
    - `mcp-builder`: Understands package scaffolding patterns

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Tasks 4, 5
  - **Blocked By**: None

  **References**:
  - `packages/app/package.json` - Monorepo package structure
  - `https://nitro.margelo.com/docs/configuration-nitro-json` - Nitro config format
  - `https://github.com/mrousavy/react-native-nitro-image` - Reference Nitro package

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Package structure created correctly
    Tool: Bash (ls, cat)
    Preconditions: None
    Steps:
      1. ls -la packages/react-native-nitro-vlc/
      2. Assert: package.json exists
      3. Assert: nitro.json exists
      4. Assert: tsconfig.json exists
      5. Assert: src/ directory exists
      6. Assert: ios/ directory exists
      7. Assert: android/ directory exists
    Expected Result: All files/directories present
    Evidence: Directory listing captured

  Scenario: Package.json is valid
    Tool: Bash (node)
    Preconditions: Package created
    Steps:
      1. cd packages/react-native-nitro-vlc
      2. node -e "console.log(JSON.parse(require('fs').readFileSync('package.json')).name)"
    Expected Result: Outputs "react-native-nitro-vlc"
    Evidence: Package name verified

  Scenario: Nitro.json is valid
    Tool: Bash (node)
    Preconditions: Package created
    Steps:
      1. cd packages/react-native-nitro-vlc
      2. node -e "const c = JSON.parse(require('fs').readFileSync('nitro.json')); console.log(c.ios?.iosModuleName)"
    Expected Result: Outputs "NitroVLC"
    Evidence: Config verified
  ```

  **Commit**: YES
  - Message: `feat: scaffold react-native-nitro-vlc package structure`
  - Files: `packages/react-native-nitro-vlc/**`

---

- [ ] 4. Proof-of-Concept Validation (Phase 1)

  **What to do**:
  - Create minimal test to verify Nitro + MobileVLCKit + Expo compatibility
  - Build a "hello world" Nitro HybridObject that returns VLC version string
  - Verify it works on iOS simulator with New Architecture
  - This gates further development - STOP if incompatible

  **Must NOT do**:
  - Do not implement full player functionality
  - Do not proceed to Phase 2 if this fails

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex compatibility validation requiring investigation
  - **Skills**: [`react-native-best-practices`, `expo-dev-client`]
    - `react-native-best-practices`: Performance patterns
    - `expo-dev-client`: Expo compatibility expertise

  **Parallelization**:
  - **Can Run In Parallel**: NO (validation gate)
  - **Parallel Group**: Sequential
  - **Blocks**: All Phase 2 tasks (implicit)
  - **Blocked By**: Tasks 2, 3

  **References**:
  - `https://nitro.margelo.com/docs/hybrid-objects` - HybridObject basics
  - `packages/react-native-nitro-vlc/nitro.json` - Configuration from Task 3
  - MobileVLCKit headers for version API

  **Acceptance Criteria**:

  **TDD:**
  - Test file: `packages/react-native-nitro-vlc/src/__tests__/poc.test.ts`
  - Test: Calling `getVLCVersion()` returns a string matching `/^\d+\.\d+\.\d+$/`
  - Command: `cd packages/react-native-nitro-vlc && bun test src/__tests__/poc.test.ts`

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: HybridObject returns VLC version
    Tool: Bash (xcodebuild + xcrun simctl)
    Preconditions: Tasks 2, 3 complete
    Steps:
      1. Create minimal HybridObject with getVLCVersion() method
      2. Build example app: xcodebuild -workspace ... -sdk iphonesimulator build
      3. Run on simulator and check console output
      4. Assert: Version string like "3.5.1" appears in logs
    Expected Result: VLC version returned through Nitro binding
    Evidence: .sisyphus/evidence/task-4-poc-validation.log

  Scenario: POC test passes
    Tool: Bash (bun test)
    Preconditions: POC implemented
    Steps:
      1. cd packages/react-native-nitro-vlc
      2. bun test src/__tests__/poc.test.ts
    Expected Result: Test passes, exit code 0
    Evidence: Test output captured
  ```

  **Commit**: YES
  - Message: `feat(nitro-vlc): proof-of-concept validates Nitro + VLC compatibility`
  - Files: `packages/react-native-nitro-vlc/src/__tests__/poc.test.ts`, native POC files

---

### Phase 1: Core Implementation

- [x] 5. Define TypeScript HybridView Interface (Phase 1) ✅

  **What to do**:
  - Create `NitroVLC.nitro.ts` with complete HybridView interface
  - Define all props matching existing VLC callback signatures
  - Define all methods (play, pause, seek, stop, setVolume)
  - Include proper JSDoc documentation
  - Export types for consumers

  **Must NOT do**:
  - Do not include PiP-related props/methods
  - Do not include recording/snapshot methods
  - Do not change existing callback signatures

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Interface design requires careful thought
  - **Skills**: [`react-native-best-practices`]
    - `react-native-best-practices`: Understands RN component patterns

  **Parallelization**:
  - **Can Run In Parallel**: NO (critical path)
  - **Parallel Group**: Sequential
  - **Blocks**: Tasks 6, 7, 8
  - **Blocked By**: Task 3

  **References**:
  - `packages/app/vendor/react-native-vlc-media-player/index.d.ts` - Existing VLC types
  - `packages/app/components/video-player/VlcVideoView.tsx:17-80` - Current prop usage
  - `https://nitro.margelo.com/docs/view-components` - HybridView docs
  - `https://github.com/mrousavy/react-native-vision-camera` - Reference implementation

  **Acceptance Criteria**:

  **TDD:**
  - Test file: `packages/react-native-nitro-vlc/src/__tests__/types.test.ts`
  - Test: TypeScript compilation succeeds with no errors
  - Test: Interface exports are correctly typed
  - Command: `cd packages/react-native-nitro-vlc && npx tsc --noEmit`

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: TypeScript interface compiles
    Tool: Bash (tsc)
    Preconditions: Interface file created
    Steps:
      1. cd packages/react-native-nitro-vlc
      2. npx tsc --noEmit
    Expected Result: Exit code 0, no errors
    Evidence: .sisyphus/evidence/task-5-tsc-output.log

  Scenario: Interface matches existing callback signatures
    Tool: Bash (grep)
    Preconditions: Interface file created
    Steps:
      1. grep -c "onProgress" packages/react-native-nitro-vlc/src/NitroVLC.nitro.ts
      2. grep -c "onPlaying" packages/react-native-nitro-vlc/src/NitroVLC.nitro.ts
      3. grep -c "onPaused" packages/react-native-nitro-vlc/src/NitroVLC.nitro.ts
      4. grep -c "onBuffering" packages/react-native-nitro-vlc/src/NitroVLC.nitro.ts
      5. grep -c "onEnded" packages/react-native-nitro-vlc/src/NitroVLC.nitro.ts
      6. grep -c "onError" packages/react-native-nitro-vlc/src/NitroVLC.nitro.ts
    Expected Result: Each grep returns >= 1
    Evidence: Callback presence verified
  ```

  **Commit**: YES
  - Message: `feat(nitro-vlc): define TypeScript HybridView interface`
  - Files: `packages/react-native-nitro-vlc/src/NitroVLC.nitro.ts`

---

- [x] 6. iOS Swift Implementation (Phase 1) ✅

  **What to do**:
  - Implement `HybridNitroVLCView` in Swift
  - Wrap MobileVLCKit VLCMediaPlayer
  - Implement all methods from interface (play, pause, seek, stop, setVolume)
  - Implement all callbacks (onProgress, onPlaying, etc.)
  - Handle VLCMediaPlayerDelegate events
  - Set up video rendering surface (UIView)

  **Must NOT do**:
  - Do not implement PiP (vmem callbacks are out of scope)
  - Do not implement recording/snapshot
  - Do not add certificate dialog handling beyond existing behavior

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex native code requiring Swift + VLC expertise
  - **Skills**: [`react-native-best-practices`]
    - `react-native-best-practices`: Native module patterns

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Task 7)
  - **Blocks**: Tasks 8, 10
  - **Blocked By**: Task 5

  **References**:
  - `packages/app/vendor/react-native-vlc-media-player/ios/RCTVLCPlayer/RCTVLCPlayer.m` - Existing ObjC implementation
  - `packages/app/ios/PearTube/VLCPiPPlayer.m:106-160` - VLCMediaPlayer setup patterns
  - `https://nitro.margelo.com/docs/view-components` - HybridView Swift implementation
  - `https://github.com/mrousavy/react-native-vision-camera/ios/` - Reference HybridView

  **Acceptance Criteria**:

  **TDD:**
  - Test file: `packages/react-native-nitro-vlc/ios/NitroVLCTests/HybridNitroVLCViewTests.swift`
  - Test: Player initializes without crash
  - Test: play() changes state to playing
  - Test: pause() changes state to paused
  - Command: `xcodebuild test -workspace ... -scheme NitroVLC -sdk iphonesimulator`

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: iOS native code compiles
    Tool: Bash (xcodebuild)
    Preconditions: Swift implementation complete
    Steps:
      1. cd packages/react-native-nitro-vlc/example
      2. npx pod-install
      3. xcodebuild -workspace ios/NitroVLCExample.xcworkspace -scheme NitroVLCExample -sdk iphonesimulator -configuration Debug build 2>&1 | tail -100
    Expected Result: ** BUILD SUCCEEDED **
    Evidence: .sisyphus/evidence/task-6-ios-build.log

  Scenario: Swift unit tests pass
    Tool: Bash (xcodebuild test)
    Preconditions: Tests written
    Steps:
      1. xcodebuild test -workspace ... -scheme NitroVLC -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 16'
    Expected Result: ** TEST SUCCEEDED **
    Evidence: .sisyphus/evidence/task-6-ios-tests.log
  ```

  **Commit**: YES
  - Message: `feat(nitro-vlc): implement iOS Swift HybridView with MobileVLCKit`
  - Files: `packages/react-native-nitro-vlc/ios/**/*.swift`

---

- [x] 7. Android Kotlin Implementation (Phase 1) ✅

  **What to do**:
  - Implement `HybridNitroVLCView` in Kotlin
  - Wrap libvlc-all MediaPlayer
  - Implement all methods from interface (play, pause, seek, stop, setVolume)
  - Implement all callbacks (onProgress, onPlaying, etc.)
  - Handle IVLCVout.OnNewVideoLayoutListener events
  - Set up video rendering surface (SurfaceView)

  **Must NOT do**:
  - Do not implement PiP transforms
  - Do not implement recording/snapshot
  - Do not add libc++_shared.so workarounds (handle in integration)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex native code requiring Kotlin + VLC expertise
  - **Skills**: [`react-native-best-practices`]
    - `react-native-best-practices`: Native module patterns

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Task 6)
  - **Blocks**: Tasks 8, 11
  - **Blocked By**: Task 5

  **References**:
  - `packages/app/vendor/react-native-vlc-media-player/android/src/main/java/com/yuanzhou/vlc/vlcplayer/ReactVlcPlayerView.java` - Existing Java implementation
  - `packages/app/vendor/react-native-vlc-media-player/android/build.gradle:47` - libvlc dependency
  - `https://nitro.margelo.com/docs/view-components` - HybridView Kotlin implementation

  **Acceptance Criteria**:

  **TDD:**
  - Test file: `packages/react-native-nitro-vlc/android/src/test/java/com/nitrovlc/HybridNitroVLCViewTest.kt`
  - Test: Player initializes without crash
  - Test: play() starts media playback
  - Test: pause() pauses media playback
  - Command: `cd packages/react-native-nitro-vlc/android && ./gradlew test`

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Android native code compiles
    Tool: Bash (gradle)
    Preconditions: Kotlin implementation complete
    Steps:
      1. cd packages/react-native-nitro-vlc/example/android
      2. ./gradlew assembleDebug 2>&1 | tail -100
    Expected Result: BUILD SUCCESSFUL
    Evidence: .sisyphus/evidence/task-7-android-build.log

  Scenario: Kotlin unit tests pass
    Tool: Bash (gradle test)
    Preconditions: Tests written
    Steps:
      1. cd packages/react-native-nitro-vlc/android
      2. ./gradlew test
    Expected Result: BUILD SUCCESSFUL, all tests pass
    Evidence: .sisyphus/evidence/task-7-android-tests.log
  ```

  **Commit**: YES
  - Message: `feat(nitro-vlc): implement Android Kotlin HybridView with libvlc`
  - Files: `packages/react-native-nitro-vlc/android/**/*.kt`

---

- [x] 8. Run Nitrogen Codegen (Phase 1) ✅

  **What to do**:
  - Run `npx nitrogen` to generate C++ bindings
  - Verify generated files in `nitrogen/generated/`
  - Update podspec to include generated files
  - Update build.gradle to include generated files
  - Verify both platforms still build

  **Must NOT do**:
  - Do not manually edit generated files
  - Do not skip verification builds

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Command execution and verification
  - **Skills**: [`expo-dev-client`]
    - `expo-dev-client`: Build system expertise

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on 5, 6, 7)
  - **Parallel Group**: Sequential
  - **Blocks**: Task 9
  - **Blocked By**: Tasks 5, 6, 7

  **References**:
  - `packages/react-native-nitro-vlc/nitro.json` - Nitrogen config
  - `https://nitro.margelo.com/docs/nitrogen` - Nitrogen CLI docs

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Nitrogen generates files successfully
    Tool: Bash (npx nitrogen)
    Preconditions: Tasks 5, 6, 7 complete
    Steps:
      1. cd packages/react-native-nitro-vlc
      2. npx nitrogen
      3. ls nitrogen/generated/
    Expected Result: Generated files present (ios/, android/, shared/)
    Evidence: .sisyphus/evidence/task-8-nitrogen-output.log

  Scenario: iOS still builds with generated code
    Tool: Bash (xcodebuild)
    Preconditions: Nitrogen run
    Steps:
      1. cd packages/react-native-nitro-vlc/example
      2. npx pod-install
      3. xcodebuild -workspace ios/NitroVLCExample.xcworkspace -scheme NitroVLCExample -sdk iphonesimulator build
    Expected Result: BUILD SUCCEEDED
    Evidence: Build log captured

  Scenario: Android still builds with generated code
    Tool: Bash (gradle)
    Preconditions: Nitrogen run
    Steps:
      1. cd packages/react-native-nitro-vlc/example/android
      2. ./gradlew assembleDebug
    Expected Result: BUILD SUCCESSFUL
    Evidence: Build log captured
  ```

  **Commit**: YES
  - Message: `feat(nitro-vlc): generate C++ bindings with Nitrogen`
  - Files: `packages/react-native-nitro-vlc/nitrogen/generated/**`

---

- [x] 9. Create Example App (Phase 1) ✅

  **What to do**:
  - Create minimal React Native app in `example/` directory
  - Add NitroVLCPlayer component usage
  - Test with sample video URL
  - Verify all callbacks fire correctly
  - Add basic UI controls (play/pause button, seek slider)

  **Must NOT do**:
  - Do not create full-featured app
  - Do not test PiP functionality

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: React Native app creation
  - **Skills**: [`building-native-ui`, `expo-dev-client`]
    - `building-native-ui`: React Native UI patterns
    - `expo-dev-client`: Example app setup

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on 8)
  - **Parallel Group**: Sequential
  - **Blocks**: Tasks 10, 11, 12
  - **Blocked By**: Task 8

  **References**:
  - `https://github.com/mrousavy/react-native-nitro-image/tree/main/example` - Reference example app
  - `packages/app/components/video-player/VlcVideoView.tsx` - Usage patterns

  **Acceptance Criteria**:

  **TDD:**
  - Test file: `packages/react-native-nitro-vlc/example/src/__tests__/App.test.tsx`
  - Test: App renders without crash
  - Test: NitroVLCPlayer component mounts
  - Command: `cd packages/react-native-nitro-vlc/example && bun test`

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Example app plays video on iOS
    Tool: Playwright (or xcrun simctl + manual log verification)
    Preconditions: Example app built
    Steps:
      1. Build and install example app on iOS simulator
      2. Open app
      3. Tap play button
      4. Wait for video to start
      5. Check console logs for onPlaying callback
    Expected Result: Video plays, onPlaying callback fires
    Evidence: .sisyphus/evidence/task-9-ios-playback.png (screenshot)

  Scenario: Example app plays video on Android
    Tool: Bash (adb)
    Preconditions: Example app built
    Steps:
      1. cd packages/react-native-nitro-vlc/example/android
      2. ./gradlew installDebug
      3. adb shell am start -n com.nitrovlcexample/.MainActivity
      4. adb logcat -s ReactNativeJS:D | grep -E "onPlaying|onProgress" | head -10
    Expected Result: onPlaying and onProgress logs appear
    Evidence: .sisyphus/evidence/task-9-android-playback.log
  ```

  **Commit**: YES
  - Message: `feat(nitro-vlc): create example app with basic playback controls`
  - Files: `packages/react-native-nitro-vlc/example/**`

---

- [x] 10. iOS Integration Tests (Phase 1) ✅

  **What to do**:
  - Write comprehensive iOS integration tests
  - Test all playback controls (play, pause, seek, stop)
  - Test all callbacks fire with correct data
  - Test error handling (invalid URL)
  - Test network stream playback

  **Must NOT do**:
  - Do not test PiP
  - Do not test recording/snapshot

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Comprehensive test writing
  - **Skills**: [`react-native-best-practices`]
    - `react-native-best-practices`: Testing patterns

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Task 11)
  - **Blocks**: Task 12
  - **Blocked By**: Tasks 6, 9

  **References**:
  - `packages/react-native-nitro-vlc/src/NitroVLC.nitro.ts` - Interface to test against
  - XCTest documentation

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: All iOS integration tests pass
    Tool: Bash (xcodebuild test)
    Preconditions: Tests written
    Steps:
      1. xcodebuild test -workspace packages/react-native-nitro-vlc/example/ios/NitroVLCExample.xcworkspace -scheme NitroVLCExample -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 16'
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-10-ios-integration-tests.log
  ```

  **Commit**: YES
  - Message: `test(nitro-vlc): add iOS integration tests`
  - Files: `packages/react-native-nitro-vlc/ios/**/*Tests.swift`

---

- [x] 11. Android Integration Tests (Phase 1) ✅

  **What to do**:
  - Write comprehensive Android integration tests
  - Test all playback controls (play, pause, seek, stop)
  - Test all callbacks fire with correct data
  - Test error handling (invalid URL)
  - Test network stream playback

  **Must NOT do**:
  - Do not test PiP
  - Do not test recording/snapshot

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Comprehensive test writing
  - **Skills**: [`react-native-best-practices`]
    - `react-native-best-practices`: Testing patterns

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Task 10)
  - **Blocks**: Task 12
  - **Blocked By**: Tasks 7, 9

  **References**:
  - `packages/react-native-nitro-vlc/src/NitroVLC.nitro.ts` - Interface to test against
  - JUnit/Espresso documentation

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: All Android integration tests pass
    Tool: Bash (gradle connectedAndroidTest)
    Preconditions: Tests written, emulator running
    Steps:
      1. cd packages/react-native-nitro-vlc/example/android
      2. ./gradlew connectedAndroidTest
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-11-android-integration-tests.log
  ```

  **Commit**: YES
  - Message: `test(nitro-vlc): add Android integration tests`
  - Files: `packages/react-native-nitro-vlc/android/**/*Test.kt`

---

### Phase 2: PearTube Integration

- [x] 12. Create Integration Layer in PearTube (Phase 2) ✅

  **What to do**:
  - Add `react-native-nitro-vlc` as dependency to `packages/app`
  - Create `NitroVlcVideoView.tsx` wrapper component
  - Add `USE_NITRO_VLC` feature flag
  - Update `VlcVideoView.tsx` to conditionally use Nitro or legacy
  - Map all existing callbacks to Nitro callbacks
  - Handle libc++_shared.so conflict in Android build

  **Must NOT do**:
  - Do not remove old VLC code yet
  - Do not change VideoPlayerContext.tsx
  - Do not change callback signatures

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex integration requiring careful compatibility
  - **Skills**: [`react-native-best-practices`, `holepunch-p2p-architect`]
    - `react-native-best-practices`: Integration patterns
    - `holepunch-p2p-architect`: PearTube architecture knowledge

  **Parallelization**:
  - **Can Run In Parallel**: NO (critical path)
  - **Parallel Group**: Sequential
  - **Blocks**: Tasks 13, 14
  - **Blocked By**: Tasks 9, 10, 11

  **References**:
  - `packages/app/components/video-player/VlcVideoView.tsx` - Existing wrapper
  - `packages/app/components/video-player/VideoContainer.tsx` - Platform switching
  - `packages/app/lib/VideoPlayerContext.tsx` - Callback usage

  **Acceptance Criteria**:

  **TDD:**
  - Test file: `packages/app/components/video-player/__tests__/NitroVlcVideoView.test.tsx`
  - Test: Component renders without crash
  - Test: Callbacks are forwarded correctly
  - Command: `cd packages/app && bun test components/video-player/__tests__/NitroVlcVideoView.test.tsx`

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: PearTube builds with Nitro VLC
    Tool: Bash (build commands)
    Preconditions: Integration complete
    Steps:
      1. cd packages/app
      2. USE_NITRO_VLC=true npm run ios:prepare
      3. xcodebuild -workspace ios/PearTube.xcworkspace -scheme PearTube -sdk iphonesimulator build
    Expected Result: BUILD SUCCEEDED
    Evidence: .sisyphus/evidence/task-12-peartube-build.log

  Scenario: Feature flag switches between implementations
    Tool: Bash (grep)
    Preconditions: Code complete
    Steps:
      1. grep -A5 "USE_NITRO_VLC" packages/app/components/video-player/VlcVideoView.tsx
    Expected Result: Conditional import/render logic present
    Evidence: Code inspection logged
  ```

  **Commit**: YES
  - Message: `feat(app): integrate react-native-nitro-vlc with feature flag`
  - Files: `packages/app/components/video-player/NitroVlcVideoView.tsx`, `packages/app/components/video-player/VlcVideoView.tsx`, `packages/app/package.json`

---

- [x] 13. Update HLS Coordination Layer (Phase 2) ✅

  **What to do**:
  - Verify Nitro VLC works with local blob server URLs
  - Ensure HLS streaming from transcoder works correctly
  - Update any URL handling if needed
  - Test with actual P2P video content

  **Must NOT do**:
  - Do not modify HLS transcoder backend
  - Do not change URL format

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: P2P/HLS coordination expertise needed
  - **Skills**: [`holepunch-p2p-architect`]
    - `holepunch-p2p-architect`: P2P video streaming expertise

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on 12)
  - **Parallel Group**: Sequential
  - **Blocks**: Task 14
  - **Blocked By**: Task 12

  **References**:
  - `packages/backend/src/blob-server.js` - Blob server URL format
  - `packages/app/lib/VideoPlayerContext.tsx:560-600` - URL generation
  - `RESEARCH-P2P-VIDEO-STARTUP.md` - P2P video architecture

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Nitro VLC plays local blob server content
    Tool: Bash (adb logcat)
    Preconditions: PearTube running with Nitro VLC, video available
    Steps:
      1. Start PearTube with USE_NITRO_VLC=true
      2. Play a P2P video
      3. adb logcat | grep -E "NitroVLC|onProgress" | head -20
    Expected Result: Video plays, progress updates appear
    Evidence: .sisyphus/evidence/task-13-p2p-playback.log

  Scenario: HLS streaming works with Nitro VLC
    Tool: Bash (adb logcat)
    Preconditions: Chromecast or HLS mode active
    Steps:
      1. Enable HLS transcoding (cast to device or force HLS mode)
      2. Play video
      3. Check logs for HLS segment requests
    Expected Result: HLS segments requested and played
    Evidence: .sisyphus/evidence/task-13-hls-playback.log
  ```

  **Commit**: YES
  - Message: `feat(app): verify Nitro VLC HLS coordination`
  - Files: Any coordination changes needed

---

- [x] 14. Final Integration Tests (Phase 2) ✅

  **What to do**:
  - Run full E2E test suite with Nitro VLC enabled
  - Compare performance against baselines from Task 1
  - Verify no regressions in video playback
  - Document final performance metrics
  - Update documentation

  **Must NOT do**:
  - Do not test PiP (Phase 3)
  - Do not declare success if performance regresses

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Comprehensive verification
  - **Skills**: [`react-native-best-practices`, `holepunch-p2p-architect`]
    - `react-native-best-practices`: Performance testing
    - `holepunch-p2p-architect`: Integration verification

  **Parallelization**:
  - **Can Run In Parallel**: NO (final task)
  - **Parallel Group**: Sequential (final)
  - **Blocks**: None
  - **Blocked By**: Tasks 12, 13

  **References**:
  - `.sisyphus/evidence/vlc-baselines.md` - Baseline measurements from Task 1
  - All previous test evidence

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Performance meets or exceeds baseline
    Tool: Bash (measurement + comparison)
    Preconditions: All previous tasks complete
    Steps:
      1. Measure Nitro VLC start time (same method as Task 1)
      2. Measure Nitro VLC seek latency
      3. Compare against baselines in .sisyphus/evidence/vlc-baselines.md
    Expected Result: Nitro VLC <= baseline (no regression)
    Evidence: .sisyphus/evidence/task-14-performance-comparison.md

  Scenario: All callbacks work in PearTube
    Tool: Bash (adb logcat)
    Preconditions: PearTube running with Nitro VLC
    Steps:
      1. Play video → verify onPlaying
      2. Pause video → verify onPaused
      3. Seek to 50% → verify onProgress shows ~50%
      4. Let video end → verify onEnded
      5. Load invalid URL → verify onError
    Expected Result: All 5 callbacks verified
    Evidence: .sisyphus/evidence/task-14-callback-verification.log

  Scenario: TypeScript compiles clean
    Tool: Bash (tsc)
    Preconditions: All code complete
    Steps:
      1. cd packages/app
      2. npx tsc --noEmit
    Expected Result: Exit code 0, no errors
    Evidence: TypeScript clean
  ```

  **Commit**: YES
  - Message: `docs: complete Nitro VLC integration with performance metrics`
  - Files: `CHANGELOG.md`, any documentation updates

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 2 | `feat(ios): enable New Architecture` | `ios/Podfile` | xcodebuild |
| 3 | `feat: scaffold react-native-nitro-vlc` | `packages/react-native-nitro-vlc/**` | ls, node |
| 4 | `feat(nitro-vlc): POC validates compatibility` | POC files | bun test |
| 5 | `feat(nitro-vlc): define TypeScript interface` | `*.nitro.ts` | tsc |
| 6 | `feat(nitro-vlc): iOS Swift implementation` | `ios/**/*.swift` | xcodebuild |
| 7 | `feat(nitro-vlc): Android Kotlin implementation` | `android/**/*.kt` | gradle |
| 8 | `feat(nitro-vlc): Nitrogen codegen` | `nitrogen/generated/**` | build both |
| 9 | `feat(nitro-vlc): example app` | `example/**` | run on both |
| 10 | `test(nitro-vlc): iOS integration tests` | `*Tests.swift` | xcodebuild test |
| 11 | `test(nitro-vlc): Android integration tests` | `*Test.kt` | gradle test |
| 12 | `feat(app): integrate Nitro VLC` | app integration | xcodebuild |
| 13 | `feat(app): HLS coordination` | coordination changes | playback test |
| 14 | `docs: complete integration` | docs | full test |

---

## Success Criteria

### Verification Commands
```bash
# Package builds
cd packages/react-native-nitro-vlc && npm run build
# Expected: exit code 0

# TypeScript clean
cd packages/app && npx tsc --noEmit
# Expected: exit code 0, no errors

# iOS builds with New Arch
cd packages/app && xcodebuild -workspace ios/PearTube.xcworkspace -scheme PearTube -sdk iphonesimulator build
# Expected: BUILD SUCCEEDED

# Android builds
cd packages/app/android && ./gradlew assembleDebug
# Expected: BUILD SUCCESSFUL

# Feature flag works
USE_NITRO_VLC=true npm run ios
# Expected: Video plays using Nitro VLC
```

### Final Checklist
- [ ] All "Must Have" features implemented and working
- [ ] All "Must NOT Have" items NOT present
- [ ] Performance meets or exceeds baseline
- [ ] All tests pass
- [ ] TypeScript compiles clean
- [ ] Feature flag allows switching between old and Nitro VLC
