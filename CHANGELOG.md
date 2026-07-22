# Changelog

## Unreleased

## v0.2.37 - Wednesday, July 22, 2026

- Stop a single unhandled promise rejection (or thrown error) in the Electrobun desktop backend worker from aborting the whole worker: on the Bare runtime the default handler calls `abort()` (SIGABRT), taking the app's backend down. The desktop worker now installs `Bare.on('unhandledRejection'|'uncaughtException')` guards that log the reason and suppress the fatal default — parity with the mobile backend, which already did this. Expected P2P blob-range cancellations stay silently consumed.
- Fix desktop playback of MKV and other containers the webview's native `<video>` can't demux: `PearInlineVideoView` now forwards the nested `MediaError` code (`error.error.code`, where browsers put `MEDIA_ERR_SRC_NOT_SUPPORTED`/code 4) rather than only the (usually empty) top-level code, so the desktop watch page reliably switches from the native element to the MSE backend that remuxes into fMP4 on demand via mediabunny (with a bare-ffmpeg audio-transcode fallback). The fallback previously never triggered, so these sources failed to a black frame; note that video codecs the webview itself cannot decode (e.g. HEVC) can still fail since the compat path only stream-copies video.

## v0.2.36 - Wednesday, July 22, 2026

- Sign the `channel/root` descriptor for relay grouped per-title archive channels (TMDB shows/movies), vouched by the relay identity's device attestation. These channels are created directly (not through identity creation) and previously had no signed descriptor, so remote strict feed peers rejected them with `missing-signed-descriptor` — TMDB-catalog uploads appeared only in the relay's own local feed, never on the public feed for app peers, while plain uploads (shared identity channel) worked. Descriptors are also (idempotently) ensured on the startup archive republish path so previously uploaded shows/movies become visible.
- Cap the relay's autonomous blind-peer mirror storage (enable the blind-peer GC with a `maxBytes` bound, default = `storage.maxBytes`, override via `network.blindPeerMaxBytes` / `PEARTUBE_RELAY_BLIND_PEER_MAX_BYTES`). Relay-owned/seeded content is announced and exempt from GC, so only untrusted peer-protocol mirror bytes are reclaimed. Blind-peer stats now report `maxBytes`/`gcEnabled`/`bytesAllocated`.
- Add a storage-threshold ingestion guard so the relay stops growing instead of crashing with ENOSPC. Discovery-cache mirroring is refused once actual storage-dir usage (measured by block allocation) reaches `storage.maxBytes` or free disk drops below `storage.minFreeBytes` (new; default 2 GiB, override via `--min-free-bytes` / `PEARTUBE_STORAGE_MIN_FREE_BYTES`). Deliberate archive uploads/imports (incl. web-console uploads) are only refused on the hard free-disk floor, never merely because the evictable discovery cache filled the logical budget — so cache growth can't starve the relay's actual purpose.

## v0.2.35 - Tuesday, July 21, 2026

- Return relay startup promptly by seeding the cached/discovered channel backlog in the background instead of awaiting it, so the archive publisher binds within seconds and web-console uploads no longer hang in "running" while a large cache re-seeds on boot.
- Add a periodic relay storage-eviction loop: when the tracked discovery cache exceeds the storage budget, clear the lowest-retention discovery blob ranges first (real Hypercore clear + corestore compaction), protecting pinned channels and private/allowlist (deliberate uploads); evicted channels stop being advertised. Byte accounting only counts a channel freed after every clearable range is actually cleared.
- Log per-stage archive job progress (running/ensuring-channel/channel-ready/imported/publishing/published) so a stalled upload identifies the exact stage.

## v0.2.34 - Tuesday, July 21, 2026

- Wait for the relay runtime to finish starting before running an archive upload submitted through the web console, instead of failing it with "relay runtime is still starting" and deleting the uploaded file — early TMDB-catalog uploads now import and publish once the runtime is ready.

## v0.2.33 - Tuesday, July 21, 2026

- Repair completed relay archive projections on startup so previously uploaded shows and movies reappear in public channel catalogs.
- Keep archive jobs marked unpublished out of relay feed and catalog republishing.
- Carry movie/TV classification (contentKind, season/episode, media provider/id) through public-feed preview videos so relay-uploaded shows and movies appear under the Movies/Shows home filters instead of only under All.
- Preserve the relay's explicit playable previews when publishing a freshly archived channel whose public bee has not finished projecting, so newly uploaded shows/movies appear immediately instead of shipping a zero-video feed entry until the next relay restart.
- Clear stale hidden-channel markers when a relay archive channel is (re)published, so a channel hidden once (e.g. while it held an unpublished archive) no longer stays permanently invisible after its videos are published.

## v0.1.115 - Wednesday, May 20, 2026

- Improve peer discovery and public-feed gossip so newly discovered peers are promoted sooner.
- Fix native Android discovery diagnostics and related app regressions.
- Refresh public-feed gossip after mobile and desktop video uploads so peers discover newly added videos.
