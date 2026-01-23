# PearTube Transcoding/Casting 56s Stall Fix Plan

## Executive Summary

The 56-second stall issue occurs because **the video IS fully synced in Hypercore, but the code bypasses direct Hypercore access** and uses HTTP streaming instead. The HTTP path then deadlocks when the transcoder catches up to the download.

**Root Cause**: Three cascading issues prevent direct Hypercore reading:
1. `HypercoreIOReader` skipped because video (2.3GB) > size limit (512MB) - it preloads everything into RAM
2. `HypercoreStreamReader` disabled due to worker thread Corestore sharing issue
3. Fallback `TempFileReader` (HTTP) deadlocks when transcoder catches up to download

**The Fix**: Enable `HypercoreStreamReader` on the main thread for fully-synced large videos. No P2P waits needed since data is already local.

---

## Problem Analysis

### What the Logs Show

```
[TempFileReader] Download: 70MB (3%)
[HlsTranscoder] Segment 89 - duration: 2.00s
[TempFileReader] Transcoder caught up to download! STOPPING. pos: 75MB downloaded: 75MB fileSize: 2301MB
[matroska,webm @ 0xab5e7d180] File ended prematurely
```

After 90 segments (~180 seconds of video), the transcoder has processed 75MB but the download is at exactly 75MB - they've synchronized, and the transcoder returns EOF because it can't spin-wait (would deadlock the HTTP download).

### Timeline Reconstruction

| Time | Download | Transcode | Event |
|------|----------|-----------|-------|
| 0s | Start | Wait | Tail prefetch (10MB) |
| ~3s | 46MB | Start | Initial buffer ready |
| ~15s | 70MB | 73MB | Transcode catching up |
| ~18s | 75MB | 75MB | **CAUGHT UP - EOF** |
| ~56s | - | - | Chromecast buffers forever at 56.1s playback |

### Why This Happens

1. **Transcode speed > Download speed**: Hardware VideoToolbox encoder processes frames faster than HTTP can deliver from blob server
2. **P2P sync incomplete**: Video is only partially synced (blocks being fetched on-demand from peers)
3. **Initial buffer too small**: 46MB (~2% of 2301MB) doesn't give enough headroom
4. **No backpressure**: No mechanism to slow transcoding when download lead shrinks

---

## Architecture Deep Dive

### Current Flow

```
┌──────────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│  Blob Server     │────▶│   TempFileReader    │────▶│   HlsTranscoder  │
│  (HTTP:64402)    │     │   (Temp File)       │     │   (FFmpeg)       │
│                  │     │                     │     │                  │
│  - Serves P2P    │     │  - Downloads async  │     │  - Reads sync    │
│    blocks        │     │  - Writes to /tmp   │     │  - Encodes H264  │
│  - May fetch     │     │  - Returns EOF if   │     │  - Creates HLS   │
│    from peers    │     │    caught up        │     │    segments      │
└──────────────────┘     └─────────────────────┘     └──────────────────┘
         │                         │                         │
         │                         │                         ▼
         │                    Deadlock!               ┌──────────────────┐
         │                    Can't wait              │  HLS HTTP Server │
         │                                            │  (Port 64446)    │
         ▼                                            └────────┬─────────┘
┌──────────────────┐                                           │
│  Hypercore       │                                           ▼
│  (P2P Network)   │                                  ┌──────────────────┐
│  - Sparse sync   │                                  │   Chromecast     │
│  - 36811 blocks  │                                  │                  │
└──────────────────┘                                  └──────────────────┘
```

### The Deadlock Problem

```javascript
// In TempFileReader.syncRead() - line 520
if (!this.downloadComplete && availableToRead <= 0) {
  // CAN'T spin-wait here because:
  // 1. This is called from FFmpeg's sync read callback
  // 2. Blocking here blocks the event loop
  // 3. HTTP download also needs the event loop to receive data
  // 4. Result: Permanent deadlock
  return 0  // EOF - only safe option
}
```

---

## Proposed Solutions

### Solution 1: Hybrid Async/Sync Read with Worker Thread (RECOMMENDED)

**Concept**: Move transcoding to a separate worker thread that can safely block without deadlocking the HTTP download.

```
Main Thread                    Worker Thread
─────────────                  ─────────────
[HTTP Download]                [FFmpeg Transcode]
     │                              │
     │ ─── SharedArrayBuffer ────▶ │
     │    (Ring Buffer)            │
     │                              │
     │◀─── Atomics.wait() ─────── │
     │    (Wait for data)          │
```

