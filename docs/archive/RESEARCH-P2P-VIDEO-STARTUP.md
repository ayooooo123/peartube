# Research Prompt: P2P Video Playback Startup Optimization

## Context

PearTube is a decentralized P2P video streaming app built on the Holepunch stack (Hypercore, Hyperdrive, Hyperblobs, Hyperswarm). Videos are stored in Hyperblobs and streamed via a local blob server (`http://127.0.0.1:<port>`). The app uses VLCPlayer on iOS/Android and MPV on desktop.

## Current Performance

After recent optimizations, the video startup timeline is:

| Phase | Duration | Status |
|-------|----------|--------|
| Tap → URL generated | ~13ms | ✅ Optimized (was 15+ seconds) |
| URL → VLC initialized | ~200ms | ✅ Acceptable |
| VLC initialized → First frame | **~3.4 seconds** | ⚠️ Bottleneck |

The 3.4 second delay occurs because:
1. VLC requests data from `http://127.0.0.1:<port>/?key=...&blob=...`
2. Blob server receives request and starts fetching from Hyperblobs
3. Hyperblobs needs to download chunks from P2P peers via Hyperswarm
4. VLC waits for enough data to parse container headers and begin playback

During this time, download progress shows: 0% → 2% → 3% → 4%...

## Technical Stack

```
┌─────────────────────────────────────────────────────────┐
│  VLCPlayer (React Native)                               │
│  - Uses libVLC with --network-caching=0                 │
│  - Requests video via HTTP from localhost               │
└─────────────────────┬───────────────────────────────────┘
                      │ HTTP GET
┌─────────────────────▼───────────────────────────────────┐
│  Blob Server (packages/backend/src/blob-server.js)      │
│  - Serves Hyperblob data as HTTP stream                 │
│  - Uses hyperblobs.createReadStream(blobId)             │
└─────────────────────┬───────────────────────────────────┘
                      │ createReadStream()
┌─────────────────────▼───────────────────────────────────┐
│  Hyperblobs                                             │
│  - Stores video as blob with blobId (start:length:...)  │
│  - Backed by Hypercore for chunk storage                │
└─────────────────────┬───────────────────────────────────┘
                      │ get(index)
┌─────────────────────▼───────────────────────────────────┐
│  Hypercore                                              │
│  - Append-only log of chunks                            │
│  - Fetches missing chunks from peers via Hyperswarm     │
└─────────────────────┬───────────────────────────────────┘
                      │ replicate()
┌─────────────────────▼───────────────────────────────────┐
│  Hyperswarm                                             │
│  - DHT-based peer discovery                             │
│  - Holepunching for NAT traversal                       │
└─────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `packages/backend/src/blob-server.js` | HTTP server that streams Hyperblob data |
| `packages/backend/src/storage.js` | `getVideoUrlInstant()` - URL generation |
| `packages/app/components/video-player/VideoContainer.tsx` | VLCPlayer component |
| `packages/app/lib/VideoPlayerContext.tsx` | Video playback state management |
| `packages/backend/src/api.js` | RPC handlers including `prefetchVideo` |

## Research Questions

### 1. Container Format Optimization
- How much data does VLC need before it can start playback for MKV/MP4/WebM?
- Can we ensure video files have "faststart" (moov atom at beginning for MP4)?
- Would transcoding to a more streaming-friendly format help?

### 2. Hypercore/Hyperblobs Optimization
- Can we prioritize fetching the first N chunks before others?
- Is there a way to do "range request" style fetching with Hyperblobs?
- Can we pre-warm peer connections before video is tapped?

### 3. Pre-buffering Strategies
- **On video card visible**: Start downloading first 500KB when thumbnail appears
- **On video card hover/long-press**: Aggressively prefetch first 2MB
- **Background prefetch**: Download headers of all videos in feed

### 4. Blob Server Improvements
- Can we add HTTP range request support to serve partial content?
- Can we add buffering/caching at the blob server level?
- Would chunked transfer encoding help VLC start faster?

### 5. VLC Configuration
- Are there other VLC init options that could help?
- Would a different demuxer setting help?
- Can we use VLC's prefetch/preload capabilities?

### 6. Alternative Approaches
- **HLS/DASH**: Convert to adaptive streaming on-the-fly
- **WebTorrent-style**: Use browser's media source extensions
- **Seek to cached**: If middle of video is cached, start there

### 7. Existing Solutions
- How do other P2P video apps (WebTorrent, PeerTube, LBRY) handle this?
- What techniques does BitTorrent streaming use?
- Are there academic papers on P2P video streaming latency?

## Success Criteria

- Reduce time from tap to first frame from 3.4s to under 1.5s for uncached videos
- Maintain current instant playback for cached videos
- No significant increase in bandwidth usage
- Solution works across iOS, Android, and desktop

## Constraints

- Must work with Holepunch stack (can't switch to different P2P protocol)
- VLCPlayer is the primary mobile player (can't easily switch)
- Videos are user-uploaded, various formats (MKV, MP4, WebM, etc.)
- Mobile devices may have limited memory for buffering

## Deliverables

1. Analysis of each approach with pros/cons
2. Recommended solution(s) with implementation plan
3. Proof-of-concept code if applicable
4. Performance benchmarks comparing approaches

## How to Test

```bash
# Clear app cache to test fresh video
adb shell pm clear com.peartube.app

# Monitor startup timing
adb logcat -c && adb logcat | grep -iE "getVideoUrl|INSTANT|state=PLAYING|Stats.*0%"

# Tap a video and measure time from first log to state=PLAYING
```

## References

- Hypercore Protocol: https://docs.holepunch.to/
- Hyperblobs: https://github.com/holepunchto/hyperblobs
- VLC command line options: https://wiki.videolan.org/VLC_command-line_help/
- PeerTube (federated video): https://github.com/Chocobozzz/PeerTube
