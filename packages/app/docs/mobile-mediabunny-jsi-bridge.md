# Mobile Mediabunny JSI Bridge Spike

PearTube already uses Mediabunny on desktop/Electrobun for MKV → fragmented MP4 remuxing into MSE. The mobile path should reuse Mediabunny as the container/conversion/HLS layer, while native platform APIs do the codec-heavy work.

This plan follows the Software Mansion React Native Best Practices JSI skill, especially the JSI guidance around `HostObject`, `HostFunction`, `NativeState`, zero-copy `ArrayBuffer`, `jsi::MutableBuffer`, `CallInvoker`, threading safety, and explicit C++ memory ownership.

## Goal

Build a small mobile-native media bridge that can eventually register Mediabunny custom coders without pulling more FFmpeg surface into the React Native runtime.

```text
Mediabunny Conversion / HLS output
  → CustomVideoEncoder / CustomAudioEncoder
  → JSI HostObject / HostFunction facade
  → Android MediaCodec / iOS VideoToolbox + AVFoundation
  → EncodedPacket data returned through zero-copy ArrayBuffer where possible
  → Mediabunny writes fragmented MP4 or HLS
```

## Non-goals for the first PR

- No replacement of the production playback path.
- No deletion of `bare-ffmpeg` yet.
- No raw 1080p frame transfer over the legacy React Native bridge.
- No MediaSource/WebView assumptions on mobile.
- No broad decode → filter → encode pipeline until the encoder-only path works.

## Phase 1 — Capability probe

Add a native capability probe exposed to JS:

```ts
NativeMediaCodecProbe.getCapabilities(): Promise<{
  platform: 'android' | 'ios'
  video: { encoders: string[]; decoders: string[] }
  audio: { encoders: string[]; decoders: string[] }
}>
```

Android implementation should query `MediaCodecList` and map MIME types to Mediabunny codec IDs:

- `video/avc` → `avc`
- `video/hevc` → `hevc`
- `video/x-vnd.on2.vp8` → `vp8`
- `video/x-vnd.on2.vp9` → `vp9`
- `video/av01` → `av1`
- `audio/mp4a-latm` → `aac`
- `audio/mpeg` → `mp3`
- `audio/opus` → `opus`

 iOS should start conservative:

- H.264 encode/decode through VideoToolbox / AVFoundation.
- HEVC only when hardware support is positively detected.
- AAC through AVFoundation.

## Phase 2 — Mediabunny custom coder stubs

Register stubs from JS after the capability probe:

```ts
registerEncoder(NativeAvcEncoder)
registerEncoder(NativeAacEncoder)
```

The stubs should implement `supports(codec, config)` based on capabilities and should expose lifecycle methods, but `encode()` can throw until native encode is implemented. This proves Mediabunny can load and register custom coders under Hermes/RN before we write platform codec code.

## Phase 3 — Native AVC/AAC encode spike

Implement the smallest real encode path:

- Android: `MediaCodec` H.264 encoder, then AAC.
- iOS: VideoToolbox H.264 encoder and AVFoundation/AudioConverter AAC.
- Input can be synthetic low-resolution frames first.
- Output should be encoded packet batches, not one callback per packet.

JSI performance rules:

- Batch packet metadata and buffers where possible.
- Return encoded payloads as zero-copy `ArrayBuffer` via `jsi::MutableBuffer` or another explicitly-owned native buffer wrapper.
- Use `setExternalMemoryPressure` for large native-owned buffers attached to JS objects.
- Keep native codec resources in `NativeState` or RAII-managed C++ classes so teardown is deterministic.
- Use `CallInvoker` to resolve/reject JS promises or call JS callbacks from codec worker threads; do not touch `jsi::Runtime` directly off-thread.

## Phase 4 — Mediabunny HLS packaging

Once native AVC/AAC packets exist, Mediabunny should own the container output:

```text
Native encoder packet batches
  → Mediabunny EncodedPacket / custom coder callback
  → HlsOutputFormat or fragmented Mp4OutputFormat
  → app cache / Hyperdrive upload staging
```

The first useful output target is mobile upload preprocessing, not live playback:

```text
picked video
  → optional native compress/transcode to H.264/AAC
  → Mediabunny package to HLS or fragmented MP4
  → existing PearTube upload/storage path
```

## Phase 5 — Decode path only after encoder path works

Full decode → process → encode is harder because raw frames are large. Do not attempt it until the encoder-only path and HLS packaging are stable.

If/when decoding lands:

- Prefer native surfaces / pixel buffers over JS-visible RGBA copies.
- Avoid per-frame JS calls.
- Keep frame lifetimes explicit and close samples promptly.
- Test timestamp accuracy before testing visual quality.

## PR boundaries

1. Capability probe + JS normalization helpers + tests.
2. Mediabunny custom coder registration stubs + tests.
3. Native AVC encode spike using synthetic frames.
4. AAC encode spike.
5. Mediabunny HLS package output.
6. Integrate into mobile upload preprocessing behind a feature flag.

## Why this matters

This lets PearTube move toward:

```text
Desktop/Electrobun: Mediabunny + WebCodecs
Mobile: Mediabunny + native codec bridge
Backend/Bare: P2P, storage, indexing, blob serving
```

That keeps heavy media processing close to the client platform that has hardware codecs and keeps the Bare backend from becoming the permanent transcoding engine.
