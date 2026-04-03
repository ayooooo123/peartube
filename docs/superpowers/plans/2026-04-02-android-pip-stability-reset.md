# Android PiP Stability Reset Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PearTube Android PiP reliable by collapsing PiP ownership back to the active React Native player activity and narrowing `expo-media-session` to transport/metadata duties only.

**Architecture:** PearTube currently spreads PiP responsibilities across `VideoPlayerContext`, `VideoPlayerOverlayImpl`, `expo-media-session`, `PipBridge`, and a separate `PlayerActivity` host. The current worktree has moved further toward a split-host `PlayerActivity` design, so this plan now starts by validating whether that branch actually removed the original invalid `MainActivity` PiP-param write path. If it did not, the fallback remains the simpler MediaStorm-style single-host reset.

**Tech Stack:** Expo, React Native, `react-native-video`, Expo config plugins, Android `PictureInPictureParams`, Kotlin native module (`expo-media-session`), Node test runner, Maestro repro scripts.

---

## Status Check (2026-04-02)

**Current verdict:** The specific `MainActivity` PiP-param write bug looks fixed in source, but the branch is not end-to-end proven yet.

1. `MainActivity` is still non-PiP in the manifest, and `PlayerActivity` remains the only PiP-capable host.
2. `PipBridge.isPipHostActivity(...)` now recognizes only `PlayerActivity`, and both `updateActivityPipParams()` and `PipBridge.onUserLeaveHint()` now skip non-PiP hosts before any PiP-param write.
3. `VideoPlayerOverlayImpl.tsx` still arms auto-PiP from the inline watch player through `MediaSession.setAutoPictureInPicture(...)`, but the current native guardrails should prevent those writes from targeting `MainActivity`.
4. The source regression test now asserts that `MainActivity` is absent from PiP-host matching.
5. The newest Maestro artifact on disk predates the latest `MediaSessionModule.kt` and manifest edits, so the old failure logs are stale and cannot validate the current code.

This means the known root-cause path appears addressed in source, but stability is still unproven until a fresh repro run confirms it.

---

## File Map

- Modify: `packages/app/components/VideoPlayerOverlayImpl.tsx`
- Modify: `packages/app/components/video-player/PearInlineVideoView.tsx`
- Modify: `packages/app/lib/VideoPlayerContext.tsx`
- Modify: `packages/app/lib/playerStateMachine.ts`
- Modify: `packages/app/modules/expo-media-session/src/index.ts`
- Modify: `packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt`
- Modify: `packages/app/plugins/withAndroidPiP.js`
- Modify: `packages/app/plugins/withMainActivityPiPCallback.js`
- Modify: `packages/app/android/app/src/main/AndroidManifest.xml`
- Modify: `packages/app/android/app/src/main/java/com/peartube/app/MainActivity.kt`
- Delete or stop referencing: `packages/app/plugins/templates/PlayerActivity.kt.template`
- Delete or stop referencing: `packages/app/android/app/src/main/java/com/peartube/app/PlayerActivity.kt`
- Modify: `packages/app/tests/mobile-inline-player-integration.test.mjs`
- Create: `packages/app/tests/android-pip-architecture-regression.test.mjs`
- Modify: `packages/app/scripts/maestro-android-pip-repro.sh`
- Create: `packages/app/scripts/assert-android-pip-artifact.mjs`

## Current Worktree Assessment

1. The current branch has reintroduced a native `PlayerActivity` host, a generated `PlayerActivity.kt` template, and `PlaybackHostBridge` routing.
2. `MainActivity` remains non-PiP in the manifest, and current native PiP-host checks now exclude it.
3. `VideoPlayerOverlayImpl.tsx` still arms auto-PiP from the inline watch player via `MediaSession.setAutoPictureInPicture(...)`, so the split-host architecture still needs runtime validation even though the non-PiP write guard is now present.
4. The updated source tests now cover the host-classification fix, but there is still no fresh post-change Maestro artifact proving the current branch on device.

## Root Cause Summary

1. The original Android failure was `setPictureInPictureParams: Current activity does not support picture-in-picture.`
2. The source-level cause of that failure was `MediaSessionModule.updateActivityPipParams()` and related PiP helpers treating `MainActivity` as a valid PiP host even though the manifest removed `android:supportsPictureInPicture` from `MainActivity`.
3. The current source now appears to address that root cause by restricting PiP-host checks to `PlayerActivity` and bailing out early on non-PiP hosts.
4. The remaining uncertainty is operational rather than architectural: the branch still uses split-host ownership, and there is not yet a fresh artifact showing the current native code survives repeated PiP entry/exit flows on device.

