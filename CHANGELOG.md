# Changelog

## Unreleased

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
