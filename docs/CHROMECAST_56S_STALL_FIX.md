# Chromecast HLS Transcoding Fixes

This document covers two issues that were fixed for Chromecast HLS playback.

---

## Issue 1: 56-Second Stall

### Problem
Chromecast playback consistently stalled at exactly **56.3 seconds** when playing HLS-transcoded content (HEVC + EAC3 → H.264 + AAC).

### Root Cause
**Chromecast's Default Media Receiver requires ~20 seconds of buffered content before starting HLS playback.**

With the original 2-second segment duration:
- 3 initial segments = only 6 seconds of buffer
- This was below Chromecast's internal threshold
- Player would start, buffer to ~60 seconds, then stall waiting for more buffer

### Solution
Increased HLS segment duration from 2 seconds to 8 seconds:
- 3 initial segments = 24 seconds of buffer
- This exceeds Chromecast's ~20 second threshold
- Player can now buffer properly and continue playback indefinitely

---

## Issue 2: 3-Minute Restart/Error

### Problem
After fixing the 56-second stall, playback would error out after ~3 minutes with:
```
[TempFileReader] Transcoder caught up to download! STOPPING.
[matroska,webm @ 0x...] File ended prematurely
```

### Root Cause
**TempFileReader downloads via HTTP while transcoding, but the transcoder outpaces the download.**

- TempFileReader streams the video via HTTP from the blob server
- For large videos (2+ GB), the transcoder processes faster than HTTP can download
- When transcoder position catches up to download position, it errors out

### Solution
Use `HypercoreStreamReader` for large, fully-synced videos instead of `TempFileReader`:
- Reads directly from locally-synced Hypercore blocks
- No HTTP download race condition
- Blocks are already available locally, so reads are instant

---

## Files Changed

### Issue 1 (56s Stall) Files:

**`packages/backend/src/transcode/hls-transcoder.mjs`**
```javascript
// Line 949 (remux function)
const TARGET_SEGMENT_DURATION = 8.0 // Was 2.0

// Line 2264 (transcode function)  
const TARGET_SEGMENT_DURATION = 8.0 // Was 2.0
```

**`packages/backend/src/transcode/hls-segment-manager.mjs`**
```javascript
// Lines 19-20
const TARGET_SEGMENT_DURATION = 8  // Was 2
const MAX_SEGMENT_DURATION = 10    // Was 4
```

**`packages/app/pear-src/workers/core/index.ts`**
- Added `mediaDuration` capture from probe result
- Pass `duration` parameter to Chromecast LOAD command
- Keep `streamType = 'LIVE'` for growing playlists

**`packages/backend/src/cast/chromecast.js`**
- Added debug logging for `streamType` and `duration` in LOAD

### Issue 2 (3-Minute Error) Files:

**`packages/backend/src/transcode/hls-transcoder.mjs`**
```javascript
// Added import
import { HypercoreStreamReader } from './hypercore-stream-reader.mjs'

// Added before TempFileReader fallback (around line 3382)
if (!inputIO && blobInfo && blobsCoreKey && store && isVideoComplete) {
  const hypercoreStreamReader = new HypercoreStreamReader(blobsCore, blobInfo)
  await hypercoreStreamReader.initialize()
  inputIO = hypercoreStreamReader.createIOContext(ffmpeg)
}
```

## Key Learnings

1. **Chromecast HLS Buffer Threshold**: The Default Media Receiver needs ~20 seconds buffered before playback starts reliably

2. **Segment Duration vs Segment Count**: The stall was time-based (56s), not segment-based. Larger segments = more initial buffer

3. **LIVE vs BUFFERED streamType**: 
   - `LIVE` is correct for growing playlists (real-time transcoding)
   - `BUFFERED` requires known duration and causes issues with dynamic playlists

4. **Duration Parameter**: While the media duration can be passed to Chromecast, it's often 0 for MKV containers. The segment duration change is the real fix.

## Commit
```
fix(chromecast): increase HLS segment duration to 8s for proper buffering

Chromecast's Default Media Receiver requires ~20 seconds of buffered
content before starting HLS playback. With 2-second segments, only
6 seconds were buffered initially, causing playback to stall at ~56s.
```

## References
- Chromecast buffer requirement: ~20 seconds (from web research)
- HLS playlist refresh: every `targetDuration` seconds
- Chromecast stops polling if playlist unchanged after 0.5 × `targetDuration`
