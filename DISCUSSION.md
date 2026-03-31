# Task: Light cleanup after Android PiP stabilization + add regression checklist

## Goal
Do a minimal, low-risk cleanup pass now that Android PiP is working.

## Constraints
- No behavior changes unless obviously dead/comment-only cleanup
- Do not destabilize working PiP
- Keep cleanup small and focused

## Desired outcomes
1. Remove or tighten any obviously stale/misleading comments left over from earlier failed PiP theories
2. Add a short regression checklist note in the repo for future PiP changes
3. Avoid touching working logic unless the change is purely clarifying

## Candidate cleanup areas
- `packages/app/components/VideoPlayerOverlayImpl.tsx`
  - comments around Android PiP assumptions / mini-mode handling
- `packages/app/lib/VideoPlayerContext.tsx`
  - comments around backgrounding from mini mode
- `packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt`
  - comments now that dead old-player reflection hooks were removed
- Add a small doc/checklist file, e.g. `docs/android-pip-regression-checklist.md`

## Suggested checklist content
- test repeated fullscreen PiP entry cycles
- test mini-player active then leave app
- test exit PiP back to app and retry immediately
- confirm native rebuild required after Kotlin changes
- avoid reintroducing old-player-specific bridge assumptions
- keep Android PiP entry path native and simple

## Discussion

## Claude Proposal

### Safe comment/doc-only cleanup edits

After inspecting the three candidate files, here are the low-risk edits organized by confidence:

#### 1. `MediaSessionModule.kt` — PipBridge (comments only)

| Line(s) | Current | Proposed | Rationale |
|----------|---------|----------|-----------|
| 41 | `Simplified PiP bridge for MainActivity callbacks.` | `PiP bridge: wires Activity lifecycle (onUserLeaveHint, onPictureInPictureModeChanged) to the JS PiP state machine via MediaSessionModule.` | The old doc is from a time before the bridge stabilized; "simplified" is misleading given its current scope. |
| 313 | `// Apply SurfaceView transforms (skipped for MainActivity)` | `// Legacy SurfaceView transforms — no-ops for MainActivity (early return inside). NitroVLC uses TextureView; this path only fires for non-MainActivity activities (none currently exist).` | Adds context that this code is effectively dead but harmless. Avoids a future contributor adding SurfaceView logic thinking it's active. |
| 462 | `/** Legacy: find SurfaceViews only ... */` | `/** Legacy: finds SurfaceViews only. NitroVLC switched to TextureView — this is only referenced by applySurfaceViewTransforms and setSurfaceViewInset, both effectively no-ops for the current player. Safe to remove in a future cleanup pass. */` | Documents the dead-code status without removing it. |

#### 2. `VideoPlayerOverlayImpl.tsx` — stale/misleading comments

| Line(s) | Current | Proposed | Rationale |
|----------|---------|----------|-----------|
| 850 | `// TODO: unify positioning branches and remove this flag entirely.` | `// TODO(low-pri): unify positioning branches and remove this flag entirely. Currently harmless — mobile always uses bottom-relative, web uses top-computed.` | Softens urgency, adds context so nobody treats it as a blocker. |
| 2165–2168 | `// The inline Android watch player now uses the shared Media3 PlayerView host. // Translating its underlying SurfaceView down clips ...` | `// Legacy SurfaceView inset — always sends 0. NitroVLC uses TextureView and handles its own layout. This call is a no-op on the native side for MainActivity but kept for defensive compat.` | The current comment references "Media3 PlayerView host" which is not what the app uses anymore. |

#### 3. `VideoPlayerContext.tsx` — comment tightening

| Area | Current | Proposed | Rationale |
|------|---------|----------|-----------|
| Lines 476–480 (mini→fullscreen PiP handoff) | `// Reliability-first PiP handoff: when backgrounding from in-app mini // mode, restore fullscreen first so Android PiP enters from the stable // full-screen layout. // This is less elegant than direct mini->PiP continuity, but repeated // testing shows mini-mode PiP entry is the unstable path.` | `// PiP handoff: restore fullscreen before PiP entry when backgrounding from mini mode. // Direct mini→PiP is unreliable (TextureView resize kills SurfaceTexture). // See MEMORY.md: "Android PiP — TextureView LayoutParams must NOT change".` | Tighter, links to the root cause instead of vague "less elegant". |
| Line 907 | `// Some layers identify a video by id while others may still use legacy path formats.` | Remove or replace with: `// Normalize video identifier: backends use drive key, UI uses display path.` | "legacy path formats" implies something is broken; actually it's just two valid ID schemes. |

### Edits NOT recommended (too risky or ambiguous)

| Code | Why skip |
|------|----------|
| Remove `applySurfaceViewTransforms` + `findSurfaceViews` + `setSurfaceViewInset` entirely | Called on every PiP state change. Removing changes the call graph. Low risk but not zero — defer to a dedicated cleanup PR with a native rebuild + device test. |
| Remove `surfaceViewInsetPx` field from PipBridge | Same — wired to a JS-exposed `AsyncFunction`. Removal requires coordinated TS + Kotlin change. |
| Tighten `notifyPipModeChanged` dismissal-pause logic (nested `run {}` blocks) | Functional, tested, messy but not misleading. Refactoring risks timing changes in the dismissal detection polling loop. |

### Regression checklist doc outline

Proposed file: `docs/android-pip-regression-checklist.md`

```markdown
# Android PiP Regression Checklist

Run after ANY change to PiP-related code (Kotlin bridge, VideoPlayerContext,
VideoPlayerOverlayImpl PiP branches, or NitroVLC surface management).

## Prerequisites
- Physical Android device (emulator PiP behavior differs)
- Android 12+ preferred (seamless PiP / setAutoEnterEnabled)
- Fresh native build (`npm run android`) after Kotlin changes

## Core scenarios

### 1. Fullscreen → PiP → return (×3 cycles)
- [ ] Enter fullscreen, press Home → PiP window appears
- [ ] Tap PiP to return → fullscreen resumes, controls work
- [ ] Repeat 2 more times without restarting — no black screen, no stuck state

### 2. Mini-player → background → PiP
- [ ] Play video, minimize to mini-player
- [ ] Press Home → app should auto-maximize then enter PiP
- [ ] Return to app → fullscreen resumes correctly

### 3. PiP dismiss (swipe away)
- [ ] Enter PiP, swipe the PiP window off-screen
- [ ] Playback stops, no orphaned audio
- [ ] Re-open app → player is in correct state (hidden or last mode)

### 4. PiP with controls
- [ ] Play/pause button in PiP window works
- [ ] Rewind/forward buttons in PiP window work
- [ ] Play state syncs back to app on PiP exit

### 5. Rotation + PiP
- [ ] Enter landscape fullscreen, press Home → PiP enters
- [ ] Return to app → landscape fullscreen restored (not portrait)

### 6. Quick PiP toggle (stress test)
- [ ] Rapidly Home → return → Home → return (4+ times)
- [ ] No crash, no black screen, no frozen UI

## Known constraints
- TextureView LayoutParams must NOT change during PiP (causes black screen)
- `applySurfaceViewTransforms` is legacy/no-op for NitroVLC
- `setSurfaceViewInset` always sends 0 — kept for defensive compat
- PiP transition window (2200ms) suppresses audio focus loss / MediaSession pause
```
