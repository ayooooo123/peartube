# Retire libmpv across all platforms (bare-mpv → OS-native players)

Status: design / proposal
Date: 2026-06-11
Related: `2026-04-05-replace-mpv-with-html5-video.md` (Electrobun half — extended/superseded here),
`2026-06-11-desktop-mse-audio-transcode-fallback.md` (web compat layer)

## Goal

Remove `bare-mpv` (and the iOS MPVKit/libmpv integration) entirely, so every
platform plays through its **OS-native player** with hardware decode and ships
**zero codec blob**. Codecs the OS player can't handle are covered by a single
shared **bare-ffmpeg compatibility layer** (remux / audio-transcode → local
serving). End state: **one FFmpeg in the whole product** (`bare-ffmpeg`, for
transcode + thumbnails), no libmpv anywhere, `bare-media` already gone.

`bare-mpv` statically links libmpv **and a full FFmpeg** into each prebuild, so it
is the single largest codec blob; it lives in iOS, the Electrobun desktop, and the
experimental desktop-native app.

## Per-platform status (what's actually there today)

| Platform | Player today | mpv role today | Work to retire mpv |
|---|---|---|---|
| **Android** | expo-video (ExoPlayer) | none | **none** — ExoPlayer is codec-complete (MKV/Opus/VP9/FLAC) |
| **iOS** | expo-video (AVPlayer), via `PearInlineVideoView.tsx` | **dead code** — native mpv module is compiled but never referenced from JS/TS | delete dead Swift/ObjC + MPVKit pod; optionally add compat serving for AVPlayer-incompatible codecs |
| **Electrobun desktop** | MSE + mediabunny (`MseVideoPlayer.web.tsx`); `MpvPlayer.web.tsx` canvas path still present | fallback/secondary | remove `MpvPlayer.web.tsx` path (the 2026-04-05 plan) + add MSE audio-transcode fallback (already designed) |
| **desktop-native (macOS, experimental)** | AVPlayer is the **default**; mpv chosen only when `prefersNativeMpvPlayback` | codec-coverage + a half-wired "ffmpeg decode" stub | make AVPlayer the only path, backed by compat serving; delete mpv RPC/frame-server |

Key realization: **this is mostly deleting dead/secondary mpv paths, not risky
player swaps.** Android is done; iOS mpv is unused; desktop-native already has a
real AVPlayer path. The only genuinely *new* engineering is the shared compat
layer that lets AVPlayer handle the codecs mpv used to cover.

## The one shared piece of new work: local bare-ffmpeg compatibility serving

Today `api.preparePlayback` / `getVideoUrl` always returns a **direct blob-server
URL** (`http://127.0.0.1:<port>/blobs/...`), and HLS exists only for Chromecast
(`cast-transcoder.mjs`, bound `0.0.0.0`). To let the OS players cover everything
without mpv, insert a probe-driven decision at that single backend point:

```
preparePlayback(video):
  probe(source)                       # probeWithBareFFmpeg — already exists
  if osPlayerCanHandle(container, videoCodec, audioCodec):
      return directBlobUrl            # today's behavior (the ~90% MP4/H.264/AAC case)
  else:
      session = startCompatTranscode(source)   # bare-ffmpeg, video-copy where possible
      return localHlsUrl(session)     # 127.0.0.1, AVPlayer-friendly
```

- **bare-ffmpeg** does the work (it already has AC-3/E-AC-3/DTS/Vorbis decoders +
  AAC encoder + MKV demux + the fMP4/HLS muxers in `cast-transcoder.mjs`). Reuse
  `runVideoCopyAudioTranscode` (video stream-copy + audio→AAC) for the common
  audio-gap case; full transcode only when the *video* codec is unsupported.
