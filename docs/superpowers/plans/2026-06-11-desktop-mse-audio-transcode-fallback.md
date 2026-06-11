# Desktop MSE fallback: real-time bare-ffmpeg audio transcode

Status: design / proposal
Date: 2026-06-11
Scope: Electrobun desktop (system WebView: WKWebView / WebView2 / WebKitGTK)

## Problem

Desktop playback is already an **MSE pipeline**: `MseVideoPlayer.web.tsx` drives a
`MediaSource` / `SourceBuffer` and uses **mediabunny** to remux MKV/MP4 into
fragmented MP4 (`moof`/`mdat` pairs, absolute `tfdt` timestamps) entirely in JS,
stream-copying packets — no transcode. This works whenever the webview can
natively decode the contained codecs.

PearTube is P2P with arbitrary uploads, so we hit codecs the webview can't decode.
The gap has two halves:

1. **Audio-only gap** — video codec is supported (H.264/HEVC) but the audio track
   isn't (AC-3, E-AC-3, DTS, Opus, Vorbis, TrueHD, …). This is the **common** case
   for "won't play" MKVs.
2. **Video gap** — the video codec itself is unsupported (VP8/VP9/AV1, or H.264 on a
   WebKitGTK build without licensed decoders). Audio transcode does not help here.

This doc covers (1): a cheap, real-time **audio→AAC transcode with video
stream-copy**, delivered as fMP4 fragments into the existing SourceBuffer. (2) is
tracked separately (see "Out of scope" below).

## Why this shape

- **Cheap.** Audio→AAC is real-time on any CPU; video is stream-copied (zero
  re-encode, zero quality loss). Crucially it needs **no H.264 encoder**, which
  matters because the `bare-ffmpeg` fork builds with `BARE_FFMPEG_ENABLE_GPL=OFF`
  (no libx264) and has no software H.264 encoder.
- **Reuses existing infra.** `cast-transcoder.mjs` already does
  "video-copy + audio-to-AAC" and already muxes **fragmented MP4** with
  `frag_keyframe+empty_moov+default_base_moof` (the `FMP4Segmenter` path). We feed
  the same fragments to MSE instead of (or in addition to) Chromecast.
- **Stays on MSE → portable.** Native HLS (`.m3u8`) playback is a WKWebView-only
  trick; WebView2 and WebKitGTK don't do it reliably. MSE works across all three
  webviews, so we keep one playback path. HLS stays Chromecast-only.

## Capability gate: let the renderer decide

Do **not** hardcode a per-webview codec matrix. The renderer knows its own
capabilities. Drive the decision with `MediaSource.isTypeSupported()`:

```ts
// in MseVideoPlayer.web.tsx, after probe returns codec strings
const videoOk = MediaSource.isTypeSupported(`video/mp4; codecs="${videoCodecStr}"`)
const audioOk = MediaSource.isTypeSupported(`video/mp4; codecs="${audioCodecStr}"`)
```

Routing:

| videoOk | audioOk | path |
|---------|---------|------|
| yes | yes | mediabunny stream-copy (today, unchanged) |
| yes | no  | **bare-ffmpeg audio→AAC, copy video, fMP4 → same SourceBuffer** |
| no  | *   | out of scope here (full transcode or "unsupported") |

This automatically handles the WebKitGTK-no-H.264 case without a lookup table.

The codec strings come from probe: `transcoder.probeMedia()` /
`probeWithBareFFmpeg()` already returns `videoCodec`, `audioCodec`, profile/level,
width/height. We need to map those to RFC 6381 codec strings
(`avc1.<profile><level>`, `mp4a.40.2`, etc.) — a small helper, partly derivable
from the profile/level probe already exposes.

## Byte-source contract

`MseVideoPlayer` currently consumes mediabunny output as: one **init segment**
(`ftyp`+`moov`) followed by **media fragments** (`moof`+`mdat`) carrying absolute
timestamps. The transcoding source must mirror this contract so the player's
append loop, sliding-window buffering (~60s ahead / ~30s behind), and seek logic
are reused unchanged.

