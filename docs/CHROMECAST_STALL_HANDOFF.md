# Chromecast 56-Second Stall - Handoff Document

## RESOLVED - Root Cause Found (2025-01-18)

**The stall was caused by desktop sending `duration` parameter with `LIVE` streamType.**

When desktop sends `{ streamType: 'LIVE', duration: 82 }` to Chromecast, it creates a conflicting signal:
- `streamType: 'LIVE'` = "this is a live stream, don't expect a fixed length"  
- `duration: 82` = "this content is 82 seconds long"

This confuses Chromecast's buffering logic, causing it to stall at ~56 seconds (segment 28).

**Mobile (which works) does NOT send duration for LIVE streams.**

### The Fix
In `packages/app/pear-src/workers/core/index.ts`, changed castPlay to NOT send duration when streamType is LIVE:
```typescript
const shouldSendDuration = streamType !== 'LIVE' && mediaDuration;
await castContext.play({
  // ...
  streamType,
  ...(shouldSendDuration ? { duration: mediaDuration } : {}),
});
```

---

## Previous Investigation (for reference)

Previously thought the issue was desktop using `BUFFERED` mode + waiting for complete transcode.

### Changes Made
1. `packages/app/pear-src/workers/core/index.ts`: Changed desktop castPlay to use `LIVE` streamType and start after 1 segment (matching mobile)
2. `packages/backend/src/transcode/hls-segment-manager.mjs`: Added `totalDuration` to `getStats()` 
3. `packages/backend/src/transcode/hls-transcoder.mjs`: Exposed `totalDuration` in `getHlsStatus()`

---

## Original Problem Statement
When casting HLS-transcoded videos to Chromecast, playback stalls permanently at approximately 56 seconds. The video is 82 seconds total with 41 segments (~2 seconds each). Chromecast enters BUFFERING state and never recovers.

## Key Observation
**The stall is at a SEGMENT BOUNDARY, not a specific timestamp.**
- With 2-second segments: stalls at ~56 seconds (segment 28)
- With 6-second segments: stalls at ~54 seconds (segment 9)
- This proves the issue is related to segment count or accumulated error, NOT video content

## What Works
- Transcode completes successfully (all 41 segments created)
- All segments are served correctly via HTTP (200 OK responses)
- Chromecast receives segment 38 but cannot play it
- All segments now start with PAT (PID 0) - verified in logs
- Duration shows correctly (82.08s)
- Segments 0-37 play fine

## Current Architecture
- **File:** `packages/backend/src/transcode/hls-transcoder.mjs`
- **Muxer:** Continuous MPEGTS muxer using `flush()` at segment boundaries (not `writeTrailer()`)
- **Segment storage:** `packages/backend/src/transcode/hls-segment-manager.mjs`
- **PAT Fix:** Reorders packets so PAT/PMT are first (line 736-760 in hls-transcoder.mjs)

## Fixes Already Attempted (ALL FAILED)

### 1. PAT/PMT at Segment Start
- **Theory:** Segments starting with SDT (PID 17) instead of PAT (PID 0) caused decode failures
- **Fix:** Reorder packets to put PAT/PMT first when serving segments
- **Result:** All segments now show `PID: 0 (PAT)` but still stalls

### 2. Continuous Muxer vs Per-Segment Muxer
- **Theory:** `writeTrailer()` adds EOF markers that confuse Chromecast at boundaries
- **Fix:** Use single continuous muxer with `flush()` only (no writeTrailer between segments)
- **Result:** Still stalls

### 3. Per-Segment Muxer (writeTrailer each segment)
- **Theory:** Each segment should be fully independent with proper EOF
- **Fix:** Create new muxer for each segment, call writeTrailer() to finalize
- **Result:** Still stalls

### 4. PAT Duplication Fix
- **Theory:** Prepending PAT/PMT created duplicate packets with same continuity counter
- **Fix:** Reorder packets instead of prepending (no duplication)
- **Result:** Still stalls

### 5. `#EXT-X-INDEPENDENT-SEGMENTS` Playlist Tag
- **Theory:** Tell player each segment is independently decodable
- **Fix:** Added tag to playlist generation
- **Result:** Still stalls

### 6. Muxer Options
- **Tried:** `mpegts_flags: 'resend_headers'`, `pcr_period: '20'`, `pes_payload_size: '2930'`
- **Tried:** `sdt_period: '-1'` - ERROR: value out of range
- **Result:** Still stalls

### 7. Disable Audio
- **Theory:** Audio stream causing sync issues
- **Fix:** Attempted to disable audio muxing
- **Result:** Chromecast ERROR - requires audio stream

