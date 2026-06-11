# PearTube Livestreaming + Keyframe-Indexed VOD Design

Date: 2026-06-11
Status: Proposed
Owner: Claude + user

## Goal

Add livestreaming to PearTube using only the primitives we already run — hypercore,
hyperswarm, the public feed gossip, and the local HTTP playback path — while borrowing
the parts of Media-over-QUIC's design that made it solve the livestreaming trilemma
(latency vs. scale vs. simplicity):

- **group = join point**: every addressable media unit starts at a keyframe, so joining
  a stream or seeking never fetches undecodable bytes
- **join at the live edge**: new subscribers start at the latest group, not the head
- **stale media is dropped, not delivered late**: lagging viewers skip forward instead
  of draining a backlog

As a companion, define a shared keyframe-index format for VOD so that uploads and
sealed live recordings both get keyframe-snapped seeks and faster cold starts —
**without requiring transcoding on upload**.

Explicitly *not* adopted: the MoQT protocol itself, QUIC/WebTransport transports, or
anything that requires relays to be publicly dialable servers. Hyperswarm hole punching
remains the only connectivity model.

## Hard Constraints

- No new network transport. Live distribution rides hypercore replication over
  hyperswarm, same as VOD blobs. No open ports, no TLS certificates, no DNS.
- VOD uploads must never *require* transcoding. Keyframe indexing is a header-parse;
  remuxing (stream copy) is an optional policy; re-encoding is reserved for
  pathological sources and is out of scope for v1.
- The live core is a **raw single-writer hypercore** owned by the broadcasting device,
  not a hyperblobs blob. Hyperblobs chunks writes into fixed-size blocks with no media
  awareness; live needs one variable-size block per media fragment.
- Players consume live streams through the existing local HTTP boundary
  (`http://127.0.0.1:<port>/...`), the same trust boundary as `blob-playback-service`.
- All schema and gossip changes are additive. Old clients must keep working and simply
  not see live entries.
- Viewers who watch a stream serve the blocks they hold to other viewers. Relay
  operators can admit live cores under the existing relay admission model
  (`2026-03-28-peartube-relay-design.md`); no new relay protocol.

## Problem Statement

PearTube today is pure VOD:

1. Upload streams raw file bytes into hyperblobs
   (`packages/backend/src/upload.js:226`) — fixed 64KB blocks, no media awareness.
   A seek lands mid-GOP and the player stalls while it hunts backward for a keyframe
   across P2P block fetches. MP4s with `moov` at the end are pathological for startup:
   the player can't parse anything until tail bytes arrive from the swarm.
2. There is no live path at all. The closest infrastructure is the Chromecast
   transcode pipeline, whose `FMP4Segmenter`
   (`packages/backend/src/transcode/fmp4-segmenter.mjs`) already splits a fragmented
   MP4 byte stream at `moof` boundaries with PTS-accurate durations — exactly the
   shape live needs — but it is wired only to the cast flow.
3. The range prioritizer (`packages/backend/src/blob-range-priority.js`) is
   position-based (playhead window + backfill) with no notion of keyframes or
   deadlines.

## Decision Summary

Three coordinated pieces, shipped in phases:

1. **Live core**: a single-writer hypercore where block 0 is a stream descriptor,
   block 1 is the fMP4 init segment, and every subsequent block is exactly one
   keyframe-aligned fMP4 fragment (`moof`+`mdat`). The hypercore block index *is* the
   MoQ group ID.
2. **Local HLS bridge for playback**: viewers replicate the live core sparsely and a
   small local service renders it as a standard live HLS playlist (each block = one
   `.m4s` segment). Every player we ship (mpv, AVPlayer, ExoPlayer) natively consumes
   live HLS; we get the live edge, sliding window, and DVR semantics for free.
3. **Shared keyframe index (`KeyframeIndexV1`)**: stored in channel HyperDB alongside
   video metadata. Sealed live recordings get it for free (every media block starts at
   a keyframe); uploads get it from a demux-only probe at upload time. The blob range
   prioritizer uses it to snap seeks and cold starts to decodable offsets.

## Non-Goals

- MoQT, QUIC, WebTransport, or browser playback. No publicly dialable relay servers.
- Adaptive bitrate / multi-rendition ladders. One encode per stream in v1.
- Sub-second WebRTC-class latency. Target is 3–6s glass-to-glass (LL-HLS territory),
  tunable via fragment duration.
- Live chat, reactions, moderation, monetization.
- Multi-device co-broadcasting into one stream (the live core is single-writer; a
  channel can host streams from different devices as separate cores).
