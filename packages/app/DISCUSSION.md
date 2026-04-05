# Task: Diagnose PearTube Android debug startup crash from fresh logcat

## User report
Android debug build crashes on startup after many recent changes.

## Fresh capture context
Device: emulator-5554
Package: com.peartube.app
Capture file: /tmp/peartube-crash/startup-logcat.txt

## Key log excerpts
146: EmojiCompat is not initialized
860: WindowManager$BadTokenException: Unable to add window -- token null is not valid; is your activity running?
918-922: ReactHost soft exception: onWindowFocusChange while context is not ready
1207: ReactNativeJS Running "main"
1229-1233: VideoPlayerOverlay mounted
1241/1249+: IllegalStateException: setPictureInPictureParams: Current activity does not support picture-in-picture
1289: [App] Initializing native backend via platform RPC...
1290: [VideoPlayerOverlay] PiP supported: true

## Initial Hermes observation
This fresh run does NOT yet show a classic fatal startup exception (no FATAL EXCEPTION main / no signal crash for com.peartube.app in this captured window). It does show a strong candidate bug: PiP params are being written during startup while the current activity does not support PiP yet, plus some early-window startup warnings.

## Questions for agents
1. Based on these logs, what is the most likely root cause of the user-visible startup crash/exit?
2. Which lines are probably noise vs actually causal?
3. What exact code path should Hermes inspect next?

## Discussion

## Codex Review

The current discussion undersells two important points:

1. This log contains two different episodes.
   - PID 20325 is already dying at 15:29:18.
   - PID 21029 is the later fresh launch that actually reaches `MainActivity`, initializes React, runs JS, mounts `VideoPlayerOverlay`, and logs app startup work.

2. The scary exceptions in the later launch are not obviously process-fatal in this capture.
   - `WindowManager$BadTokenException` from the React dev loading popup happens before `Displayed com.peartube.app/.MainActivity`, and the app continues.
   - `ReactHost` soft exceptions are explicitly soft and also occur before JS finishes booting.
   - `setPictureInPictureParams: Current activity does not support picture-in-picture` is a real app bug, but it is caught/logged and the process continues afterward.

Most important diagnosis:
- I do not see a classic fatal line for the fresh PID 21029 startup (`FATAL EXCEPTION`, tombstone, signal crash, or process death) anywhere in this capture.
- The only actual process death shown here is earlier: `04-02 15:29:18.195 I Zygote: Process 20325 exited due to signal 9 (Killed)`.
- That line is the first truly fatal line in the file, but it is not causally explained by any preceding app exception inside this capture. Everything after it (`WIN DEATH`, `DeadObjectException`, pinned-task removal) is downstream cleanup/noise.

So the strongest correction to the current assumption is:
- The BadToken and PiP exceptions are probably not the cause of the observed immediate process exit for PID 20325.
- The capture likely starts after the real trigger for PID 20325, or the process was externally/system-killed during an existing task/transition state.

What looks causal vs noise in the fresh relaunch:

Likely noise / secondary:
- `EmojiCompat is not initialized` from `GoogleInputMethodService` is in the keyboard process, not PearTube.
- `WindowManager$BadTokenException` at lines 860/883 is from `com.facebook.react.devsupport.DefaultDevLoadingViewImplementation.showInternal(...)`; React immediately logs it cannot show the loading message because the activity is not active, then the app keeps launching.
- `ReactHost` soft exception on `onWindowFocusChange` is noisy startup ordering under bridgeless React; the app still progresses to `Running "main"`.

Real bug, but not proven fatal here:
- Lines 1234-1259 are the most actionable app-side fault in the fresh launch.
- JS mounts `VideoPlayerOverlay`, then native logs:
  - `MediaSession: setAutoPiP: enabled=false`
  - `PipBridge: setPipEnabled: false`
  - `MediaSession.updateActivityPipParams:set`
  - `IllegalStateException: setPictureInPictureParams: Current activity does not support picture-in-picture.`
- This is causally tied to app code and not just platform noise.
- The likely bad assumption is that `resolvePlaybackHostActivity()` returning either `PlayerActivity` or `MainActivity` is always safe for PiP param writes. It is not: the manifest plugin explicitly removes `android:supportsPictureInPicture` from `MainActivity`, so any PiP param write routed to `MainActivity` is invalid by construction.

First truly causal line for the fresh launch, if we restrict to app-owned faults rather than the earlier unexplained kill:
- `04-02 15:29:27.406 W ActivityTaskManager: java.lang.IllegalStateException: setPictureInPictureParams: Current activity does not support picture-in-picture.`
- This is the first line that clearly identifies an app-controlled invalid operation with a direct code path back into PearTube native code.
- But it is still not shown to be fatal in this capture, because the exception is caught by `updateActivityPipParams()`.

Next code paths Hermes should inspect:

1. `modules/expo-media-session/android/.../MediaSessionModule.kt`
   - `resolvePlaybackHostActivity()`
   - `PipBridge.setPipEnabled()`
   - `setAutoPiP()`
   - `updateActivityPipParams()`
   - Specifically why PiP param writes are allowed when the resolved host is `MainActivity`, even though `MainActivity` no longer supports PiP.

2. `plugins/withAndroidPiP.js`
   - Confirm the manifest mutation is intentional and current build output actually matches it:
     - `MainActivity` has PiP support removed
     - `PlayerActivity` alone has `android:supportsPictureInPicture="true"`
   - This matters because the native module currently treats both activities as PiP hosts for `autoEnterEnabled` gating, which looks logically inconsistent with the manifest.

3. `components/VideoPlayerOverlayImpl.tsx`
   - Startup PiP-related effects around mount, especially the path that results in `setAutoPiP(false)` while no current video is active.
   - The log shows PiP setup code is running even with `hasCurrentVideo: false` and `playerMode: 'hidden'`, which is a weak state assumption worth challenging.

4. `android/app/src/main/java/com/peartube/app/PlayerActivity.kt`
   - Lifecycle interactions with `PlaybackHostBridge.registerNativeHostActivity`, `maybeEnterPipOnLaunch()`, and `onDestroy()` calling `PipBridge.setPipEnabled(false)`.
   - I would verify whether teardown or focus changes can temporarily swing the playback host back to `MainActivity`, causing invalid PiP writes during startup/cleanup.

Bottom line:
- There is not enough evidence in this capture to claim the fresh startup crash is caused by the BadToken or PiP exception alone.
- The only unquestionably fatal line is the earlier SIGKILL of PID 20325, whose cause is missing from the log window.
- The clearest app-owned defect visible in the fresh run is incorrect PiP param mutation against a non-PiP activity, and that is the next code path worth tracing.

## Claude Proposal
Likely root cause
- The strongest startup-time fault in the fresh run is not a fatal JS/Hermes crash, but Android PiP params being written against MainActivity even though MainActivity does not declare PiP support in the manifest.
- Evidence chain:
  - MainActivity is displayed successfully at 906, JS starts at 1207, and the overlay mounts at 1229-1233, so the app does make it through startup.
  - Immediately after the overlay enables auto-PiP, native logs show PiP params being built/written at 1234-1239.
  - Android then rejects that write at 1241/1249 with `IllegalStateException: setPictureInPictureParams: Current activity does not support picture-in-picture`.
  - The stack points directly to `to.holepunch.modules.mediasession.MediaSessionModule.updateActivityPipParams(... )` via `PipBridge.setPipEnabled(...)` / `setAutoPiP(...)`.
- Why this is especially suspicious in this repo:
  - `android/app/src/main/AndroidManifest.xml:40-52` gives `android:supportsPictureInPicture="true"` only to `.PlayerActivity`, not `.MainActivity`.
  - But `modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt:1429-1449` explicitly treats both `PlayerActivity` and `MainActivity` as PiP host activities and still calls `activity.setPictureInPictureParams(params)`.
- So the most likely bug is a host-activity mismatch: startup code arms PiP while the resolved activity is still MainActivity, but only PlayerActivity actually supports PiP.

Likely noise / not causal here
- 146 and 972 (`EmojiCompat is not initialized`) are from GoogleInputMethodService / IME, not the app process.
- 860/883 (`BadTokenException` adding PopupWindow) comes from React dev loading view trying to show a loading popup before the activity is active; noisy dev-support behavior, not a fatal app crash.
- 918-958 (`ReactHost soft exception: onWindowFocusChange while context is not ready`) is explicitly a soft exception and startup continues.
- Repeated `pcm_writei failed` audio emulator spam is emulator noise.
- The earlier `Process 20325 exited due to signal 9` is from the prior app instance being killed before the fresh launch; it is not the fresh process 21029 crashing.

Exact file/code path to inspect next
- Primary: `modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt`
  - `resolvePlaybackHostActivity()` at 1348-1349
  - `updateActivityPipParams()` at 1426-1452
  - `setLoggedPipParams()` at 1588-1590
- Caller on startup: `components/VideoPlayerOverlayImpl.tsx`
  - PiP support/init around 755-763 and mount logs around 1229-1233 in logcat
  - auto-PiP arming effect at 2165-2175 (`MediaSession.setAutoPictureInPicture(shouldEnable)`)
- Manifest sanity check: `android/app/src/main/AndroidManifest.xml:40-52` to confirm only `PlayerActivity` supports PiP.

Bottom line
- Fresh logcat does not show a classic fatal startup exception for the new process.
- The best concrete diagnosis is: startup is eagerly enabling PiP from JS, native resolves MainActivity as the host, and Android rejects `setPictureInPictureParams` because MainActivity is not PiP-capable. That is the next code path to inspect before anything else.