## Recommendation

Treat the specific `MainActivity` invalid-write bug as **likely fixed in source**, but do **not** call the branch stable until a fresh device repro confirms it. The immediate job is no longer redesign first; it is verification first.

If the current split-host branch passes repeated Maestro/device repros with no `updateActivityPipParams: failed`, no `Current activity does not support picture-in-picture`, and no PiP writes attributed to `MainActivity`, keep it and then trim remaining complexity. If it still fails, fall back to the original simplification plan: remove split-host PiP ownership and go back to a single active playback host.

---

## Chunk 1: Re-Verify the Current Source-Level Fix

### Task 1: Prove the `MainActivity` invalid-write path is actually gone on device

**Files:**
- Modify: `packages/app/tests/mobile-inline-player-integration.test.mjs`
- Create: `packages/app/tests/android-pip-architecture-regression.test.mjs`
- Create: `packages/app/scripts/assert-android-pip-artifact.mjs`

- [ ] **Step 1: Lock the host-classification regression in source**

Add assertions that:
- `AndroidManifest.xml` keeps `MainActivity` non-PiP and `PlayerActivity` PiP-capable
- `MediaSessionModule.kt` does **not** treat `MainActivity` as a PiP host inside `updateActivityPipParams()`
- `PipBridge.onUserLeaveHint()` and `enterPictureInPictureDirect()` bail out on non-PiP hosts

- [ ] **Step 2: Write the artifact assertion script**

Create `packages/app/scripts/assert-android-pip-artifact.mjs` that reads a PiP repro artifact directory and fails on:
- `Current activity does not support picture-in-picture`
- `updateActivityPipParams: failed`
- any `PiP_WRITE` / `setPictureInPictureParams` log line attributed to `MainActivity` after the manifest removes `MainActivity` PiP support

- [ ] **Step 3: Run the source tests on the current code**

Run:
```bash
node --test packages/app/tests/mobile-inline-player-integration.test.mjs packages/app/tests/android-pip-architecture-regression.test.mjs
```

Expected:
- PASS for the host-classification fix

- [ ] **Step 4: Run a fresh Android PiP repro against the current native code**

Run:
```bash
cd packages/app && npm run test:android:pip:repro
```

Expected:
- fresh artifact directory with timestamps newer than the current `MediaSessionModule.kt` and manifest edits
- no `Current activity does not support picture-in-picture`
- no `updateActivityPipParams: failed`
- no PiP writes attributed to `MainActivity`

- [ ] **Step 5: Run the artifact assertion against the fresh repro output**

Run:
```bash
node packages/app/scripts/assert-android-pip-artifact.mjs packages/app/.artifacts/maestro-pip/<fresh-run-dir>
```

Expected:
- PASS

- [ ] **Step 6: Commit**

```bash
git add packages/app/tests/mobile-inline-player-integration.test.mjs packages/app/tests/android-pip-architecture-regression.test.mjs packages/app/scripts/assert-android-pip-artifact.mjs
git commit -m "test: lock android pip architecture regressions"
```

---

## Chunk 2: Validate the Current Split-Host Direction Before Going Further

### Task 2: Remove the remaining invalid `MainActivity` PiP-param write from the current split-host architecture

**Files:**
- Modify: `packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt`
- Modify: `packages/app/components/VideoPlayerOverlayImpl.tsx`
- Modify: `packages/app/lib/VideoPlayerContext.tsx`
- Modify: `packages/app/tests/mobile-inline-player-integration.test.mjs`
- Modify: `packages/app/tests/android-pip-architecture-regression.test.mjs`

- [ ] **Step 1: Write the failing host-resolution assertions**

Add tests asserting that:
- `resolvePlaybackHostActivity()` is not allowed to push PiP params to `MainActivity` when `MainActivity` lacks `android:supportsPictureInPicture`
- `updateActivityPipParams()` treats only a PiP-capable host as eligible
- first fullscreen playback on the watch page does not require a speculative PiP-param write to `MainActivity`

- [ ] **Step 2: Run the tests to verify failure**

Run:
```bash
node --test packages/app/tests/mobile-inline-player-integration.test.mjs packages/app/tests/android-pip-architecture-regression.test.mjs
```

