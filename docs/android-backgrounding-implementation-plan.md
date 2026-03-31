# Android backgrounding implementation plan

This is the concrete follow-up plan for `docs/android-backgrounding-spec.md`.

## Phase 1: Formalize session ownership

Files:
- `packages/app/lib/VideoPlayerContext.tsx`
- `packages/app/lib/video-player/VideoControlContext.tsx`
- `packages/app/app/_layout.tsx`

Changes:
- define a clear `sessionOpen` concept (`currentVideo !== null`)
- keep `playbackActiveEmitter` semantics aligned with session ownership
- make `_layout.tsx` app-lifecycle suspend logic treat an open video session as keepalive-worthy

Expected result:
- background/foreground/PiP transitions do not accidentally suspend the backend
- reconnect overlays are reduced

## Phase 2: Make close semantics explicit

Files:
- `packages/app/lib/VideoPlayerContext.tsx`
- `packages/app/lib/playerStateMachine.ts`

Changes:
- add `closeSession(reason)` helper
- separate close from pause everywhere practical
- make explicit close the only path that clears session ownership

Expected result:
- fewer accidental teardowns during transitions

## Phase 3: Make PiP close a first-class close event

Files:
- `packages/app/lib/VideoPlayerContext.tsx`
- `packages/app/modules/expo-media-session/android/.../MediaSessionModule.kt`

Changes:
- detect PiP close as distinct from PiP expand/exit
- map PiP close to `closeSession('pip_closed')`

Expected result:
- PiP close behaves like Android users expect
- no zombie session after PiP close

## Phase 4: Lock-screen policy cleanup

Files:
- `packages/app/lib/VideoPlayerContext.tsx`
- `packages/app/app/_layout.tsx`
- Android media session glue if needed

Changes:
- stop treating lock/unlock like a PiP event
- preserve session + controls on lock screen
- do not force PiP on lock

Expected result:
- lock screen feels like a normal Android media app

## Phase 5: Paused-background idle timeout

Files:
- `packages/app/lib/VideoPlayerContext.tsx`
- `packages/app/app/_layout.tsx`

Changes:
- if session is open but paused and hidden/backgrounded, allow a longer idle timeout before suspend
- cancel timeout on resume/play

Expected result:
- better battery/network hygiene without harming UX

## Regression checklist

Use:
- `docs/android-pip-regression-checklist.md`

Additionally verify:
- lock screen does not force PiP
- PiP close really closes the session
- pause from notification/lock screen does not clear session
- reopening app from background does not show reconnect overlay unless there was a real disconnect
