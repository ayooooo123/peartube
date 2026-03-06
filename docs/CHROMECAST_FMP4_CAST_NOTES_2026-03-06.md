# Chromecast fMP4 Cast Runbook (2026-03-06)

## TL;DR

- Yes, cast still uses fMP4 HLS (`master.m3u8 -> playlist.m3u8 -> init.mp4 + seg-xxxxx.m4s`).
- The system now reaches and holds `PLAYING` in Chromecast for long sessions.
- The biggest wins were: startup readiness gating, segment retention, master-playlist entrypoint, and transcode pacing.

## Scope and Goal

This document captures the concrete Chromecast problems encountered in Android PearTube cast sessions, how each issue was diagnosed, and the fix that moved behavior forward.

Primary goal:
- Mandatory transcoding for cast sessions (no direct cast bypass)
- Reliable start and sustained playback for long videos

## Current Architecture (Working Path)

- Sender creates cast transcode session.
- Cast URL served from local HTTP as:
  - `master.m3u8`
  - `playlist.m3u8`
  - `init.mp4`
  - `seg-xxxxx.m4s`
- Chromecast receives a `LOAD` request pointing at `master.m3u8`.

## Incident Ledger: Problem -> Root Cause -> Fix

### 1) Startup stuck (`IDLE`/loading, no visible playback)

Symptoms:
- Chromecast accepted `LOAD` but stayed `IDLE`/loading
- Playlist/init/segment requests appeared in logs but playback did not start

Root cause:
- Startup race between cast load timing and transcode readiness
- `LOAD` retries could occur too early and create cancellation churn

Fixes:
- Added startup readiness gate before issuing cast play (require init + startup segment)
- Added smarter `LOAD` retry behavior and status-probe phase in cast transport

Files:
- `packages/app/backend/mobile-cast.mjs`
- `packages/backend/src/cast/chromecast.js`

Validation signal:
- State transitions progress into `PLAYING` with increasing `time`

---

### 2) `LOAD_FAILED` with startup segment 404

Symptoms:
- `LOAD_FAILED`
- Chromecast requested a segment listed in playlist, got `404`

Root cause:
- Startup segment window too small; fast transcode evicted early segments before Chromecast fetched them

Fixes:
- Increased segment retention and startup pinning in cast segment store

Files:
- `packages/backend/src/transcode/cast-transcoder.mjs`
- `packages/backend/src/transcode/segment-store.mjs`

Validation signal:
- No startup segment `404` in cast session logs

---

### 3) Browser plays but Chromecast still does not

Symptoms:
- HLS URL played in browser
- Chromecast still stalled or remained `IDLE`

Root cause:
- Receiver load behavior is stricter than browser path; startup declaration/entrypoint matters

Fixes:
- Switched cast entrypoint to `master.m3u8` (single-variant master)
- Kept media playlist at `playlist.m3u8`
- Added explicit `LOAD` payload logging for sender-side verification

Files:
- `packages/backend/src/transcode/cast-transcoder.mjs`
- `packages/backend/src/cast/chromecast.js`

Validation signal:
- Cast uses master URL and transitions to `PLAYING`

---

### 4) Playback plateau around ~17 minutes

Symptoms:
- Cast stopped around ~17m
- Browser URL showed same ceiling duration and stopped growing

Root cause:
- Transcode pipeline raced ahead to current source frontier and effectively finalized too early

Fixes:
- Added transcode pacing against media clock vs wall clock to avoid overrun
- Tuned to smoother micro-throttles to reduce burst/pause behavior

Files:
- `packages/backend/src/transcode/cast-transcoder.mjs`

Validation signal:
- Playlist/segment growth continues beyond prior cutoff
- Playback time continues advancing past old ceiling

---

### 5) Underflow and terminal-state hang behavior

Symptoms:
- Underflow logs (`Transcoder caught up to download`)
- End-of-stream could look like indefinite waiting

Root cause:
- Progressive source underflow not explicitly surfaced as terminal bad state
- Terminal sessions needed explicit playlist finalization semantics

Fixes:
- Added underflow tracking in `TempFileReader`
- Tightened session terminal handling in cast transcoder
- Ensured terminal states mark segment store finished

Files:
- `packages/backend/src/transcode/temp-file-reader.mjs`
- `packages/backend/src/transcode/cast-transcoder.mjs`

Validation signal:
- Clear terminal state in logs, no ambiguous indefinite waiting after terminal conditions

---

### 6) Long-run control channel instability (disconnect while media URL still works)

Symptoms:
- Chromecast disconnect event while URL can still resume in browser
- Bursty high-frequency playlist requests and heavy diagnostics logging observed

Root cause:
- Cast control channel more fragile than media serving path in long run
- Log/event pressure and strict heartbeat timeout increased disconnect risk

Fixes:
- Added proper `Range` support for playlist endpoints (`master.m3u8`, `playlist.m3u8`) with `206/416`
- Throttled playlist request diagnostics logging to once per second per session
- Relaxed heartbeat timeout threshold (from 3 misses to 6 misses)

Files:
- `packages/backend/src/transcode/cast-transcoder.mjs`
- `packages/backend/src/cast/chromecast.js`

Validation signal:
- Fewer control disconnects during long soak
- Continued `PLAYING` state with stable segment/playlist fetch pattern

## Operational Checks (PearTube-only adb)

### Must-see lines in healthy run

- URL emit:
  - `[CastDiag] Chromecast HLS URL: http://.../cast/<session>/master.m3u8`
- Sender payload:
  - `[Chromecast] LOAD media payload ...`
- State progression:
  - `loading -> buffering -> PLAYING`
  - `MEDIA_STATUS ... time: <increasing>`

### Regression signatures

- `LOAD_FAILED`
- `LOAD_CANCELLED`
- repeated segment `404`
- startup timeout (`0/x fragments ready`)
- playback time stalls while requests stop growing

## Files Most Relevant for Future Debugging

- Cast orchestration:
  - `packages/app/backend/mobile-cast.mjs`
  - `packages/backend/src/cast/chromecast.js`
- fMP4 cast transcode serving:
  - `packages/backend/src/transcode/cast-transcoder.mjs`
  - `packages/backend/src/transcode/segment-store.mjs`
  - `packages/backend/src/transcode/temp-file-reader.mjs`

## Known Remaining Watchouts

- Minor occasional A/V skip still needs extended soak confirmation under real network variability.
- Heartbeat misses can still appear transiently while playback continues; disconnect behavior should be monitored over multi-hour sessions.

## Verification Baseline Used During This Work

- `npm run bundle:backend` passed repeatedly after cast changes
- `npm run -s test` passed repeatedly
- `npm run typecheck` still has pre-existing unrelated issue:
  - `packages/platform/src/storage.js`: missing `bare-storage` type declarations