Expected:
- FAIL because the current split-host branch still leaks PiP writes onto `MainActivity`

- [ ] **Step 3: Implement the minimal split-host correction**

Make the current split-host branch internally coherent:
- `updateActivityPipParams()` must never call `setPictureInPictureParams()` on `MainActivity`
- `MainActivity` leave-hint delegation may launch `PlayerActivity`, but the watch-page inline path must not pre-arm PiP through a non-PiP host
- if necessary, gate `MediaSession.setAutoPictureInPicture(...)` until `PlayerActivity` is actually active, or move that PiP arming responsibility out of the inline overlay path entirely

- [ ] **Step 4: Run the Android repro flow**

Run:
```bash
cd packages/app && npm run test:android:pip:repro
```

Expected:
- no `Current activity does not support picture-in-picture`
- no `updateActivityPipParams: failed`
- no PiP-param writes attributed to `MainActivity`

- [ ] **Step 5: Re-run the tests**

Run:
```bash
node --test packages/app/tests/mobile-inline-player-integration.test.mjs packages/app/tests/android-pip-architecture-regression.test.mjs
```

Expected:
- PASS

- [ ] **Step 6: Commit**

```bash
git add packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt packages/app/components/VideoPlayerOverlayImpl.tsx packages/app/lib/VideoPlayerContext.tsx packages/app/tests/mobile-inline-player-integration.test.mjs packages/app/tests/android-pip-architecture-regression.test.mjs packages/app/.artifacts/maestro-pip
git commit -m "fix(android): stop writing pip params to non-pip MainActivity"
```

---

## Chunk 3: Fallback Reset if the Current Split-Host Branch Still Fails

### Task 3: Remove PiP window-management from the media session module

**Files:**
- Modify: `packages/app/modules/expo-media-session/src/index.ts`
- Modify: `packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt`
- Modify: `packages/app/lib/VideoPlayerContext.tsx`
- Modify: `packages/app/lib/playerStateMachine.ts`

- [ ] **Step 1: Write the failing regression test for media-session scope**

Add assertions that active code no longer depends on:
- `openPlayerActivity`
- `launchPlayerActivityForPipFrom`
- `setAutoPictureInPicture`
- PiP-specific bridge routing through media-session when split mode is off

- [ ] **Step 2: Run the test to verify failure**

Run:
```bash
node --test packages/app/tests/mobile-inline-player-integration.test.mjs packages/app/tests/android-pip-architecture-regression.test.mjs
```

Expected:
- FAIL because JS/native still call media-session PiP helpers

- [ ] **Step 3: Implement the minimal scope reduction**

Change the code so that:
- `expo-media-session` keeps only metadata, remote commands, and optional background audio
- `VideoPlayerContext` no longer treats media-session as the owner of PiP transitions
- `PipBridge` custom action, source-rect, and PlayerActivity launch logic are removed or made unreachable
- the player still receives PiP state changes, but exit recovery is reduced to one owner

- [ ] **Step 4: Simplify the state machine**

Update `VideoPlayerContext.tsx` and `playerStateMachine.ts` to:
- remove split-host assumptions
- delete PiP exit “reassert play” paths that only existed because native and JS were fighting
- keep only one Android background rule: fullscreen + active video + user leaves app => PiP, otherwise normal background behavior

- [ ] **Step 5: Re-run the tests**

Run:
```bash
node --test packages/app/tests/mobile-inline-player-integration.test.mjs packages/app/tests/android-pip-architecture-regression.test.mjs
```

Expected:
- PASS

- [ ] **Step 6: Commit**

```bash
git add packages/app/modules/expo-media-session/src/index.ts packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt packages/app/lib/VideoPlayerContext.tsx packages/app/lib/playerStateMachine.ts packages/app/tests/mobile-inline-player-integration.test.mjs packages/app/tests/android-pip-architecture-regression.test.mjs
git commit -m "refactor(android): narrow media session responsibilities for pip stability"
```

---

## Chunk 4: Rebuild the JS PiP Flow to Match the Simpler MediaStorm Pattern

### Task 4: Keep PiP state in the player/overlay layer and stop over-correcting in JS

**Files:**
- Modify: `packages/app/components/VideoPlayerOverlayImpl.tsx`
- Modify: `packages/app/components/video-player/PearInlineVideoView.tsx`
- Modify: `packages/app/lib/VideoPlayerContext.tsx`

