# Changelog

## Unreleased

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
