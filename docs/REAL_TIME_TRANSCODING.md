# PearTube Real-Time Video Transcoding for Chromecast Casting

## Overview

PearTube implements a sophisticated real-time video transcoding system that enables seamless casting of any video format to Chromecast devices, even when the source video uses codecs or containers not natively supported by Chromecast. The system automatically detects compatibility, transcodes on-the-fly, and streams HLS (HTTP Live Streaming) segments to the Chromecast device.

## Architecture

The transcoding system is built across multiple layers:

```
┌─────────────────┐
│   React UI    │  (useCast hook, DevicePickerModal)
└────────┬────────┘
         │ HRPC
         ▼
┌─────────────────────────────────────────────┐
│      Backend Worker (index.mjs)          │
│  - Device discovery management             │
│  - RPC handler coordination               │
│  - Proxy server for localhost URLs       │
└────────┬────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│   HLS Transcoder (hls-transcoder.mjs)   │
│  - Media probing                        │
│  - FFmpeg transcoding pipeline           │
│  - HLS segment generation              │
│  - Segment storage (memory + disk)       │
│  - HTTP server for streaming            │
└────────┬────────────────────────────────────┘
         │
         ├──────────────────┬──────────────────┐
         ▼                  ▼
┌─────────────────┐  ┌──────────────────────┐
│  bare-ffmpeg   │  │   HypercoreIOReader  │
│  - Decoders   │  │  - Direct block    │
│  - Encoders   │  │    access           │
│  - Scalers    │  │  - P2P data       │
│  - Resamplers │  │    streaming       │
└─────────────────┘  └──────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│   bare-fcast (chromecast.js)           │
│  - Chromecast protocol implementation    │
│  - TLS + protobuf messaging            │
│  - Session management                 │
└────────┬────────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│ Chromecast     │
│  Device       │
└─────────────────┘
```

## 1. Device Discovery (mDNS)

### Service Discovery (`packages/bare-fcast/lib/discovery.js`)

The system automatically discovers both FCast and Chromecast devices on the local network using mDNS (multicast DNS):

- **mDNS Address**: `224.0.0.251:5353`
- **FCast Service**: `_fcast._tcp.local.`
- **Chromecast Service**: `_googlecast._tcp.local.`

The discovery process:
1. Sends mDNS PTR queries for both service types
2. Parses DNS responses to extract device information
3. Emits `deviceFound` events with device details (host, port, name, protocol)
4. Maintains active device list for user selection

Device information includes:
- `id`: Unique device identifier
- `name`: Human-readable device name
- `host`: IP address
- `port`: Service port (46899 for FCast, 8009 for Chromecast)
- `protocol`: 'fcast' or 'chromecast'

## 2. Chromecast Protocol Implementation

### Connection Layer (`packages/bare-fcast/lib/chromecast.js`)

Chromecast uses a sophisticated protocol stack:

**Transport**: TLS on port 8009
**Encoding**: Protocol Buffers with JSON payloads
**Namespaces**:
- `urn:x-cast:com.google.cast.tp.connection` - Connection management
- `urn:x-cast:com.google.cast.tp.heartbeat` - Keep-alive pings
- `urn:x-cast:com.google.cast.receiver` - Receiver control
- `urn:x-cast:com.google.cast.media` - Media playback

**Connection Flow**:
1. Establish TLS connection to device
2. Send CONNECT message to `receiver-0`
3. Launch Default Media Receiver app (ID: `CC1AD845`)
4. Send CONNECT message to transport channel
5. Begin sending media commands

**Message Format**:
```
┌─────────────────────────────────────┐
│ 4 bytes: message length (BE)     │
├─────────────────────────────────────┤
│ Protocol Buffer:                  │
│   - protocol_version (varint)    │
│   - source_id (string)          │
│   - destination_id (string)       │
│   - namespace (string)           │
│   - payload_type (varint)        │
│   - payload_utf8/binary (bytes)  │
└─────────────────────────────────────┘
```

**Key Features**:
- **Heartbeat**: 5-second interval PING/PONG to maintain connection
- **Status Polling**: 5-second interval GET_STATUS requests
- **Debouncing**: 1-second minimum between LOAD commands to prevent crashes
- **Buffer Management**: 10MB limit with overflow protection
- **Connection Recovery**: Graceful cleanup and reconnection logic

### Chromecast Supported Formats

**Video Codecs**: H.264 (avc1), VP8, VP9, AV1
**Audio Codecs**: AAC, MP3, Opus, FLAC, Vorbis
**Containers**: MP4, WebM, MKV (with compatible codecs)