- [ ] **Step 1: Write the failing regression tests for the active player path**

Add assertions that:
- inline `react-native-video` is still the native player
- PiP entry is driven by the inline player ref
- app backgrounding does not require `PlayerActivity`
- overlay auto-PiP arming no longer routes through media-session PiP ownership

- [ ] **Step 2: Run the tests to verify failure**

Run:
```bash
node --test packages/app/tests/mobile-inline-player-integration.test.mjs packages/app/tests/android-pip-architecture-regression.test.mjs
```

Expected:
- FAIL while overlay/context still depend on the old plumbing

- [ ] **Step 3: Implement the minimal JS simplification**

Bring the flow closer to MediaStorm:
- manual PiP button uses `playerRef.current?.enterPip?.()`
- background-from-fullscreen path triggers PiP directly from the player layer
- JS keeps a single `isInPipMode` state and stops trying to infer PiP from multiple independent heuristics
- loading overlay and resume logic stop special-casing split-host transitions

- [ ] **Step 4: Re-run the tests**

Run:
```bash
node --test packages/app/tests/mobile-inline-player-integration.test.mjs packages/app/tests/android-pip-architecture-regression.test.mjs
```

Expected:
- PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/components/VideoPlayerOverlayImpl.tsx packages/app/components/video-player/PearInlineVideoView.tsx packages/app/lib/VideoPlayerContext.tsx packages/app/tests/mobile-inline-player-integration.test.mjs packages/app/tests/android-pip-architecture-regression.test.mjs
git commit -m "refactor(android): simplify js pip lifecycle around inline player"
```

---

## Chunk 5: Device Verification and Decision Gate

### Task 5: Validate the chosen path on real Android behavior and then decide whether iOS needs MediaStorm-style warm-up work

**Files:**
- Modify: `packages/app/scripts/maestro-android-pip-repro.sh`
- Modify: `packages/app/components/video-player/PearInlineVideoView.tsx` (only if iOS follow-up is needed)
- Modify: `packages/app/components/VideoPlayerOverlayImpl.tsx` (only if iOS follow-up is needed)

- [ ] **Step 1: Run the Android repro script on the chosen build**

Run:
```bash
cd packages/app && npm run test:android:pip:repro
```

Expected:
- PiP enters from fullscreen consistently
- no `Current activity does not support picture-in-picture`
- no unexpected `updateActivityPipParams: failed`
- playback remains active across Home -> PiP -> restore

- [ ] **Step 2: Validate the generated artifact with the assertion script**

Run:
```bash
node packages/app/scripts/assert-android-pip-artifact.mjs packages/app/.artifacts/maestro-pip/<latest>
```

Expected:
- PASS

- [ ] **Step 3: Manually verify repeated cycles**

Manual checks:
- Enter PiP, restore, repeat 5 times
- Start in fullscreen, Home to PiP, restore, background again
- Pause in PiP, resume in PiP, restore
- Dismiss PiP and confirm the session closes cleanly

- [ ] **Step 4: Decide whether iOS needs parity work**

Only if iOS still shows first-entry or resume glitches:
- add MediaStorm-style first-play PiP controller warm-up
- keep iOS PiP ownership in the player layer, not the media-session layer

- [ ] **Step 5: Commit**

```bash
git add packages/app/scripts/maestro-android-pip-repro.sh packages/app/scripts/assert-android-pip-artifact.mjs
git commit -m "test(android): verify stable pip flow"
```

---

## Success Criteria

- No Android log line contains `Current activity does not support picture-in-picture`
- No PiP-param write targets `MainActivity` while `MainActivity` lacks `android:supportsPictureInPicture`
- The current split-host branch either passes repeated device/Maestro repros or is explicitly abandoned in favor of the fallback simplification
- PiP enter/exit no longer needs multi-layer recovery guards to preserve playback
- Repeated PiP cycles are stable on device and in the Maestro artifact check

## Non-Goals

- Do not redesign desktop/Pear playback in this effort
- Do not add new PiP features or custom PiP action UX before stability is proven
- Do not preserve `PlayerActivity` as dormant complexity “just in case” unless it passes the verification gate and demonstrably improves stability

## Notes for the Implementer

- Prefer deleting PiP-specific code over patching it.
- If a fix depends on another new guard window, pause and question the architecture again.
- Use MediaStorm as the reference for responsibility boundaries, not as a literal file-by-file port.
