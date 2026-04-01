# Task: Deeper Grayjay vs PearTube Android PiP lifecycle diff

## Goal
Find why PearTube Android PiP custom controls collapse to the single default control (especially after drag/reposition) while Grayjay keeps both buttons on the same device, and fix it without destabilizing PiP entry/re-entry.

## Confirmed current state
- PiP entry reliability is sensitive; Android 12+ direct `onUserLeaveHint -> enterPictureInPictureMode(...)` is still needed for reliable repeated entry.
- The APP_MUSIC / MUSIC_PLAYER activity classification removal helped initial PiP behavior and should stay removed.
- PearTube can build the correct 2-action list (`Background + Pause`) and the shell does sometimes show it.
- Grayjay still keeps both buttons after drag on the same device.
- PearTube still collapses back to the single default control, especially around drag/bounds changes.

## Strongest verified log findings
### PearTube app logs
- PearTube logs correct canonical params before/around PiP:
  - `buildCanonicalPipParams: actions=[Background, Pause] autoEnter=true seamless=true ...`
- App-state/JS UI churn is noisy and can produce hidden-state PiP writes.
- Some experiments added churn/noise and were reverted.

### PearTube system logs
- On entry, shell initially sees the correct 2-action config:
  - `PIP remote actions=[Background|Pause]`
- Then shell task info can mutate to a degraded snapshot:
  - `isAutoPipEnabled=false`
  - weird PiP-sized `sourceRectHint`
  - shell-visible remote actions collapse to `[pause]`
- During drag/bounds changes, the same pattern appears:
  - start with `isAutoPipEnabled=true` and `[Background|Pause]`
  - then during `scheduled_bounds_change` / `changed-bounds`, task params mutate to `isAutoPipEnabled=false`
  - shell-visible actions collapse to `[pause]`

### Grayjay system logs
- Grayjay drag path shows shell-level bounds-change transitions:
  - `onTaskInfoChanged`
  - `scheduled_bounds_change`
  - `changing-bounds`
  - `changed-bounds`
- Grayjay retains actions through that shell path.

## Important failed experiments
Keep these as ruled out / not sufficient:
- callback hunting via `onConfigurationChanged`
- `notifyPipBoundsChanged`
- `onPictureInPictureUiStateChanged`
- delayed/ignored transient false PiP exit handling
- MediaSession action-mask alignment alone
- churn-based auto-rearm patch in `VideoPlayerContext` (reverted)
- Android 12+ auto-enter-only `onUserLeaveHint` path (reverted because 2nd PiP entry broke)

## Current best hypothesis
We still do not know which exact write path produces the shell's degraded `newParams` snapshot.

We have canonical builder logs, but the shell still later reports mutated task params with:
- `isAutoPipEnabled=false`
- changed PiP-sized `sourceRectHint`
- remote actions reduced to `[pause]`

So the next step is not another behavior patch.
The next step is instrumentation:
- every native PiP param write site must log a unique reason marker
- every actual `setPictureInPictureParams(...)` / `enterPictureInPictureMode(...)` call should log:
  - reason
  - action labels
  - autoEnter
  - seamlessResize
  - sourceRectHint
  - aspect ratio
- enough to correlate the app-side write site with the exact shell-side `onTaskInfoChanged` degradation event

## Output wanted now
- one instrumentation patch only
- no more speculative behavior changes until the logs clearly identify the writer of the bad task snapshot

## Discussion

## Hermes Summary
- Restore direct Android 12+ PiP entry (done) to keep 2nd PiP entry reliable.
- Keep canonical PiP builder and its logs.
- Instrument every native PiP param write site with explicit reason markers so we can correlate app-side writes with the shell's degraded task snapshot.

## Codex Review
Codex's strongest point still stands:
Android shell is probably rebuilding the visible PiP action strip from the pinned task's latest `TaskInfo.pictureInPictureParams` snapshot during `scheduled_bounds_change -> changed-bounds`, not from whatever PearTube had at initial entry.

Because `setPictureInPictureParams()` replaces the task-visible params blob, the only way to stop guessing is to instrument each native write site with a unique reason marker and compare those writes against shell `onTaskInfoChanged` lines.