Unsupported formats trigger automatic transcoding.

## 3. Media Probing and Compatibility Detection

### Probe Logic (`packages/app/backend/index.mjs`)

When casting to Chromecast, the system probes the source video to determine if transcoding is needed:

```javascript
// Probe uses bare-ffmpeg to analyze video
const probeResult = await transcoder.probeMedia(url, title)

// Returns:
{
  videoCodec: 'hevc' | 'h264' | 'vp9' | ...
  audioCodec: 'opus' | 'aac' | 'vorbis' | ...
  container: 'matroska' | 'mp4' | ...
  needsTranscode: boolean,
  needsRemux: boolean,
  reason: string
}
```

**Transcode Triggers**:
- **Video Transcode**: HEVC/H.265, VP8/VP9 (convert to H.264)
- **Audio Transcode**: Opus, Vorbis, FLAC (convert to AAC)
- **Container Remux**: MKV/Matroska, AVI (convert to MPEGTS)

**Direct Play Conditions**:
- Container: MP4/WebM
- Video: H.264/AVC1
- Audio: AAC
- Result: Stream URL passed directly to Chromecast

## 4. Real-Time Transcoding Pipeline

### Architecture (`packages/app/backend/hls-transcoder.mjs`)

The transcoding system uses FFmpeg for real-time conversion to HLS (HTTP Live Streaming) format:

#### Input Sources (Priority Order)

1. **HypercoreIOReader** (Fastest)
   - Direct access to P2P Hypercore blocks
   - Zero HTTP overhead
   - Used when video fully synced
   - Reads from Hypercore `blob` core

2. **TempFileReader** (Fast)
   - HTTP streaming with seek capability
   - Downloads video head + tail for MKV cue extraction
   - Handles partial sync gracefully
   - Falls back to sequential reads for missing blocks

3. **StreamingHTTPReader** (Fallback)
   - Simple HTTP streaming without seeking
   - Used for remote URLs
   - Sequential read-only access

#### Transcoding Modes

**Mode 1: Full Transcode** (Video OR Audio needs conversion)

```
[Source Video] → [Video Decoder] → [Scaler] → [H.264 Encoder]
                                                   ↓
                                        [MPEGTS Muxer]
                                                   ↓
[Source Audio] → [Audio Decoder] → [Resampler] → [Audio FIFO] → [AAC Encoder]
                                                                      ↓
                                                              [MPEGTS Muxer]
                                                                      ↓
                                                               [HLS Segments]
```

**Mode 2: Remux Only** (Container change only)

```
[Source Video/Audio] → [Bitstream Filter] → [MPEGTS Muxer] → [HLS Segments]
```

#### FFmpeg Pipeline Components

**Video Pipeline**:
```javascript
// Hardware-accelerated decoding (when available)
const videoDecoder = ffmpeg.createDecoderContext('hevc_mediacodec')

// Software/Hardware encoder selection
const h264Encoder = ffmpeg.createEncoderContext('h264_videotoolbox')

// Optional scaling (resolution conversion)
const scaler = ffmpeg.Scaler(
  srcWidth, srcHeight, srcPixelFormat,
  dstWidth, dstHeight, dstPixelFormat
)

// MPEGTS timebase (90000 Hz)
videoEncoder.timeBase = { numerator: 1, denominator: 90000 }
```

**Audio Pipeline**:
```javascript
// Audio decoder
const audioDecoder = ffmpeg.createDecoderContext('opus')

// Resampler (sample rate conversion, channel mixing)
const resampler = ffmpeg.Resampler(
  inputSampleRate, inputLayout, inputFormat,
  outputSampleRate, outputLayout, outputFormat
)

// Audio FIFO (buffer between resampler and encoder)
const audioFifo = ffmpeg.AudioFIFO(
  outputLayout.nbChannels, outputFormat, 1
)

// AAC encoder (Chromecast preferred)
const audioEncoder = ffmpeg.createEncoderContext('aac')
audioEncoder.sampleRate = 48000
audioEncoder.channelLayout = 'stereo'
```

#### HLS Segmentation

**Segment Strategy**: Keyframe-based with duration cap

```javascript
const TARGET_SEGMENT_DURATION = 8.0  // seconds
const MAX_SEGMENT_DURATION = 8.0       // seconds

// Process encoder output packets
while (videoEncoder.receivePacket(packet)) {
  const isKeyframe = (packet.flags & 1) !== 0
  const segmentDuration = currentPts - segmentStartPts

  // On keyframe: check if we should start new segment
  if (isKeyframe && segmentDuration >= TARGET_SEGMENT_DURATION) {
    // Flush current segment to storage
    flushSegment(segmentBuffer, segmentIndex, segmentDuration)
    segmentIndex++
    segmentStartPts = currentPts
  }
}
```