## Log Pattern at Stall Point
```
[Chromecast] MEDIA_STATUS playerState: PLAYING time: 55.6
[HlsTranscoder] Serving segment 37 size: 2015KB sync: OK PID: 0 (PAT)
[Chromecast] MEDIA_STATUS playerState: BUFFERING time: 55.6  <- STALL STARTS
[HlsTranscoder] Serving segment 38 size: 2048KB sync: OK PID: 0 (PAT)  <- SEGMENT SERVED OK
[Chromecast] MEDIA_STATUS playerState: BUFFERING time: 56.1  <- STUCK FOREVER
```

## Key Discovery: Mobile vs Desktop Difference

| Aspect | Mobile (WORKS) | Desktop (STALLED) |
|--------|---------------|-------------------|
| Wait for | 1 segment | Complete transcode |
| streamType | LIVE | BUFFERED |
| Playback starts | During transcode | After transcode |
| File | `packages/app/backend/index.mjs` | `packages/app/pear-src/workers/core/index.ts` |

**The fix was to align desktop with mobile's approach.**

## Theories NOT Yet Tested (if issue recurs)

### 1. PTS/DTS Discontinuity
The timestamps might have a gap or discontinuity at segment boundaries. When using flush() the muxer continues but maybe the PTS jumps. Need to log actual PTS values at segment boundaries.

### 2. Continuity Counter Reset/Wrap
MPEGTS continuity counters (4-bit, 0-15) must be sequential per PID. After 37 segments with thousands of packets, there might be a counter issue. Would need to analyze raw MPEGTS packets.

### 3. Audio/Video Interleave Issue
The continuous muxer interleaves A/V packets. When we cut at a video keyframe, we might be cutting mid-audio-frame or creating A/V desync that accumulates.

### 4. PCR (Program Clock Reference) Drift
PCR timestamps used for decoder synchronization might drift or have discontinuities.

### 5. Segment Data Corruption at flush()
When `flush()` is called, maybe some packets are incomplete or corrupted.

### 6. Buffer Boundary Issue
`segmentBuffer` is cleared after each segment. Maybe a packet spans the boundary and gets corrupted.

## Key Code Locations

### Segment Boundary Logic (line ~2654)
```javascript
if (segmentDuration >= TARGET_SEGMENT_DURATION && continuousMuxer) {
  flushAndStoreSegment(continuousMuxer, segmentIndex, segmentDuration)
  segmentIndex++
  segmentStartPts = pts
}
```

### flushAndStoreSegment (line ~1575)
```javascript
const flushAndStoreSegment = (muxer, segmentIdx, duration) => {
  muxer.format.flush()
  let data = Buffer.concat(segmentBuffer)
  segmentBuffer = []  // Clear for next segment
  // ... store segment
}
```

### PAT Reorder Fix (line ~736)
```javascript
if (patOffset > 0) {
  const beforePat = segmentData.subarray(0, patOffset)
  const patPmt = segmentData.subarray(patOffset, patOffset + patPmtLen)
  const afterPmt = segmentData.subarray(patOffset + patPmtLen)
  segmentData = Buffer.concat([patPmt, beforePat, afterPmt])
}
```

### Muxer Write Callback (captures segment data)
```javascript
muxerFormat.write = (data, pos) => {
  if (pos === undefined || pos === null) {
    segmentBuffer.push(Buffer.from(data))
  }
}
```

## Debugging Suggestions

1. **Dump segment 37 and 38 to files** and analyze with `ffprobe -show_packets` to check PTS/DTS continuity

2. **Log PTS at segment boundaries** - add logging before/after flushAndStoreSegment to see timestamp jumps

3. **Test with VLC/Safari** - do they also stall at 56s? If not, it's Chromecast-specific

4. **Analyze MPEGTS packets** - check continuity counters across segment boundary

5. **Try different TARGET_SEGMENT_DURATION** - already tried 6s (stalls at 54s), try 10s or 1s

6. **Compare with working HLS** - use ffmpeg CLI to create reference HLS and compare packet structure

## Files Modified
- `packages/backend/src/transcode/hls-transcoder.mjs` - main transcoder
- `packages/backend/src/transcode/hls-segment-manager.mjs` - segment storage and playlist

## How to Test
1. Run the app: `npm run pear` from project root
2. Cast any video to Chromecast
3. Watch `logfile` in project root for debug output
4. Stall occurs at ~56 seconds consistently

## Environment
- Platform: macOS (Darwin)
- Chromecast: Standard Chromecast device
- FFmpeg: via bare-ffmpeg native addon
- Runtime: Pear (desktop) with pear-electron