- Re-encoding uploads. Tier 2 (transcode) is acknowledged but deferred.

## Live Core Layout

One hypercore per stream, created by the broadcasting device, key advertised through
channel metadata and feed gossip.

```
block 0   StreamDescriptor (compact JSON): version, codec params (codec string,
          width/height, framerate, audio config), targetFragmentDurationMs,
          startedAt, channelKey, videoId
block 1   fMP4 init segment (ftyp + moov)
block 2+  one fragment per block: moof + mdat, ALWAYS starting at a video keyframe
block N   EndOfStream marker (empty mdat sentinel flagged in a trailing
          StreamDescriptor update — see Stream Lifecycle)
```

Mapping to MoQ vocabulary, for orientation:

| MoQ | PearTube live core |
|---|---|
| Track | The hypercore |
| Group (join point) | One block (block index = group ID) |
| Object | Same block (1 fragment = 1 group = 1 object in v1) |
| Subscribe | Sparse live replication of the core |
| Join at latest group | Start requesting at `core.length - k` |
| Delivery timeout / drop stale | Never request blocks behind the live window |
| Relay cache without payload access | Blind-peer / relay mirroring of the core |

Integrity is strictly better than MoQ's: every block is Merkle-verified against the
broadcaster-signed core, and the core key is itself referenced from signed channel
metadata. Relays and fellow viewers cannot tamper with or forge stream content.

### Fragment duration

Default **1s** target fragment duration (configurable 0.5–2s in broadcaster settings).
The encoder is configured with a forced-keyframe interval equal to the fragment
duration, so "fragment boundary = keyframe" holds by construction. Trade-off: shorter
fragments cut latency but increase per-block overhead and swarm request chatter; 1s
keeps blocks in the 100KB–1MB range for typical bitrates, comfortably inside
hypercore's sweet spot.

## Broadcaster Pipeline

Desktop first (bare-ffmpeg capture + encode already proven by the cast transcoder);
mobile capture is an open question tracked below.

```
capture (bare-ffmpeg avfoundation/screen/file)
  → encode (h264/aac; VideoToolbox on macOS per videotoolbox-settings.mjs,
            forced keyframe interval = fragment duration)
  → fMP4 mux (movflags: frag_keyframe + empty_moov + default_base_moof,
              bytes emitted via IOContext onwrite)
  → FMP4Segmenter (reused as-is: splits at moof, PTS-accurate durations)
  → LiveCoreWriter: core.append(initSegment) once, then core.append(fragment)
      per flushed segment, recording per-block duration
```

`FMP4Segmenter` needs no changes — its store interface (`writeInit`, `stageSegment`,
`finalizeSegment`, `registerSegmentMeta`) is implemented by a new `LiveCoreStore`
that appends to the hypercore instead of the cast `MemorySegmentStore`. The segmenter
moves (or is re-exported) from `transcode/` to a shared location since it is no longer
cast-specific.

Backpressure: appends are local disk writes and will not lag a realtime encode in
practice. If append latency ever exceeds one fragment duration, the broadcaster
service surfaces a health warning rather than buffering unboundedly.

### Stream Lifecycle

1. `start-livestream` → create live core, append descriptor + init segment, add a
   `live` video entry to channel HyperDB, announce via feed gossip, join the core's
   discovery topic as server.
2. While live: append fragments; `core.length` growth is the liveness heartbeat.
   Broadcaster republishes the feed entry if metadata changes (title, etc.).
3. `stop-livestream` → append end-of-stream marker, flip the channel HyperDB entry
   from `live` to `live-recording` (the seal step), re-gossip so feeds stop showing
   it as live.
4. Crash handling: if a viewer sees no new blocks for a stale window (default 30s)
   the UI shows "stream interrupted"; if the broadcaster restarts it starts a *new*
   core (single-writer cores are append-only; resuming a dead session is not
   attempted in v1). The orphaned entry is sealed lazily on next broadcaster startup.

### Seal-to-VOD (free DVR)

The live core **is** the recording. Sealing does not copy bytes into hyperblobs:

- the channel HyperDB video entry gains `kind: 'live-recording'`, `liveCoreKey`,
  `initBlock: 1`, `firstMediaBlock: 2`, `endBlock`, and a `KeyframeIndexV1`
- the keyframe index is exact and free: every media block starts at a keyframe and
  the broadcaster recorded per-block durations as it streamed
- playback of a sealed recording uses the same HLS-from-core path with a complete
  (non-sliding) playlist — which also means full DVR *during* the stream: any viewer
  can scrub back to block 2 because all blocks remain fetchable from the swarm