**Segment Storage** (`hls-segment-manager.mjs`):
- **Primary**: In-memory buffer (fast access)
- **Secondary**: Disk spillover (os.tmpdir())
- **Max Segments**: 12 (rolling buffer)
- **Lifecycle**: Auto-expired after 30 minutes

**Segment Format**:
- Container: MPEG-TS (Transport Stream)
- Video: H.264 with Annex-B start codes
- Audio: AAC with AudioSpecificConfig
- Filename: `segment_000000.ts`, `segment_000001.ts`, ...

#### Hardware Encoder Compatibility

**H.264 Encoder Selection** (Priority Order):
1. `h264_mediacodec` - Android hardware encoding
2. `h264_videotoolbox` - iOS/macOS hardware encoding
3. `libx264` - Software encoding (GPL build)

**Critical Fixes for Hardware Encoders**:

```javascript
// Hardware encoders only include SPS/PPS in first keyframe
// For HLS segments to be independently decodable, we need SPS/PPS in EVERY keyframe

// Extract SPS/PPS from first keyframe
if (hasSPS && hasPPS && !spsPpsNalus) {
  spsPpsNalus = extractSpsPps(firstKeyframe)
}

// Inject SPS/PPS into subsequent keyframes
if (isKeyframe && spsPpsNalus && !hasSPS) {
  packetData = injectSpsPps(packetData, spsPpsNalus)
}
```

#### Audio FIFO Buffering

Audio frames from resampler have variable sizes, but encoder expects fixed frame sizes. The FIFO ensures smooth flow:

```javascript
const AAC_FRAME_SIZE = 1024  // samples per AAC frame

while (audioResampler.receiveFrame(frame)) {
  audioFifo.write(frame)  // Add to FIFO
}

// Read from FIFO when we have enough samples
while (audioFifo.size >= AAC_FRAME_SIZE) {
  const samples = audioFifo.read(AAC_FRAME_SIZE)
  audioEncoder.sendFrame(samples)

  while (audioEncoder.receivePacket(packet)) {
    writePacketToMuxer(packet)
  }
}
```

#### MPEG-TS Muxing

**Single Continuous Muxer Approach**:

Unlike traditional HLS (create new muxer per segment), this system uses ONE muxer for the entire stream:

```javascript
// Create muxer once at start
const muxer = new OutputFormatContext('mpegts', io)
muxer.createStream(videoEncoder)
muxer.createStream(audioEncoder)

// Stream ALL packets through same muxer
while (transcoding) {
  // ... encode packets ...
  muxer.writeFrame(packet)  // Write to continuous stream
  muxer.flush()             // Flush current segment data
}

// Segment boundaries determined by collecting muxer output
// and cutting on keyframes
```

**Benefits**:
- No timestamp rebasing required
- Natural A/V sync maintained by FFmpeg
- Lower memory overhead (no multiple muxers)
- Simpler PTS/DTS management

## 5. HLS Playlist Management

### M3U8 Generation

Dynamic playlist that updates as segments complete:

```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:8
#EXT-X-MEDIA-SEQUENCE:0

#EXTINF:8.000,
segment_000000.ts

#EXTINF:8.000,
segment_000001.ts

#EXTINF:8.000,
segment_000002.ts

#EXT-X-ENDLIST
```

**Playlist Updates**:
- Generated after each segment completes
- Cached in memory for fast HTTP responses
- Automatically includes all available segments
- Chromecast refreshes playlist during playback

### HTTP Server

**Endpoint Structure**:
```
GET /hls/{sessionId}/stream.m3u8    → HLS playlist
GET /hls/{sessionId}/segment_000000.ts → Video segment
GET /ping                               → Health check
```

**Server Features**:
- **CORS Headers**: `Access-Control-Allow-Origin: *`
- **Range Requests**: Supported for segment seeking
- **LAN Access**: IP rewriting for Chromecast (localhost → LAN IP)
- **Single Session**: Only one active transcode at a time (prevents resource exhaustion)

## 6. Chromecast Integration

### Playback Flow

1. **User Initiates Cast**
   ```javascript
   await rpc.castPlay({
     url: 'pear://blobs/...',
     contentType: 'video/x-matroska',
     title: 'My Video',
     thumbnail: '...'
   })
   ```

