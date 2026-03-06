# Android Split-Activity PiP Plan (NextPlayer-Style)

## Goal

Achieve Android UX where:

- Minimizing video keeps user inside app browsing flow.
- Video can be moved into system PiP without forcing app to "close" to launcher.
- Tapping PiP restores full player UI for the same playback session.

This requires a split-activity model:

- `MainActivity` -> browse/navigation host.
- `PlayerActivity` -> playback host + PiP owner.

Single-activity React Native cannot provide this behavior cleanly.

## Current State (repo)

- Android PiP plumbing exists in `expo-media-session`:
  - `packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt`
  - `packages/app/android/app/src/main/java/com/peartube/app/MainActivity.kt`
  - `packages/app/android/app/src/main/AndroidManifest.xml`
- In-app mini-player logic exists in:
  - `packages/app/lib/VideoPlayerContext.tsx`
  - `packages/app/lib/playerStateMachine.ts`
  - `packages/app/components/VideoPlayerOverlayImpl.tsx`

## Target Architecture

### Activity Roles

1. `MainActivity` (browse)
   - Owns tabs/feed/studio/settings navigation.
   - No direct ownership of active playback surface when session is promoted to PlayerActivity.

2. `PlayerActivity` (playback + PiP)
   - Hosts full player route/surface.
   - Enters/exits PiP via `PictureInPictureParams`.
   - Handles PiP actions and restore events.

### Session Ownership

- Playback session ID becomes activity-agnostic.
- Session metadata stored in a native singleton/service already used by media session layer.
- JS receives events and renders current mode; native retains transport continuity during transitions.

### Mode Semantics

- `fullscreen` = active in PlayerActivity.
- `mini` = optional in-app mini in MainActivity (phase-dependent).
- `pip` = OS PiP owned by PlayerActivity.
- `hidden` = session closed.

## Phased Implementation

## Phase 0 - Safety Rails (no UX change)

1. Keep minimize behavior as in-app mini for now.
2. Ensure PiP remains tied to app background/home transition path.
3. Add clear analytics/logging tags for activity + mode transitions.

Acceptance:

- No regression in current single-activity flow.

## Phase 1 - Introduce PlayerActivity shell

1. Add `PlayerActivity` in Android app module.
2. Register `PlayerActivity` in `AndroidManifest.xml` with PiP support and required configChanges.
3. Add native intent helpers in media session module:
   - `openPlayerActivity(sessionPayload)`
   - `restoreFromPip()`
4. Keep existing `MainActivity` PiP callbacks untouched until cutover.

Files to touch:

- `packages/app/android/app/src/main/java/com/peartube/app/PlayerActivity.kt` (new)
- `packages/app/android/app/src/main/AndroidManifest.xml`
- `packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt`

Acceptance:

- PlayerActivity launches and returns without playback state loss.

## Phase 2 - Route playback ownership to PlayerActivity

1. On fullscreen open, launch PlayerActivity instead of rendering full player in MainActivity.
2. Keep MainActivity alive behind PlayerActivity.
3. Enter PiP from PlayerActivity only.
4. On PiP tap/restore, ensure PlayerActivity regains foreground.

Files to touch:

- `packages/app/lib/VideoPlayerContext.tsx`
- `packages/app/lib/playerStateMachine.ts`
- `packages/app/modules/expo-media-session/src/index.ts`
- `packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt`

Acceptance:

- Home -> PiP works.
- App remains browsable via MainActivity while PiP active.
- PiP restore returns to same video/time.

## Phase 3 - Decommission Android custom mini path

1. Remove Android-only mini layout/gesture branches in overlay code.
2. Keep mini implementation for iOS/web/desktop.
3. Keep single JS contract; use platform-specific backend behavior.

Files to touch:

- `packages/app/components/VideoPlayerOverlayImpl.tsx`
- `packages/app/lib/playerStateMachine.ts`
- `packages/app/lib/video-player/playerModeContract.ts`

Acceptance:

- Android path no longer depends on custom mini animation stack for core browsing + PiP flow.

## Phase 4 - Stabilization

1. Handle edge cases:
   - Rotation during PiP
   - Back button behavior across activities
   - Notification/remote actions while browse activity foregrounded
2. Harden restore policies for race windows around PiP exit.

Acceptance:

- No playback gaps across PiP enter/exit and activity swaps.
- No duplicate player instances.

## Non-Goals (for this migration)

- Desktop mini-player redesign.
- iOS architecture rewrite to match Android activity model.

## Risks

1. React/Expo assumptions around single `ReactActivity` can complicate dual-activity hosting.
2. Duplicate RN root instances can create double-mount side effects if not guarded.
3. Playback ownership bugs can create hidden "double player" or pause races.

## Mitigations

1. Gate dual-activity flow behind Android feature flag.
2. Preserve one authoritative playback session in media session/native layer.
3. Add explicit lifecycle logs for mode/activity/session transitions.

## Execution Order (next)

1. Implement Phase 1 (PlayerActivity shell + manifest + bridge methods).
2. Add feature flag in JS/native.
3. Validate launch/return behavior before touching reducer/UI logic.