- **Serving transport per player:**
  - **AVPlayer** (iOS + desktop-native): **local HLS** (`.m3u8` + fMP4/MPEGTS) on
    `127.0.0.1`. AVPlayer plays local HLS natively; ATS already permits the
    loopback HTTP the blob server uses today.
  - **WKWebView** (Electrobun): **fMP4 fragments → MSE** (the `FragmentSource` in
    the MSE-fallback doc). Native HLS isn't portable across webviews, so MSE.
  - **Android**: not needed — ExoPlayer handles these directly.
- **`osPlayerCanHandle`** is a per-platform capability predicate (the backend knows
  the requesting platform). On the webview, the renderer refines it with
  `MediaSource.isTypeSupported`.

This is the mobile/native analog of the Electrobun MSE fallback — same engine, same
muxers, just also exposed as a loopback HLS endpoint. Build it once, three players
benefit.

## Work breakdown

### Phase 0 — shared compat layer (enables everything else)
1. Add a **local-bound HLS endpoint** to the transcoder serving (reuse
   `cast-transcoder.mjs` muxing; bind `127.0.0.1`, not `0.0.0.0`).
2. Add `osPlayerCanHandle(platform, probe)` + wire the probe-driven branch into
   `api.preparePlayback` / `getVideoUrl` (`api.js`, `blob-playback-service.js`).
3. Reuse `probeWithBareFFmpeg` and `runVideoCopyAudioTranscode`.

**Progress (2026-06-11):**
- ✅ `playback-compat.mjs` — pure per-player capability policy
  (`avplayer`/`exoplayer`/`webkit`/`chromecast`) + `decidePlayback` /
  `osPlayerCanHandle`, faithful to the existing Chromecast/web checks. Unit-tested
  (`test/playback-compat.test.mjs`, 22 cases).
- ✅ `cast-transcoder.startCompatTranscode(sourceUrl, { player })` — generalizes
  the dormant `startWebTranscode` to any player via the policy, reusing the proven
  full/audio-only/remux dispatch. `startWebTranscode` now delegates (player:
  `webkit`). Output is fMP4 HLS via the cast file server.
- ✅ Local reachability: the cast file server binds `0.0.0.0` and
  `getCastHlsUrl(sessionId, '127.0.0.1')` already returns a loopback URL — usable
  by local AVPlayer, not just Chromecast. (A dedicated `127.0.0.1`-only bind can
  be tightened later.)
- ✅ `playback-compat-runtime.resolveCompatPlaybackUrl()` — best-effort runtime
  orchestration (probe/decide happens inside `startCompatTranscode`; this waits for
  the first fragment then returns the local HLS URL, falling back to the direct URL
  on ANY error). Unit-tested with a mock transcoder (`test/playback-compat-runtime.test.mjs`).
- ✅ Wired into the shared `mobile-handlers.js` `B.preparePlayback`, **gated** on the
  backend passing `castTranscoder` + `player` in deps — a strict no-op otherwise, so
  mobile/desktop behavior is unchanged.
- ✅ Activated (behind a flag) in the desktop-native sidecar: with
  `PEARTUBE_AVPLAYER_COMPAT=1` the sidecar injects a lazy cast-transcoder +
  `player: 'avplayer'`, so AVPlayer-incompatible codecs route through local-HLS
  transcode. Off by default.
- ⏭ **Remaining (needs a device):** flip the flag and validate AVPlayer plays the
  local-HLS output for MKV/Opus/AC-3/DTS on macOS; then **Phase 3** — drop
  `prefersNativeMpvPlayback` so the Swift app always uses AVPlayer (no longer mpv)
  for those, completing the desktop-native retirement. Mobile (iOS `avplayer` vs
  Android `exoplayer`) needs the per-OS player id threaded to the worklet at launch
  (`rpc.native` → worklet args → `attachMobileHandlers` deps) before enabling there.

### Phase 1 — iOS (delete dead mpv)
4. Remove `MpvPlayerCore.swift`, `MpvPlayerView.swift`, `MpvPlayerViewManager.swift`,
   `MpvPlayerManager.m`, `MpvHttpStreamBridge.swift`, `MpvPipController.swift` and
   their Xcode `project.pbxproj` refs.