2. **Backend Probes Media**
   - Detects HEVC video codec
   - Detects Opus audio codec
   - Determines `needsTranscode = true`

3. **Start HLS Transcode Session**
   ```javascript
   const result = await hlsTranscoder.startHlsTranscode(url, {
     title: 'My Video',
     store: ctx.store,
     blobInfo: { blockOffset, blockLength, ... },
     onProgress: (sessionId, percent) => { ... }
   })

   // Returns:
   {
     success: true,
     sessionId: 'abc123...',
     hlsUrl: 'http://192.168.1.100:54321/hls/abc123.../stream.m3u8'
   }
   ```

4. **Wait for Segments**
   - Poll for first N segments (default: 1 segment)
   - Timeout: 30 seconds
   - Once segments ready, Chromecast can start playback

5. **Send LOAD to Chromecast**
   ```javascript
   await castContext.play({
     url: 'http://192.168.1.100:54321/hls/abc123.../stream.m3u8',
     contentType: 'application/x-mpegurl',
     title: 'My Video',
     streamType: 'BUFFERED'  // or 'LIVE' for no seeking
   })
   ```

6. **Chromecast Requests Playlist**
   ```
   GET http://192.168.1.100:54321/hls/abc123.../stream.m3u8
   → Returns m3u8 with segment URLs
   ```

7. **Chromecast Requests Segments**
   ```
   GET http://192.168.1.100:54321/hls/abc123.../segment_000000.ts
   GET http://192.168.1.100:54321/hls/abc123.../segment_000001.ts
   ...
   ```

8. **Transcoding Continues in Background**
   - Generates new segments as video progresses
   - Playlist updates automatically
   - Chromecast downloads latest segments

### State Management

**Playback States**:
- `idle` - No media loaded
- `loading` - Media loading/buffering
- `buffering` - Rebuffering
- `playing` - Active playback
- `paused` - Playback paused
- `stopped` - Playback stopped
- `error` - Playback error

**Progress Tracking**:
```javascript
{
  currentTime: 45.7,  // seconds
  duration: 3600.0,  // seconds
  volume: 0.8,       // 0.0 - 1.0
  state: 'playing'
}
```

### Volume Control

Volume normalization between UI (0-100) and Chromecast (0.0-1.0):

```javascript
function normalizeVolumeToCast(volume) {
  if (volume <= 1) {
    return Math.max(0, Math.min(1, volume))
  }
  return Math.max(0, Math.min(100, volume)) / 100
}
```

## 7. Performance Optimizations

### Memory Management

**Segment Buffer Limits**:
- Max 12 segments in memory
- Disk spillover for additional segments
- Auto-cleanup of old segments
- 10MB buffer limit on Chromecast socket

**FFmpeg Memory**:
- Single decoder/encoder per stream
- Reuse Frame/Packet objects (unref after use)
- Scaler created once, reused for all frames
- Minimal intermediate buffers

### Transcoding Speed

**Hardware Acceleration**:
- Video decoding: `hevc_mediacodec` / `h264_videotoolbox`
- Video encoding: `h264_mediacodec` / `h264_videotoolbox`
- 5-10x faster than software encoding

**Parallel Processing**:
- I/O and transcoding run concurrently
- Segment storage is fire-and-forget (non-blocking)
- HTTP handlers don't wait for transcode loop

### Network Optimization

**LAN IP Detection**:
- Automatically detects local network interface
- Rewrites `localhost` to actual LAN IP (e.g., `192.168.1.100`)
- Enables Chromecast on same network to access local HTTP server

**Connection Pooling**:
- Single mDNS socket for all queries
- Reuse existing Chromecast TLS connection
- Session reuse for repeated casts of same video

### Latency Reduction

**Low Segment Duration**:
- 8-second segments (vs typical 10-second)
- Faster initial playback start
- Smaller buffer requirements

**Keyframe Detection**:
- Segment cuts on actual keyframes (I-frames)
- Instant decoding at segment boundaries
- No rebuffering at segment transitions

## 8. Error Handling and Recovery

### Transcode Failures

**Graceful Degradation**:
1. Probe failure → Attempt direct play
2. Transcode error → Fallback to direct play
3. Partial sync → Continue transcoding (TempFileReader handles EOF)

**User Feedback**:
- Transcode progress via UI (0-100%)
- Clear error messages
- Automatic retry on transient failures

### Connection Errors

**Chromecast Disconnect**:
- Auto-detect via heartbeat failure
- Cleanup transcode session
- Allow user to reconnect

