# Android backgrounding spec

This document defines the intended Android UX and architecture for video backgrounding, lock screen behavior, PiP, and backend/network lifetime.

## Core model

Treat these as separate concerns:

- Session ownership
  - whether a video session exists at all
  - source of truth: `currentVideo !== null`

- Transport state
  - `playing | paused | buffering | ended`

- Presentation mode
  - `fullscreen | mini | pip | hidden`

- App lifecycle
  - `foreground | background | locked | task_removed`

Rule:
- mini player is in-app UI only
- PiP is system UI
- lock screen is media-session UI
- backend/network warmth follows session ownership, not transport jitter

## Source of truth

### sessionOpen
`currentVideo !== null`

This is the canonical signal for whether:
- the playback session is alive
- backend/network should stay warm
- reopening should resume instantly without reconnect UI

### transportState
- playing
- paused
- buffering
- ended

Transport state should control controls/UX, but not session ownership.

### uiMode
- fullscreen
- mini
- pip
- hidden

UI mode controls presentation only.

### closeIntent
- `none`
- `user_closed_video`
- `pip_closed`
- `task_removed`

This makes close semantics explicit.

## UX policy

### 1. Home while video is playing
Expected:
- enter PiP
- keep session open
- keep backend/network warm
- keep media session active

### 2. Home while video is paused
Expected:
- do not force PiP
- keep session open
- keep media session alive
- keep backend/network warm for a grace period or until explicit close

### 3. Lock screen while video is playing
Expected:
- continue background audio if allowed
- show lock-screen controls + metadata
- do not force PiP just because the screen locks
- keep session open
- keep backend/network warm

### 4. Lock screen while video is paused
Expected:
- keep session open
- allow lock-screen controls/metadata if session is still alive
- allow longer idle timeout before teardown

### 5. PiP close
Expected:
- treat as close, not pause
- stop playback
- clear session
- disable PiP
- schedule backend suspend

### 6. PiP expand back into app
Expected:
- restore app-visible playback state
- default restore target: fullscreen
- no reconnect overlay
- no fake reload

### 7. Explicit in-app close
Expected:
- clear session
- disable PiP
- suspend after short grace

### 8. Task removed / swipe away from recents
Expected:
- hard close session
- stop playback
- disable PiP
- suspend backend immediately or near-immediately

## Event table

### APP_HOME
If `sessionOpen && transportState === playing`:
- enter PiP
- keep session open

If `sessionOpen && transportState !== playing`:
- do not force PiP
- keep session warm
- optionally arm idle timeout

### APP_LOCKED
- never use as "force PiP"
- if `sessionOpen`, keep media session alive
- keep backend warm

### APP_FOREGROUND
- cancel suspend timers
- resume network if needed
- restore visible player state from session state
- do not recreate session if still open

### PIP_ENTERED
- `uiMode = pip`
- keep session open
- suppress fake buffering/loading overlays

### PIP_EXITED
- restore fullscreen
- keep session open
- keep backend warm
- reassert transport if needed

### PIP_CLOSED
- close session
- clear current video
- disable PiP
- schedule suspend

### VIDEO_CLOSED
- same as explicit close
- clear session
- schedule suspend

### TASK_REMOVED
- hard teardown
- clear session
- suspend immediately

### REMOTE_PLAY
- if session open, resume playback

### REMOTE_PAUSE
- pause only
- do not close session

### REMOTE_STOP
- only map to close when it is truly final
- guard transition noise aggressively

## Code ownership

### app/_layout.tsx
Own only:
- app lifecycle -> backend lifecycle bridge
- suspend/resume timers
- network keepalive policy based on `sessionOpen`

Do not own:
- player UI mode transitions
- PiP restore behavior
- mini/fullscreen decisions

### lib/VideoPlayerContext.tsx
Own:
- session lifecycle
- transport state
- media session activation
- PiP listener reactions
- explicit close vs pause semantics
- buffering/loading overlay suppression during lifecycle transitions

### lib/playerStateMachine.ts
Own:
- UI presentation transitions only
- `fullscreen | mini | pip | hidden`

Do not own:
- backend/network suspend policy
- lock-screen policy
- media session lifetime

### android MediaSession/PipBridge
Own:
- native PiP entry/exit
- `onUserLeaveHint`
- remote controls / lock-screen plumbing
- minimal native PiP flags only

Do not own:
- backend/network ownership
- reconnect/loading overlays

## Loading overlay policy

"Connecting to P2P" should appear only when there is a real reconnect or real loading event.

It should NOT appear for:
- PiP enter/exit
- mini/fullscreen transitions
- app background/foreground return while session is still open
- lock/unlock while session is still open

## Simplification principles

- backend/network warmth follows `sessionOpen`
- pause is not close
- mini mode is UI only
- PiP close is a real close
- lock screen is not a PiP event
- prefer explicit close/session helpers over scattered boolean guards

## Recommended next refactor steps

1. Add a first-class `sessionOpen` concept in `VideoPlayerContext`
2. Make `_layout.tsx` suspend/resume logic depend on `sessionOpen`
3. Add explicit `closeSession(reason)` helper
4. Map PiP close to `closeSession('pip_closed')`
5. Add paused-background idle timeout policy
6. Audit remote stop/pause/play to align with close vs pause semantics