Regular uploaded VOD keeps the hyperblobs path unchanged.

## Viewer Pipeline

```
feed entry (isLive) → resolve liveCoreKey
  → join swarm on the core's discoveryKey (existing retainSwarmDiscovery path)
  → replicate sparse + live
  → read block 0 (descriptor) + block 1 (init segment)
  → start requesting at joinBlock = max(firstMediaBlock, core.length - k)   // k = 3
  → LivePlaybackService serves local live HLS:
       GET /live/<coreKey>/playlist.m3u8   (rendered from core state)
       GET /live/<coreKey>/init.mp4        (block 1)
       GET /live/<coreKey>/seg-<n>.m4s     (block n, awaited if not yet local)
  → player (mpv / AVPlayer / ExoPlayer) consumes the playlist as ordinary live HLS
```

Playlist rendering is trivial because segments are blocks: the manifest lists the
last `W` blocks (sliding window, default 120s worth) with `EXT-X-MEDIA-SEQUENCE` =
block index, durations from per-block metadata (broadcaster embeds them in a tiny
sidecar appended periodically, or the service parses `moof` `baseMediaDecodeTime`
deltas — v1 parses moof headers locally since blocks are already in memory when
serving). When the end-of-stream marker is observed, the playlist gains
`EXT-X-ENDLIST`.

**Stale-drop for free**: a viewer that falls behind the sliding window simply jumps
its request pointer forward; blocks it skipped are never requested. This is MoQ's
delivery-timeout behavior expressed as sparse replication — no partial-reliability
machinery, no protocol changes.

**Fan-out for free**: every viewer replicates the blocks it has to other viewers on
the same topic, and relays that admit the channel mirror the live core like any other
core. The broadcaster's uplink serves the first copy only.

Latency budget at 1s fragments: encode+segment ≈ 1s, append+replicate-to-peer ≈
0.1–0.5s, playlist holdback 3 segments ≈ 3s, player buffer ≈ 1s → **~4–5s typical**,
~3s at 0.5s fragments with holdback 2.

## Keyframe Index (shared VOD piece)

A single format used by sealed live recordings and probed uploads, stored in channel
HyperDB next to video metadata (NOT in the blob — must be readable before any media
bytes arrive):

```js
KeyframeIndexV1 = {
  version: 1,
  source: 'live' | 'probe',          // how it was produced
  // parallel arrays, delta-encodable, capped at 10k entries (sampled if more)
  timesMs:  [t0, t1, ...],           // presentation time of each keyframe
  offsets:  [o0, o1, ...]            // byte offset (uploads) or block index (live)
}
```

### Uploads — tier 0 (index only, default, no transcoding)

At upload time, run a **demux-only probe** with bare-ffmpeg: read container headers
and packet flags (MP4 `stss`/`trun` sample tables, MKV Cues) without decoding a
single frame. Emit `KeyframeIndexV1` with byte offsets into the blob, plus
`moovPosition: 'front' | 'back'` and GOP statistics. Cost: header I/O, milliseconds
to low seconds. Applies retroactively: any peer holding a blob can backfill an index.

Playback integration: `blob-range-priority.js` maps a seek byte target to the nearest
preceding keyframe offset, then to its 64KB block (`floor(offset / blockSize)`), and
prioritizes from there. Cold start prioritizes `moov` bytes explicitly when
`moovPosition: 'back'`.

### Uploads — tier 1 (faststart remux, opt-in policy)

When the probe reports `moovPosition: 'back'`, optionally remux with **stream copy**
(`-c copy`, faststart or fragmented output) before writing to hyperblobs. Container
rewrite only — lossless, I/O-bound, not a transcode. Recommended default-on for new
uploads once validated, since moov-at-end is the single worst startup offender.

### Tier 2 (re-encode) — deferred

Sources with pathological GOPs (keyframe interval > ~5s) seek poorly no matter how
good the index is. The probe flags them (`maxGopMs`); a future policy may offer
re-encode-on-upload. Out of scope for v1.

## Discovery / Feed Changes (additive)

Feed gossip messages are JSON (`HAVE_FEED` / `SUBMIT_CHANNEL` in
`packages/backend/src/public-feed.js`), so additive fields are wire-compatible.
`PublicFeedEntry` (`packages/backend/src/types.js`) gains:

```
isLive            bool     — channel currently has at least one live stream
liveStreams       array    — [{ videoId, liveCoreKey, title, startedAt }]
```