**Implementation**:
```javascript
// worker-transcoder.js (bare-worker)
import { parentPort } from 'bare-worker'
import { Atomics } from 'bare-atomics'

parentPort.onmessage = (msg) => {
  const { sharedBuffer, controlBuffer } = msg.data
  
  // FFmpeg IOContext read callback
  const syncRead = (buffer) => {
    while (true) {
      const available = Atomics.load(controlBuffer, AVAILABLE_OFFSET)
      if (available >= buffer.length) {
        // Copy from shared buffer
        buffer.set(sharedBuffer.subarray(readPos, readPos + buffer.length))
        return buffer.length
      }
      
      // Wait for main thread to signal more data
      // This blocks the WORKER thread, not main thread!
      Atomics.wait(controlBuffer, SIGNAL_OFFSET, 0)
    }
  }
}
```

**Pros**:
- Clean separation of concerns
- No deadlock possible
- Can wait indefinitely for data
- Event loop stays responsive

**Cons**:
- Requires bare-worker (available in Pear/BareKit)
- SharedArrayBuffer complexity
- Need to manage worker lifecycle

**Effort**: Medium-High (3-5 days)

---

### Solution 2: Rate-Limited Transcoding with Download Lead Tracking

**Concept**: Actively slow down transcoding when download lead shrinks.

```javascript
// In HlsTranscoder transcode loop
const MIN_DOWNLOAD_LEAD = 50 * 1024 * 1024  // 50MB minimum lead
const LEAD_CHECK_INTERVAL = 100  // Check every 100 packets

if (packetCount % LEAD_CHECK_INTERVAL === 0) {
  const stats = streamReader.getStats()
  const lead = stats.downloadedBytes - stats.currentPos
  
  if (lead < MIN_DOWNLOAD_LEAD && !stats.downloadComplete) {
    // Pause transcoding until lead is restored
    console.log('[HlsTranscoder] Low lead, pausing...', Math.round(lead / 1024 / 1024) + 'MB')
    
    // Wait asynchronously for more data (non-blocking)
    await new Promise(resolve => {
      const checkLead = setInterval(() => {
        const newStats = streamReader.getStats()
        const newLead = newStats.downloadedBytes - newStats.currentPos
        if (newLead >= MIN_DOWNLOAD_LEAD || newStats.downloadComplete) {
          clearInterval(checkLead)
          resolve()
        }
      }, 500)
    })
  }
}
```

**Pros**:
- Relatively simple implementation
- No new dependencies
- Works with existing architecture

**Cons**:
- Adds latency to transcode loop
- async/await in packet loop may cause issues
- Still risks edge cases

**Effort**: Low-Medium (1-2 days)

---

### Solution 3: Full Pre-Download Before Transcode

**Concept**: For partially-synced videos, wait for full download before starting transcode.

```javascript
// In startHlsTranscode()
if (!isVideoComplete) {
  console.log('[HlsTranscoder] Video not fully synced, downloading first...')
  
  // Force waitForComplete mode
  const streamReader = new TempFileReader(sourceUrl, fileSize, {
    waitForComplete: true  // Always true for partial sync
  })
  
  // Show download progress to user
  await streamReader.startDownload((downloaded, total) => {
    const pct = Math.round(downloaded / total * 100)
    onProgress?.(sessionId, -pct)  // Negative = downloading phase
  })
}
```

**Pros**:
- 100% reliable (no catch-up possible)
- Simplest implementation
- Already partially implemented (`waitForComplete` flag)

**Cons**:
- Long wait for large files (2.3GB @ 10MB/s = ~4 minutes)
- Poor UX for partially-synced videos
- Blocks casting until download complete

**Effort**: Very Low (0.5 days)

---

### Solution 4: Chunked Transcode with Smart Prefetch

**Concept**: Transcode in chunks, ensuring each chunk's data is fully downloaded before processing.

```javascript
const CHUNK_SIZE = 100 * 1024 * 1024  // 100MB chunks

async function transcodeChunked() {
  let chunkStart = 0
  
  while (chunkStart < fileSize) {
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, fileSize)
    
    // Wait for this chunk to download
    await waitForRange(chunkStart, chunkEnd)
    
    // Transcode this chunk (guaranteed not to catch up)
    await transcodeRange(chunkStart, chunkEnd)
    
    chunkStart = chunkEnd
  }
}
```

