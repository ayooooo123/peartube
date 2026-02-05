# VLC Video Player Performance Baselines

**Captured**: 2026-02-05  
**Platform**: iOS/Android (VLCPlayer)  
**Context**: Before Nitro implementation  
**Source**: RESEARCH-P2P-VIDEO-STARTUP.md + VideoPlayerContext.tsx analysis

## Video Start Time Baseline

**Metric**: Time from `loadAndPlayVideo()` call to first `onProgress` callback

### Measurement Details

| Phase | Duration | Notes |
|-------|----------|-------|
| Tap → URL generated | ~13ms | Via `getVideoUrlInstant()` in storage.js |
| URL → VLC initialized | ~200ms | VLC native initialization |
| VLC initialized → First frame | **~3400ms** | ⚠️ **BOTTLENECK** |
| **Total (cold start)** | **~3613ms** | Uncached video |

### Baseline Value
```
start_time_baseline: 3400ms (VLC init → first onProgress)
total_cold_start: 3613ms (tap → first frame)
```

### Why This Delay Occurs

1. VLC requests data from `http://127.0.0.1:<port>/?key=...&blob=...`
2. Blob server receives request and starts fetching from Hyperblobs
3. Hyperblobs needs to download chunks from P2P peers via Hyperswarm
4. VLC waits for enough data to parse container headers and begin playback
5. During this time, download progress shows: 0% → 2% → 3% → 4%...

### Code References

- **loadAndPlayVideo()**: `packages/app/lib/VideoPlayerContext.tsx:595-616`
  - Sets `setIsPlaying(true)` and `setPlayerMode('fullscreen')`
  - Emits load event for prefetch trigger
  
- **onProgress callback**: `packages/app/lib/VideoPlayerContext.tsx:735-770`
  - Called by VLC when playback begins
  - Updates `currentTime` and `duration` state
  - Throttled to 250ms intervals via `UI_UPDATE_INTERVAL`

## Seek Latency Baseline

**Metric**: Time from `seekTo()` call to `onProgress` reflecting new position

### Measurement Details

| Operation | Latency | Notes |
|-----------|---------|-------|
| seekTo() → onProgress update | **~200ms** | Typical seek response |
| Seek to cached position | ~50-100ms | Faster for cached chunks |
| Seek to uncached position | ~300-500ms | Requires chunk fetch |

### Baseline Value
```
seek_latency_baseline: 200ms (typical)
seek_latency_cached: 50-100ms
seek_latency_uncached: 300-500ms
```

### How Seeking Works

1. **seekTo()** called with target time (line 687-725)
   - Clamps time to valid range: `Math.max(0, Math.min(time, dur))`
   - Calculates seek position as fraction: `seekValue = clampedTime / dur`
   - Sets `seekPosition` state prop for VLC
   
2. **VLC processes seek**
   - Requests data from new position
   - May need to fetch new chunks from Hyperblobs
   
3. **onProgress fires** with new `currentTime`
   - UI updates via throttled interval (250ms)
   - MediaSession updated (1000ms throttle)

### Code References

- **seekTo()**: `packages/app/lib/VideoPlayerContext.tsx:687-725`
  - Handles both web and native platforms
  - Uses `setSeekPosition()` state for VLC prop
  - Clears seek position after 100ms
  
- **Seek state management**: Line 721-724
  - `setSeekPosition(seekValue)` triggers VLC seek
  - `setTimeout(() => setSeekPosition(undefined), 100)` clears it

## Performance Constraints

### VLC Configuration
- Network caching: `--network-caching=0` (minimal buffering)
- Events throttled to 250ms intervals (`UI_UPDATE_INTERVAL`)
- MediaSession updates throttled to 1000ms

### Hypercore/Hyperblobs Limitations
- Chunk-based fetching from P2P peers
- No HTTP range request support (yet)
- Requires container header parsing before playback

### Mobile Device Constraints
- Limited memory for buffering
- Variable network conditions
- Battery efficiency considerations

## Success Criteria for Optimization

- **Target**: Reduce cold start from 3.4s to <1.5s
- **Maintain**: Instant playback for cached videos
- **Constraint**: No significant bandwidth increase
- **Scope**: iOS, Android, and desktop

## Next Steps

1. Implement Nitro optimizations (Wave 2)
2. Measure impact on start_time and seek_latency
3. Compare against these baselines
4. Iterate on container format and prefetch strategies

---

**Status**: ✅ Baseline captured  
**Last Updated**: 2026-02-05