Old clients ignore the fields. The existing oversized-message guards in
`public-feed.js` apply; `liveStreams` is capped (e.g., 4 entries) like
`previewVideos`.

Channel HyperDB video entries gain `kind: 'video' | 'live' | 'live-recording'`
(absent = `'video'`), `liveCoreKey`, `initBlock`, `firstMediaBlock`, `endBlock`,
`keyframeIndex`.

## HRPC Surface (additive, `packages/spec/schema.cjs` conventions)

New structs + commands in the `@peartube` namespace:

```
start-livestream          req: { channelKey, title, description?, settings? }
                          res: { videoId, liveCoreKey }
stop-livestream           req: { videoId }
                          res: { success, recordingVideoId? }
get-livestream-status     req: { videoId }
                          res: { status: { state, durationMs, peerCount,
                                 bitrateBps, fragmentsAppended, health } }
prepare-live-playback     req: { liveCoreKey }            // mirrors prepare-playback
                          res: { url, isLive, joinBlock }
```

Event stream (send-only namespace, alongside existing event streams):

```
livestream-state-changed  { videoId, state: starting|live|stalled|ended|sealed }
```

Regenerate JS + Swift per the standard `schema.cjs` flow; nested response shapes
follow the existing "wrap, don't flatten" rule (see CLAUDE.md troubleshooting).

## Module Plan

```
packages/backend/src/live/
  live-core-writer.js        append pipeline; implements segmenter store interface
  live-broadcast-service.js  lifecycle: start/stop/seal, encoder supervision, stats
  live-playback-service.js   HLS-from-core local server (playlist + init + segments)
  live-feed.js               feed entry construction + gossip integration
packages/backend/src/media/  (or shared location)
  fmp4-segmenter.mjs         moved/re-exported from transcode/ (unchanged logic)
  keyframe-probe.js          demux-only probe → KeyframeIndexV1 + moovPosition
  remux.js                   tier-1 stream-copy remux (phase 2)
touched:
  upload.js                  probe step after MIME detection; index into metadata
  blob-range-priority.js     keyframe-snapped seek/start prioritization
  public-feed.js             additive live fields
  spec/schema.cjs            commands + structs above
  api.js / hrpc-handlers.js  handler wiring
```

## Phasing

1. **Phase 1 — VOD keyframe index (small, immediate win).** `keyframe-probe.js`,
   index in upload metadata, keyframe-snapped prioritization, explicit moov
   prioritization for back-moov files. No schema/gossip changes beyond the metadata
   field. Directly attacks the measured ~3.4s first-frame bottleneck and mid-GOP
   seek stalls.
2. **Phase 2 — faststart remux policy (small).** Tier-1 stream-copy remux for
   back-moov uploads, behind a setting; default-on after validation.
3. **Phase 3 — live MVP (the big one).** Desktop broadcaster (bare-ffmpeg capture →
   live core), viewer HLS bridge on all platforms, feed gossip + HRPC surface,
   live UI entry points. Mobile *viewing* ships here; mobile *broadcasting* depends
   on the capture question below.
4. **Phase 4 — seal-to-VOD + DVR polish + relay admission.** Sealed recordings as
   first-class channel videos, scrub-back-while-live UI, relay catalog awareness of
   live cores so relays boost fan-out for admitted channels.

## Open Questions Deferred

- **Mobile capture/encode path**: camera + hardware encoder access from the BareKit
  worklet (or native-side capture feeding the worklet) needs a spike before mobile
  broadcasting is committed.
- **Per-block duration sidecar vs. moof parsing** for playlist rendering: v1 parses
  moof locally; if that shows up in profiles, add a tiny duration sidecar appended
  every N fragments.
- **Live core retention on viewers**: hypercore `clear()` lets viewers/relays drop
  old live blocks outside the DVR window they care about; eviction policy lands with
  the relay work in phase 4.
- **Stale/interrupted stream UX thresholds** (30s default) need tuning with real
  network jitter.

## Decision

Build livestreaming as **keyframe-aligned fMP4 fragments in a single-writer
hypercore, consumed as locally rendered live HLS**, discovered through additive
public-feed gossip fields, with viewers and relays providing fan-out through ordinary
core replication. Ship the shared keyframe index for VOD first (probe-only, no
transcoding), since sealed live recordings and uploads converge on the same index
format and the same snapped-seek playback path.

This takes MoQ's load-bearing ideas — join points, live-edge joining, stale-drop —
while keeping the properties MoQ lacks and we already have: Merkle-verified content,
signed publisher identity, NAT-friendly volunteer relays, and zero public server
requirements.
