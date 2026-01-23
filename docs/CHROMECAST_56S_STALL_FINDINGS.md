# Chromecast 56-Second Stall - Investigation Findings

## Summary
Chromecast playback consistently stalls at exactly **56.48 seconds** regardless of:
- Segment duration (tested 2s and 4s segments - same stall point)
- Encoder type (hardware VideoToolbox vs software libx264)
- Input source (TempFileReader vs HypercoreStreamReader)

## Confirmed Working
- **HypercoreStreamReader**: Successfully reads directly from Hypercore blocks
- **Transcoding**: Generates 500+ segments (17+ minutes) without issues
- **Segment serving**: Chromecast requests and receives segments correctly up to ~38

## The Actual Problem
Chromecast BUFFERING debug shows:
```json
{
  "currentTime": 56.481538,
  "duration": -1,
  "liveSeekableRange": {
    "start": 0,
    "end": 1272.28  // 21+ minutes available!
  }
}
```

The player is stuck at 56.48s even though 21+ minutes of content is available and seekable.

## Key Observations

### 1. Time-Based, Not Segment-Based
- 2-second segments: stalls at segment ~28 (56s)
- 4-second segments: stalls at segment ~14 (56s)
- Conclusion: The stall is related to **playback time**, not segment count

### 2. Segments Are Served Correctly
- Chromecast requests segments 0-38 successfully
- Stops requesting new segments after segment 38
- Playlist requests continue (showing 500+ segments available)

### 3. StreamType is LIVE
- `duration: -1` indicates LIVE stream mode
- `liveSeekableRange` is populated and growing
- `isLiveDone: false`

## Potential Causes

### Theory 1: MPEG-TS Timestamp Issue
Something in the MPEG-TS stream around 56 seconds might be causing the player to stall:
- PCR discontinuity
- PTS/DTS gap or invalid value
- Missing PAT/PMT tables

### Theory 2: Chromecast Internal Buffer/Timeout
Chromecast may have an internal limit or timeout related to:
- LIVE stream buffer management
- Segment request pacing
- Internal media pipeline state

### Theory 3: HLS Playlist Format
The growing playlist (500+ segments) might confuse the Chromecast:
- Need to test with sliding window playlist
- Or EVENT playlist type with proper signaling

### Theory 4: Audio/Video Sync Issue
The audio and video streams might have a drift or discontinuity around 56s:
- Audio drift logged as ~21-42ms (seems acceptable)
- Need to verify A/V sync in the actual MPEG-TS

## Fix Applied

### Changed StreamType from LIVE to BUFFERED ✓

The root cause was identified: Chromecast in LIVE mode has an internal ~60 second buffer limit.
When the player reaches this limit, it stops requesting new segments and stalls.

**Fix applied to:**
- `packages/app/backend/index.mjs` (mobile) - already fixed
- `packages/app/pear-src/workers/core/index.ts` (desktop) - fixed line 2585

Using BUFFERED mode allows Chromecast to buffer without the 60-second limit, even though
we're transcoding in real-time. The HLS playlist still works correctly because Chromecast
continues to request new segments as they become available.

## Other Things To Try (if BUFFERED fix doesn't work)

### 2. Sliding Window Playlist
- Only include last N segments in playlist
- Add `#EXT-X-MEDIA-SEQUENCE` header

### 3. Verify MPEG-TS Timestamps
- Dump segment 27-29 and inspect with ffprobe
- Check for timestamp discontinuities

### 4. Test Different Chromecast Device
- Could be device-specific behavior
- Test on different Chromecast model

### 5. Add EXT-X-DISCONTINUITY Handling
- Maybe Chromecast needs explicit discontinuity markers

## Current Code State

### HypercoreStreamReader (Working)
- Reads directly from Hypercore blocks
- 512-block LRU cache (~32MB)
- Background prefetch polling every 100ms
- Fully synchronous reads (no async during FFmpeg callbacks)

### HLS Segment Manager
- In-memory storage with disk spill for old segments
- Keeps last 30 segments in memory
- VERSION:3 playlist format

### Encoder Settings
- H.264 Constrained Baseline Profile
- 8 Mbps bitrate
- GOP size: 48 frames (~2 seconds at 24fps)
- AAC audio at 128kbps stereo

## Files Modified
- `packages/backend/src/transcode/hypercore-stream-reader.mjs` - Rewritten for stability
- `packages/backend/src/transcode/hls-transcoder.mjs` - Uses HypercoreStreamReader
- `packages/backend/src/transcode/hls-segment-manager.mjs` - Segment storage
- `packages/app/backend/index.mjs` - streamType changed to BUFFERED (mobile)
- `packages/app/pear-src/workers/core/index.ts` - streamType changed to BUFFERED (desktop)