Proposed interface (a drop-in alternative to the mediabunny pipeline):

```ts
interface FragmentSource {
  init(): Promise<Uint8Array>            // ftyp+moov init segment
  fragments(startTime: number):          // async iterator of fMP4 fragments
    AsyncIterable<{ time: number; data: Uint8Array }>
  seekTo(time: number): void             // restart fragment production at keyframe <= time
  destroy(): void
}
```

- mediabunny path: existing implementation, refactored behind this interface.
- transcode path: backend produces the fragments via bare-ffmpeg and streams them
  to the renderer over the existing HRPC/IPC channel (binary relay already exists
  in the Electrobun bridge).

## Backend side

Reuse `cast-transcoder.mjs`'s `runVideoCopyAudioTranscode` (video stream-copy +
audio→AAC) with the fMP4 muxer settings it already uses
(`frag_keyframe+empty_moov+default_base_moof` via `FMP4Segmenter`). Two deltas:

1. **Don't go through the HTTP/HLS server for desktop.** Emit the init segment and
   each `moof`/`mdat` fragment as discrete buffers pushed over IPC, rather than
   writing `.m4s` files + playlist. (Chromecast keeps the HTTP server; desktop
   doesn't need it.)
2. **Absolute timestamps.** Ensure fragment `tfdt` carries absolute media time so
   the player needs no `timestampOffset` bookkeeping (matches mediabunny today).

Note: the standalone `transcodeAudioWithBareFFmpeg` in `transcoder.mjs` writes
**plain** `'mp4'` (progressive), which is **not** appendable to a SourceBuffer.
Use the cast-transcoder fragmented path, not that one.

## Renderer / wiring

- `MseVideoPlayer.web.tsx`: after probe + `isTypeSupported`, pick the
  `FragmentSource` implementation. The SourceBuffer codec string for `addSourceBuffer`
  becomes `video/mp4; codecs="<copied-video>, mp4a.40.2"`.
- Desktop worker RPC: extend the playback prep path (`onWebPreparePlayback` /
  `preparePlayback`) to optionally start a transcode session and return a handle the
  renderer can pull fragments from, instead of only returning a blob-server URL.
- **Seek:** on seek, the player already cancels the active pipeline and clears the
  SourceBuffer; the transcode source must support `seekTo()` by restarting the
  bare-ffmpeg read/transcode from the keyframe at/just before the target (the input
  IOContext supports `onseek`).

## Out of scope (tracked separately)

**Unsupported video codec** (VP9/AV1/VP8, or H.264 missing in WebKitGTK). Audio
transcode cannot fix this; options:

- Full transcode to H.264. On macOS this can use `h264_videotoolbox` (HW). On
  Windows/Linux there is **no HW H.264 encoder and no libx264** in the current
  build, so this requires either enabling `BARE_FFMPEG_ENABLE_GPL`/x264 for those
  platforms or surfacing "unsupported codec".
- Decision deferred; desktop uploads hitting this are rarer than the audio gap.

## Open questions

- Codec-string mapping coverage: confirm probe exposes enough (profile/level) for
  all common HEVC/H.264 variants, or extend `probeWithBareFFmpeg`.
- IPC throughput for pushing fragment buffers vs. a localhost socket the WKWebView
  fetches from — measure before committing to the transport.
- Whether to keep mediabunny for the supported-codec path or unify everything
  through the backend fragment source (simpler renderer, but moves remux off the
  GPU-free JS path onto the worker).

## Summary

Keep MSE. Add a bare-ffmpeg **audio-only → AAC, video stream-copy, fMP4-fragment**
`FragmentSource`, selected by `MediaSource.isTypeSupported`, reusing the
cast-transcoder fragmented muxer and the player's existing append/seek/buffer
logic. Handle unsupported *video* codecs as a separate effort.