**Pros**:
- Progressive playback possible
- Bounded memory usage
- No deadlock risk

**Cons**:
- Chunk boundaries may not align with keyframes
- Segment stitching complexity
- Seeking complications

**Effort**: Medium (2-3 days)

---

### Solution 5: HypercoreStreamReader with Block-Level Waiting

**Concept**: Use direct Hypercore access with async block fetching that naturally waits for P2P data.

```javascript
// Already exists: HypercoreStreamReader / HypercoreChannelReader
// But currently only used when video is "fully synced"

// Change: Use it for partial sync too, with block-level waiting
class HypercoreStreamReader {
  async read(buffer) {
    const neededBlocks = this.calculateNeededBlocks(buffer.length)
    
    // Wait for blocks to be available (async P2P fetch)
    for (const blockIdx of neededBlocks) {
      if (!await this.core.has(blockIdx)) {
        // This naturally waits for P2P without blocking event loop
        await this.core.get(blockIdx)
      }
    }
    
    // Now read synchronously (data is cached)
    return this.syncRead(buffer)
  }
}
```

**Pros**:
- Native P2P integration
- No HTTP overhead
- Block-level granularity
- Already have partial implementation

**Cons**:
- Complex FFmpeg IOContext integration
- May still need sync->async bridge
- Hypercore seek behavior complexities

**Effort**: Medium-High (3-4 days)

---

## Recommended Approach: Use HypercoreStreamReader on Main Thread

### The Simple Fix (Ship in 1 day)

Since the video is **already fully synced**, we can use `HypercoreStreamReader` directly on the main thread. It uses an LRU cache with prefetching - no need to preload 2.3GB into RAM.

**Key insight**: The `HypercoreChannelReader` worker thread approach was disabled because worker threads can't access the main thread's writable Corestore. But `HypercoreStreamReader` can run **on the same thread** and access the same Corestore directly.

### Code Change in `hls-transcoder.mjs`

```javascript
// Line ~3283 - REPLACE the disabled block with:

// Option 1: HypercoreStreamReader for large, fully-synced videos (on-demand with LRU cache)
if (!inputIO && blobInfo && blobsCoreKey && store && isVideoComplete) {
  try {
    console.log('[HlsTranscoder] Attempting HypercoreStreamReader for fully-synced video...')
    const blobsCore = store.get(Buffer.from(blobsCoreKey, 'hex'))
    await blobsCore.ready()
    
    const streamReader = new HypercoreStreamReader(blobsCore, blobInfo)
    await streamReader.initialize()  // Prefetches initial + tail blocks
    
    inputIO = streamReader.createIOContext(ffmpeg)
    session.hypercoreStreamReader = streamReader
    console.log('[HlsTranscoder] Using HypercoreStreamReader (on-demand, LRU cache)')
  } catch (err) {
    console.warn('[HlsTranscoder] HypercoreStreamReader failed:', err?.message)
  }
}

// Option 2: HypercoreIOReader for small videos (preload all into RAM) - existing code
// ...

// Option 3: TempFileReader HTTP fallback - existing code
// ...
```

### Why This Works

1. **No P2P waits**: Video is fully synced, so `core.get(blockIndex, { wait: false })` returns immediately
2. **LRU cache**: Only keeps 256 blocks (~16MB) in memory, not the entire 2.3GB
3. **Prefetching**: Reads ahead 64 blocks to stay ahead of FFmpeg
4. **Tail prefetch**: Loads last 16 blocks for MKV cues during initialization
5. **Same thread**: No Corestore sharing issues - uses the same store instance

### Fallback Chain (Priority Order)

| Priority | Reader | When Used | Memory |
|----------|--------|-----------|--------|
| 1 | `HypercoreStreamReader` | Large + fully synced | ~16MB cache |
| 2 | `HypercoreIOReader` | Small (<512MB) + fully synced | Full video |
| 3 | `TempFileReader` | Not synced or fallback | Initial buffer + download |

### Phase 2: Handle Partial Sync (Optional)

For partially-synced videos, keep `TempFileReader` but add rate limiting to avoid catch-up:

```javascript
// In TempFileReader.syncRead()
if (availableToRead < MIN_LEAD_BYTES && !this.downloadComplete) {
  // Instead of returning EOF, return partial data and trust FFmpeg retry
  console.warn('[TempFileReader] Low lead, returning partial read')
}
```

---

## Implementation Details

### File: `packages/backend/src/transcode/hls-transcoder.mjs`

