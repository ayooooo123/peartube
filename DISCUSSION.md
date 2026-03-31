# Task: Remove dead old-player PiP bridge logic from Android MediaSessionModule

## What we verified
- `packages/app/react-native.config.js` explicitly disables `react-native-mpv` on Android:
  - comment: Android playback now uses react-native-video/Media3
  - `android: null`
- `packages/app` has no runtime references to NitroVLC anymore
- `MediaSessionModule.kt` still contains legacy reflection hooks aimed at old native player views:
  - `invokePlayerViewStatic(...)`
  - `notifyPlayerViewTransitionUntil(...)`
  - `notifyPlayerViews(...)`
  - `notifyPlayerPipWindowSize(...)`
- The only class currently targeted is `to.holepunch.peartube.mpv.MpvView`
- Since `react-native-mpv` is unlinked on Android, this path is dead for the actual app

## Goal
Simplify Android PiP bridge by removing dead old-player reflection logic that no longer applies to the current react-native-video stack.

## Constraints
- Keep actual PiP behavior intact
- Do not break current fullscreen PiP reliability
- Keep changes localized to MediaSessionModule.kt if possible
- Prefer deletion over adding new abstractions

## Candidate cleanup
- Remove `invokePlayerViewStatic(...)`
- Remove or inline away:
  - `notifyPlayerViewTransitionUntil(...)`
  - `notifyPlayerViews(...)`
  - `notifyPlayerPipWindowSize(...)`
- In `markPipTransition()`, only update the transition timestamp
- In `notifyPipModeChanged(...)`, stop calling old-player hooks

## Discussion

## Claude Proposal

### Summary

Six functions in `PipBridge` and one in `MediaSessionModule` exist solely to call static methods on `to.holepunch.peartube.mpv.MpvView` via reflection. That class is no longer linked on Android (`react-native-mpv` has `android: null` in `react-native.config.js`), so every reflection call silently catches `ClassNotFoundException` and does nothing. Additionally, the `SurfaceView`-specific transform/inset logic (`applySurfaceViewTransforms`, `findSurfaceViews`, `setSurfaceViewInset`) targeted the old MPV SurfaceView renderer — react-native-video uses its own internal view management.

### Safe to delete (PipBridge)

| Function | Lines | Reason |
|----------|-------|--------|
| `invokePlayerViewStatic(...)` | 85–97 | Core reflection dispatcher — only target class `MpvView` is unlinked |
| `notifyPlayerViewTransitionUntil(...)` | 77–83 | Sole caller of `invokePlayerViewStatic("setAllPipTransitionUntilUptimeMs")` |
| `notifyPlayerViews(...)` | 402–408 | Sole caller of `invokePlayerViewStatic("setAllPipMode")` |
| `notifyPlayerPipWindowSize(...)` | 410–417 | Sole caller of `invokePlayerViewStatic("setAllPipWindowSize")` |
| `applySurfaceViewTransforms(...)` | 438–492 | Scales/translates SurfaceViews for PiP. Already early-returns for MainActivity. react-native-video manages its own surfaces. |
| `findSurfaceViews(...)` | 511–522 | Only used by `applySurfaceViewTransforms` and `setSurfaceViewInset` |
| `setSurfaceViewInset(...)` | 419–432 | Translates SurfaceViews by inset. Dead now that player is react-native-video. |
| `surfaceViewInsetPx` field | 49 | Only used by the above dead functions |

### Safe to delete (MediaSessionModule)

| Function | Lines | Reason |
|----------|-------|--------|
| `notifyPlayerPlaybackPaused(...)` | 1512–1518 | Calls `invokePlayerViewStatic("setAllPlaybackPaused")` — same dead reflection path |
| `setSurfaceViewInset` AsyncFunction | 758–773 | Expo module binding for the dead `PipBridge.setSurfaceViewInset` |

### Callers to update (not delete)

1. **`markPipTransition()`** (line 68–71): Remove the `notifyPlayerViewTransitionUntil(...)` call. Keep the timestamp assignment — `isInPipTransition()` still reads it for audio-focus churn suppression.

2. **`notifyPipModeChanged()`** (line 322–395):
   - Remove `notifyPlayerViews(isInPip)` call (line 328)
   - Remove `applySurfaceViewTransforms(...)` call and its surrounding `handler.postDelayed` (lines 338–341)
   - Remove `notifyPlayerPipWindowSize(...)` call and its surrounding block (lines 386–390)
   - Keep everything else: `markPipTransition()`, `lastIsInPip` tracking, dismissal-pause logic, `sendPipEvent()`

3. **MediaSession callback sites calling `notifyPlayerPlaybackPaused()`** (~lines 933, 953, 969, 1453, 1460, 1467): Delete these calls. They're no-ops. The JS side already receives play/pause via `onRemoteCommand` events.

### JS-side cleanup

4. **`VideoPlayerOverlayImpl.tsx:2168`**: Remove the `MediaSession.setSurfaceViewInset(0)` call and the surrounding `useEffect` (lines 2163–2169). The comment already says "keep the inline surface flush" — it's doing nothing since the native function is dead.

5. **`expo-media-session/src/index.ts:235–243`**: Remove the `setSurfaceViewInset` export. Optionally keep as a no-op stub if you prefer a non-breaking API, but since it's only called from one place (above), full deletion is cleaner.

6. **Test file** `tests/mobile-player-page-layout-regression.test.mjs:77`: Remove or update the regex that asserts `setSurfaceViewInset` is called.

### Do NOT delete

- `findVideoViews(...)` (lines 497–508) — still used by `updatePipSourceRectForCapture` and `getVideoSourceRect` for PiP source rect calculation. These find SurfaceView **and** TextureView, which react-native-video does use.
- `getSafeInsetTopPx(...)` (lines 524–533) — still used by `setSurfaceViewInset` AsyncFunction, but if that's deleted, this becomes an orphan too. Check for other callers before removing.
- Any PiP lifecycle logic (`markPipTransition`, `isInPipTransition`, `notifyPipModeChanged`, `enterPictureInPictureDirect`, etc.) — these are live and critical.

### Risk assessment

**Low risk.** Every deleted function either (a) calls `invokePlayerViewStatic` which silently fails at runtime already, or (b) manipulates SurfaceViews that don't exist in the current player stack. The app is already running without these doing anything. The only behavioral change is removing a few dozen silent exception catches per PiP cycle.

### Suggested order

1. Delete the 6 dead `PipBridge` functions + field
2. Delete `notifyPlayerPlaybackPaused` from `MediaSessionModule`
3. Update `markPipTransition` and `notifyPipModeChanged` callers
4. Delete `setSurfaceViewInset` AsyncFunction binding
5. JS-side cleanup (`VideoPlayerOverlayImpl`, `index.ts`, test)
6. Build + manual PiP test (enter/exit/dismiss/re-enter)