5. Remove the **MPVKit** pod/dependency.
6. Confirm PiP + background audio are provided by expo-video (they are features of
   AVPlayer); set expo-video PiP options. *(Verify expo-video version supports PiP.)*
7. (Optional) route AVPlayer-incompatible codecs through Phase-0 compat serving —
   strictly an improvement over today, where such files likely fail on iOS.

### Phase 2 — Electrobun desktop (execute 2026-04-05, regression-free)
8. Implement the MSE audio-transcode `FragmentSource` (see MSE-fallback doc).
9. Remove `MpvPlayer.web.tsx` and its render sites in `VideoPlayerOverlayImpl.tsx` /
   `index.web.tsx`; route everything through `MseVideoPlayer.web.tsx`.
10. Remove the mpv handlers wired for the desktop worker.

### Phase 3 — desktop-native (make AVPlayer the only path)
11. Make `startPlaybackSession` always return `.avPlayer`; route incompatible
    codecs to the Phase-0 local-HLS URL instead of mpv.
12. Delete the mpv branch, the **RGBA-frame server + 30fps polling renderer**
    (`MpvPlayerView.swift` frame polling), `mpvRenderFrame`, and the
    `prefersNativeMpvPlayback` / `prefersFFmpegDecode` / `forceAVPlayerFallback`
    machinery. (This also removes the inefficient frame-streaming hack.)

### Phase 4 — delete bare-mpv
13. Remove the `mpv*` HRPC methods + message types from `spec/schema.cjs`,
    regenerate JS + Swift schema.
14. Delete the mpv RPC handlers in `native-host-sidecar.mjs` /
    `native-host-worklet-push.mjs`.
15. Delete `packages/bare-mpv` submodule + `.gitmodules` entry, the committed
    `prebuilds/`, `.github/workflows/bare-mpv-prebuilds.yml`,
    `ensure-bare-mpv-prebuilds.mjs`, and the `packages/bare-mpv` candidate in
    `sidecar-addon-roots.mjs` / worklet bundle watcher.

## Risks / feature preservation

- **PiP** — iOS: expo-video supports AVPlayer PiP; desktop-native: AVKit supports
  PiP. The bespoke `MpvPipController` is removed; confirm expo-video PiP config
  matches the current UX (skip ±, play/pause, auto-restore).
- **Subtitles** — mpv renders embedded **ASS/SSA** with styling; AVPlayer/expo-video
  do VTT/SRT + CEA-608/timed-text, not ASS styling. Potential regression for
  ASS-subbed content. (No subtitle wiring found today, so likely already absent —
  confirm before deleting.)
- **Codec breadth on iOS today** — AVPlayer can't demux MKV / decode Opus/AC-3/DTS.
  Without Phase 0, those already fail on iOS (HLS is Chromecast-only). Phase 0 is
  what closes that gap; sequence it first if iOS MKV/Opus playback matters.
- **desktop-native is experimental** — lowest priority; Phases 0–2 deliver the main
  wins (iOS + Electrobun + the blob deletion is gated on Phase 3/4).
- **Seeking** — AVPlayer seeks local HLS fine; ensure the compat session supports
  seek (restart transcode at keyframe via the input IOContext `onseek`).

## Sequencing

Phase 0 first (unblocks codec coverage everywhere). Then Phase 1 (cheap, pure
deletion) and Phase 2 (the designed MSE work) in parallel. Phase 3 once AVPlayer
compat is validated on macOS. Phase 4 (delete bare-mpv) only after no consumer
remains — that's the commit that removes the last libmpv/embedded-FFmpeg blob.

## End state

OS-native player on every platform (ExoPlayer / AVPlayer / WKWebView), one shared
bare-ffmpeg compat layer for the long tail of codecs, **one FFmpeg total**, no
libmpv, no bare-media. Simplest configuration that still maintains full codec
support — achieved by deleting blobs, not adding them.