**Location**: Lines ~3280-3390 (input source selection)

```javascript
// BEFORE (current - disabled):
// HypercoreChannelReader DISABLED: Worker thread opens read-only Corestore which can't
// access blocks from the main process's writable store. Falls back to TempFileReader (HTTP).
let hypercoreStreamError = 'HypercoreChannelReader disabled - using HTTP streaming'
console.log('[HlsTranscoder] Using TempFileReader (HTTP) for input')

// AFTER (fixed):
// Option 1: HypercoreStreamReader for LARGE, fully-synced videos (LRU cache, on-demand)
// This is the PRIMARY path for fully-synced videos > 512MB
if (!inputIO && blobInfo && blobsCoreKey && store && isVideoComplete) {
  try {
    console.log('[HlsTranscoder] Attempting HypercoreStreamReader for large fully-synced video...')
    const blobsCore = store.get(Buffer.from(blobsCoreKey, 'hex'))
    await blobsCore.ready()
    
    // Verify it's actually synced before committing
    const contiguous = blobsCore.contiguousLength
    const needed = blobInfo.blockOffset + blobInfo.blockLength
    if (contiguous >= needed) {
      const streamReader = new HypercoreStreamReader(blobsCore, blobInfo)
      await streamReader.initialize()  // Prefetch initial + tail blocks (~9MB)
      
      inputIO = streamReader.createIOContext(ffmpeg)
      session.hypercoreStreamReader = streamReader
      console.log('[HlsTranscoder] Using HypercoreStreamReader - cache:', streamReader.cache.size, 'blocks')
    } else {
      console.log('[HlsTranscoder] Video claims complete but contiguous check failed:',
        contiguous, '<', needed, '- falling back to HTTP')
    }
  } catch (err) {
    console.warn('[HlsTranscoder] HypercoreStreamReader failed:', err?.message)
  }
}

// Option 2: HypercoreIOReader for SMALL videos (preload all - existing code)
// ...

// Option 3: TempFileReader HTTP fallback (existing code)
// ...
```

### Verification Checklist

Before implementing, verify these conditions in the logs:

1. **Video IS fully synced**: Look for `CHECK_VIDEO_SYNC: contiguousLength covers all blocks - COMPLETE`
2. **Size limit triggered**: Look for `Skipping HypercoreIOReader for large video: 2301MB`
3. **HTTP fallback used**: Look for `Using TempFileReader (HTTP)`
4. **Catch-up occurred**: Look for `Transcoder caught up to download! STOPPING`

If all four are present, the fix is confirmed correct.

### Testing Plan

1. **Happy path**: Cast a fully-synced 2GB+ video → should use HypercoreStreamReader
2. **Small video**: Cast a fully-synced <500MB video → should use HypercoreIOReader  
3. **Partial sync**: Cast a 50% synced video → should use TempFileReader (with warnings)
4. **Memory check**: Monitor RAM usage during 2GB video transcode → should stay <100MB
5. **Seek test**: Skip to middle of video during cast → should handle MKV seeking

---

## Summary

| Issue | Root Cause | Fix |
|-------|------------|-----|
| Skipped direct read | Video > 512MB limit | Use `HypercoreStreamReader` with LRU cache |
| Worker disabled | Corestore sharing | Run on main thread instead |
| HTTP deadlock | Sync read blocks async download | Bypass HTTP entirely for synced videos |

**The fix is a single code change** (~30 lines) in `hls-transcoder.mjs` to enable `HypercoreStreamReader` for large fully-synced videos.

### Expected Results After Fix

```
[HlsTranscoder] Attempting HypercoreStreamReader for large fully-synced video...
[HlsStreamReader] Initialized, cached 128 blocks in 45ms
[HlsTranscoder] Using HypercoreStreamReader - cache: 128 blocks
[HlsTranscoder] Input source: HypercoreStreamReader inputIO: true
...
[HlsTranscoder] Video transcode complete, segments: 1150
```

No more `Transcoder caught up to download! STOPPING` - reads come directly from local Hypercore storage.

---

## Appendix: Log Analysis Commands

```bash
# Find catch-up events
grep "caught up to download" peartube.log

# Track download vs read positions
grep -E "Download:|Read progress:" peartube.log | head -100

# Find segment storage events
grep "Segment.*STORED" peartube.log | wc -l

# Track Chromecast buffer states
grep "MEDIA_STATUS.*buffering" peartube.log
```