**Network Errors**:
- Socket timeout: 3 seconds (TLS handshake), 5 seconds (connect)
- Retry logic with exponential backoff
- Graceful socket closure (end() before destroy())

### P2P Data Issues

**Incomplete Video Sync**:
- Advisory warning only (doesn't block cast)
- TempFileReader handles missing blocks gracefully
- Returns EOF instead of crashing

**Block Download Errors**:
- Transcode pauses until data available
- Resumes automatically when sync completes
- Progress updates reflect actual data availability

## 9. Security Considerations

### CORS and Headers

All HTTP responses include CORS headers to allow Chromecast access:

```javascript
res.setHeader('Access-Control-Allow-Origin', '*')
res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS')
res.setHeader('Access-Control-Allow-Headers', 'Range,Content-Type,Accept,Origin')
res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges')
```

### Path Validation

Prevents directory traversal attacks:

```javascript
if (extraSegments.some(seg => seg === '.' || seg === '..')) {
  res.statusCode = 400
  res.end('Invalid cast proxy path.')
  return
}
```

### mDNS Security

- Only responds to mDNS on local network
- No external network access
- Service records verified before connection

## 10. Configuration and Tuning

### Key Constants

**Segment Duration** (`HLS_SEGMENT_DURATION = 8`):
- Lower values: Faster playback start, more segments
- Higher values: Fewer HTTP requests, larger buffers

**Max Segments** (`HLS_MAX_SEGMENTS = 12`):
- Lower values: Less memory, shorter seek range
- Higher values: Better seeking, more memory usage

**Session TTL** (`CAST_PROXY_TTL_MS = 30 * 60 * 1000`):
- Time before inactive sessions are cleaned up
- Prevents resource leaks

### Hardware Encoder Selection

Automatically selects best available encoder based on platform:

```javascript
// Android
const encoder = 'h264_mediacodec'  // Snapdragon/Exynos GPUs

// iOS/macOS
const encoder = 'h264_videotoolbox'  // Apple Video Toolbox

// Fallback (software)
const encoder = 'libx264'  // x264 library (requires GPL build)
```

## 11. Debugging and Monitoring

### Logging Levels

**Backend**:
- `[Backend]` - High-level operations
- `[HlsTranscoder]` - Transcoding pipeline
- `[CastProxy]` - HTTP server operations
- `[Chromecast]` - Protocol messages

**Key Events**:
- `Probe result` - Codec detection
- `HLS transcode started` - Session initialization
- `HLS transcode progress: X%` - Progress updates
- `First encoder packet` - Successful encoding start
- `Keyframe #N` - Segmentation points
- `Segment ready` - HLS segment completion

### Performance Metrics

Track transcoding performance:
- Real-time factor (transcode speed / playback speed)
- >1.0x: Faster than real-time (good)
- <1.0x: Slower than real-time (will buffer)

Memory usage:
- Segment count (should stay ≤12)
- FFmpeg buffer sizes (log warnings if growing)

### Common Issues and Solutions

**Chromecast Shows Loading Forever**:
- Check HLS playlist is accessible
- Verify segments are being generated
- Check LAN IP is correct

**Playback Stutters**:
- Increase segment duration
- Check for CPU throttling
- Verify hardware encoder is in use

**Audio Out of Sync**:
- Check PTS rescaling in transcoder
- Verify audio FIFO is draining properly
- Check sample rate conversion settings

## 12. Future Enhancements

Potential improvements to consider:

1. **Adaptive Bitrate Streaming** (ABR)
   - Generate multiple quality variants
   - Chromecast switches based on network conditions
   - Requires multiple parallel transcode sessions

2. **GPU-accelerated Transcoding**
   - More hardware encoder support
   - Vulkan/Metal compute shaders
   - Better mobile battery life

3. **Segment Pre-caching**
   - Pre-transcode first N segments before cast
   - Faster initial playback
   - Higher memory usage

4. **Direct Chromecast Media Player**
   - Custom receiver app
   - Better control over buffering
   - Custom UI on TV

## Summary

PearTube's real-time transcoding system enables seamless Chromecast casting of any video format through:

1. **Automatic Detection** - Probe media, determine compatibility
2. **Smart Transcoding** - Only convert what's necessary (video/audio/container)
3. **HLS Streaming** - Real-time segment generation for instant playback
4. **Hardware Acceleration** - Mobile GPU encoding for speed
5. **P2P Integration** - Direct Hypercore access when fully synced
6. **Robust Error Handling** - Graceful degradation and recovery

The system is production-ready with comprehensive error handling, memory management, and network optimization.
